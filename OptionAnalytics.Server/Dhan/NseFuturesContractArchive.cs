using System.Collections.Concurrent;
using System.Globalization;
using System.IO.Compression;

namespace OptionAnalytics.Server.Dhan;

/// <summary>
/// The NSE index futures contracts that were listed on a PAST date - including ones that have since
/// expired, which Dhan's scrip master no longer has (it lists only live contracts), so a backtest or
/// replay of an older day could not otherwise find the front-month contract it actually traded.
///
/// Source: NSE's daily contract master, NSE_FO_contract_{ddMMyyyy}.csv.gz on nsearchives - every F&amp;O
/// contract listed that day, with its exchange token (FinInstrmId). For NSE derivatives Dhan's security
/// id IS that token (checked: BANKNIFTY Oct-2026 FUT is 48699 in both), so the contract it gives can be
/// passed straight to Dhan's historical candles. A holiday or weekend has no file, so the nearest
/// earlier one (up to a week back) is used - the contracts are the same.
///
/// NSE underlyings only (NIFTY, BANKNIFTY, ...); SENSEX trades on BSE. Files are fetched straight from
/// NSE and kept in memory only - never written to disk - for the rest of the IST day (including "no
/// file" answers, so a date is fetched at most once a day); everything is dropped when the day changes.
/// </summary>
public sealed class NseFuturesContractArchive
{
    public const string UrlFormat = "https://nsearchives.nseindia.com/content/fo/NSE_FO_contract_{0}.csv.gz";
    private const int MaxDaysBack = 7;
    // Each entry is only that day's index futures rows (a few dozen), so a long strategy-tuning range (250 weekdays)
    // fits; the least recently used goes first - evicting the OLDEST date threw away the file just downloaded in a
    // newest-first scan, so every older day re-downloaded NSE's contract master several times.
    private const int MaxCachedFiles = 400;
    // NSE's contract master counts time in seconds since 1980-01-01.
    private static readonly DateTime Epoch1980 = new(1980, 1, 1, 0, 0, 0, DateTimeKind.Utc);
    public static readonly string[] NseUnderlyings = { "NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "NIFTYNXT50" };

    private readonly HttpClient _http;
    private readonly ILogger<NseFuturesContractArchive> _logger;
    private readonly ConcurrentDictionary<DateOnly, Task<IReadOnlyList<DhanFuturesInstrument>?>> _files = new();
    private DateOnly _cacheDay = IstClock.Today();
    private readonly ConcurrentDictionary<DateOnly, long> _used = new();
    private long _clock;

    public NseFuturesContractArchive(HttpClient http, ILogger<NseFuturesContractArchive> logger)
    {
        _http = http;
        _logger = logger;
        if (_http.DefaultRequestHeaders.UserAgent.Count == 0)
            _http.DefaultRequestHeaders.UserAgent.ParseAdd("Mozilla/5.0 (X11; Linux x86_64) OptionAnalytics");
        _http.Timeout = TimeSpan.FromSeconds(30);
    }

    public static bool Covers(string underlying) => NseUnderlyings.Contains(underlying, StringComparer.OrdinalIgnoreCase);

    /// <summary>The underlying's futures contracts listed on <paramref name="date"/> that had not expired
    /// by then, nearest first. Empty when NSE has no contract file for that week (or it can't be reached).</summary>
    public async Task<IReadOnlyList<DhanFuturesInstrument>> ContractsOnAsync(string underlying, DateOnly date, CancellationToken cancellationToken)
    {
        if (!Covers(underlying)) return Array.Empty<DhanFuturesInstrument>();
        for (var back = 0; back <= MaxDaysBack; back++)
        {
            var file = await FileAsync(date.AddDays(-back), cancellationToken);
            if (file is null) continue;
            return file.Where(c => c.Underlying.Equals(underlying, StringComparison.OrdinalIgnoreCase) && c.Expiry >= date)
                .OrderBy(c => c.Expiry).ToList();
        }
        return Array.Empty<DhanFuturesInstrument>();
    }

    /// <summary>The contract for an expiry as listed on <paramref name="date"/> (null expiry = the front
    /// month that day).</summary>
    public async Task<DhanFuturesInstrument?> ContractOnAsync(string underlying, DateOnly date, DateOnly? expiry, CancellationToken cancellationToken)
    {
        var contracts = await ContractsOnAsync(underlying, date, cancellationToken);
        return expiry is { } e ? contracts.FirstOrDefault(c => c.Expiry == e) : contracts.FirstOrDefault();
    }

    private Task<IReadOnlyList<DhanFuturesInstrument>?> FileAsync(DateOnly day, CancellationToken cancellationToken)
    {
        if (day.DayOfWeek is DayOfWeek.Saturday or DayOfWeek.Sunday) return Task.FromResult<IReadOnlyList<DhanFuturesInstrument>?>(null);
        var today = IstClock.Today();
        if (today != _cacheDay) { _files.Clear(); _used.Clear(); _cacheDay = today; }
        var task = _files.GetOrAdd(day, d => DownloadAsync(d));
        _used[day] = Interlocked.Increment(ref _clock);
        // A failed download (network, a timeout - not a missing file) is not remembered - try again next time.
        _ = task.ContinueWith(t => { if (t.IsFaulted || t.IsCanceled) { _files.TryRemove(day, out _); _used.TryRemove(day, out _); } }, TaskScheduler.Default);
        while (_files.Count > MaxCachedFiles && _used.Count > 0)
        {
            var oldest = _used.MinBy(kv => kv.Value).Key;
            _files.TryRemove(oldest, out _);
            _used.TryRemove(oldest, out _);
        }
        return task.WaitAsync(cancellationToken);
    }

    private async Task<IReadOnlyList<DhanFuturesInstrument>?> DownloadAsync(DateOnly day)
    {
        var url = string.Format(CultureInfo.InvariantCulture, UrlFormat, day.ToString("ddMMyyyy", CultureInfo.InvariantCulture));
        HttpResponseMessage responseMessage;
        try
        {
            responseMessage = await _http.GetAsync(url, HttpCompletionOption.ResponseHeadersRead);
        }
        catch (TaskCanceledException ex)
        {
            // HttpClient's own timeout (no caller token here): a plain failure, so callers' "not a cancellation" catches
            // handle it (it used to escape them as an unhandled 500) and the cache forgets it.
            throw new TimeoutException($"NSE contract master {day:yyyy-MM-dd} did not answer within {_http.Timeout.TotalSeconds:0} s.", ex);
        }
        using var response = responseMessage;
        if (response.StatusCode is System.Net.HttpStatusCode.NotFound or System.Net.HttpStatusCode.Forbidden) return null;
        response.EnsureSuccessStatusCode();
        await using var stream = await response.Content.ReadAsStreamAsync();
        await using var gzip = new GZipStream(stream, CompressionMode.Decompress);
        using var reader = new StreamReader(gzip);
        var contracts = Parse(reader);
        _logger.LogInformation("NSE contract master {Day}: {Count} index futures contract(s).", day, contracts.Count);
        return contracts;
    }

    /// <summary>The index futures (FUTIDX) rows of an NSE F&amp;O contract master.</summary>
    internal static List<DhanFuturesInstrument> Parse(TextReader reader)
    {
        var result = new List<DhanFuturesInstrument>();
        var header = reader.ReadLine()?.Split(',');
        if (header is null) return result;
        int Col(string name) => Array.FindIndex(header, h => h.Trim().Equals(name, StringComparison.OrdinalIgnoreCase));
        int token = Col("FinInstrmId"), kind = Col("FinInstrmNm"), symbol = Col("TckrSymb"), expiry = Col("XpryDt"), lot = Col("MinLot"), tick = Col("BidIntrvl");
        if (token < 0 || kind < 0 || symbol < 0 || expiry < 0 || lot < 0) return result;

        string? line;
        while ((line = reader.ReadLine()) is not null)
        {
            // Cheap filter before splitting 100k option rows.
            if (!line.Contains(",FUTIDX,", StringComparison.Ordinal)) continue;
            var f = line.Split(',');
            if (f.Length <= Math.Max(Math.Max(token, kind), Math.Max(symbol, Math.Max(expiry, lot)))) continue;
            if (f[kind] != "FUTIDX") continue;
            var underlying = f[symbol].Trim().ToUpperInvariant();
            if (!Covers(underlying)) continue;
            if (!uint.TryParse(f[token], NumberStyles.Integer, CultureInfo.InvariantCulture, out var securityId)) continue;
            if (!long.TryParse(f[expiry], NumberStyles.Integer, CultureInfo.InvariantCulture, out var seconds)) continue;
            if (!int.TryParse(f[lot], NumberStyles.Integer, CultureInfo.InvariantCulture, out var lotSize) || lotSize <= 0) continue;
            var expiryDate = DateOnly.FromDateTime(Epoch1980.AddSeconds(seconds));
            // BidIntrvl is in paise, like Dhan's tick size.
            var tickSize = tick >= 0 && tick < f.Length && decimal.TryParse(f[tick], NumberStyles.Number, CultureInfo.InvariantCulture, out var paise) && paise > 0
                ? DhanSymbology.TickSizeFromScripMaster(paise)
                : 0.05m;
            var tradingSymbol = $"{underlying}-{expiryDate.ToString("MMMyyyy", CultureInfo.InvariantCulture)}-FUT";
            result.Add(new DhanFuturesInstrument(securityId, tradingSymbol, underlying, expiryDate, "NSE_FNO", lotSize, tickSize));
        }
        return result;
    }
}
