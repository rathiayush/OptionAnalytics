using System.Collections.Concurrent;
using System.Globalization;
using System.Net.Http.Json;
using System.Text.Json;
using OptionAnalytics.Server.Models;

namespace OptionAnalytics.Server.Dhan;

/// <summary>
/// A past day's 1-minute candles for an NSE index futures contract - an EXPIRED one included - from
/// NSE's own charting service (charting.nseindia.com, the chart on nseindia.com).
///
/// Dhan cannot serve these: its intraday history covers active contracts only ("Expired futures contracts
/// intraday data - not available via API", Dhan support), its intraday request has no expiryCode, and its
/// expired-contract API (rolling option) is options-only. NSE's chart service looks a contract up by its
/// exchange token, which for NSE derivatives is Dhan's security id (see NseFuturesContractArchive), plus
/// its NSE ticker (NIFTY26SEPFUT).
///
/// This is the endpoint NSE's own chart page calls - it is not a documented API, has no open interest,
/// and NSE blocks some hosting providers' addresses - so every failure is reported back as text (shown
/// in the replay's message and in /history-check) rather than thrown. Kept in memory only, for the rest
/// of the IST day (a day with no candles included, so a date is asked for at most once a day).
/// </summary>
public sealed class NseChartHistory
{
    public const string HistoryUrl = "https://charting.nseindia.com/v1/charts/symbolHistoricalData";
    private const string WarmUpUrl = "https://charting.nseindia.com/";
    private const int MaxCachedDays = 20;
    private static readonly TimeSpan Ist = TimeSpan.FromMinutes(330);
    private static readonly TimeSpan WarmUpEvery = TimeSpan.FromMinutes(10);

    private readonly HttpClient _http;
    private readonly ILogger<NseChartHistory> _logger;
    private readonly ConcurrentDictionary<(uint SecurityId, DateOnly Day), Task<Result>> _days = new();
    private DateOnly _cacheDay = IstClock.Today();
    private DateTimeOffset _warmedAt = DateTimeOffset.MinValue;

    public sealed record Result(IReadOnlyList<CandleWithVolume> Bars, string? Error);

    public NseChartHistory(HttpClient http, ILogger<NseChartHistory> logger)
    {
        _http = http;
        _logger = logger;
        if (_http.DefaultRequestHeaders.UserAgent.Count == 0)
            _http.DefaultRequestHeaders.UserAgent.ParseAdd("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36");
        if (!_http.DefaultRequestHeaders.Contains("Origin")) _http.DefaultRequestHeaders.Add("Origin", "https://charting.nseindia.com");
        _http.DefaultRequestHeaders.Referrer ??= new Uri("https://charting.nseindia.com/");
        _http.DefaultRequestHeaders.Accept.ParseAdd("application/json, text/plain, */*");
        _http.Timeout = TimeSpan.FromSeconds(20);
    }

    /// <summary>NSE's ticker for an index future: NIFTY26SEPFUT (underlying, 2-digit year, month).</summary>
    public static string Ticker(DhanFuturesInstrument contract) =>
        $"{contract.Underlying.ToUpperInvariant()}{contract.Expiry.ToString("yy", CultureInfo.InvariantCulture)}{contract.Expiry.ToString("MMM", CultureInfo.InvariantCulture).ToUpperInvariant()}FUT";

    public Task<Result> DayAsync(DhanFuturesInstrument contract, DateOnly date, CancellationToken cancellationToken)
    {
        if (!contract.DhanSegment.Equals("NSE_FNO", StringComparison.OrdinalIgnoreCase))
            return Task.FromResult(new Result(Array.Empty<CandleWithVolume>(), "NSE charts cover NSE contracts only"));
        var today = IstClock.Today();
        if (today != _cacheDay) { _days.Clear(); _cacheDay = today; }
        var key = (contract.SecurityId, date);
        var task = _days.GetOrAdd(key, _ => FetchAsync(contract, date));
        // A network failure is not remembered - asked again next time. "No candles" is.
        _ = task.ContinueWith(t => { if (t.IsFaulted || t.Result.Error is not null) _days.TryRemove(key, out _); }, TaskScheduler.Default);
        while (_days.Count > MaxCachedDays) _days.TryRemove(_days.Keys.MinBy(k => k.Day), out _);
        return task.WaitAsync(cancellationToken);
    }

    private async Task<Result> FetchAsync(DhanFuturesInstrument contract, DateOnly date)
    {
        var ticker = Ticker(contract);
        try
        {
            await WarmUpAsync();
            // The whole IST calendar day: covers the bars whether NSE stamps them in UTC or in IST wall-clock.
            var from = new DateTimeOffset(date.ToDateTime(TimeOnly.MinValue), Ist);
            var payload = new
            {
                token = contract.SecurityId.ToString(CultureInfo.InvariantCulture),
                fromDate = from.ToUnixTimeSeconds(),
                toDate = from.AddDays(1).ToUnixTimeSeconds(),
                symbol = ticker,
                symbolType = "Futures",
                chartType = "I",
                timeInterval = 1,
            };
            using var response = await _http.PostAsJsonAsync(HistoryUrl, payload);
            var body = await response.Content.ReadAsStringAsync();
            if (!response.IsSuccessStatusCode)
                return Fail(ticker, date, $"NSE chart data answered HTTP {(int)response.StatusCode}{(body.Contains("Access Denied", StringComparison.OrdinalIgnoreCase) ? " (Access Denied - NSE blocks this server's address)" : "")}");
            var bars = Parse(body, date);
            _logger.LogInformation("NSE chart data {Ticker} ({Token}) {Date}: {Count} one-minute bar(s).", ticker, contract.SecurityId, date, bars.Count);
            return new Result(bars, null);
        }
        catch (Exception e) when (e is HttpRequestException or TaskCanceledException or JsonException)
        {
            return Fail(ticker, date, $"NSE chart data could not be read: {e.Message}");
        }
    }

    private Result Fail(string ticker, DateOnly date, string error)
    {
        _logger.LogWarning("NSE chart data {Ticker} {Date}: {Error}", ticker, date, error);
        return new Result(Array.Empty<CandleWithVolume>(), error);
    }

    // NSE's chart page sets its cookies on first load; the data call is made the same way.
    private async Task WarmUpAsync()
    {
        if (DateTimeOffset.UtcNow - _warmedAt < WarmUpEvery) return;
        _warmedAt = DateTimeOffset.UtcNow;
        try { using var _ = await _http.GetAsync(WarmUpUrl); }
        catch (Exception e) when (e is HttpRequestException or TaskCanceledException) { /* the data call says what went wrong */ }
    }

    /// <summary>The bars of <paramref name="date"/> from NSE's chart reply: {"status":true,"data":[{"time":ms,
    /// "open","high","low","close","volume"}]}. NSE's chart stamps bars in IST wall-clock written as if UTC;
    /// a real UTC stamp is accepted too (the two never overlap during market hours).</summary>
    internal static List<CandleWithVolume> Parse(string body, DateOnly date)
    {
        var bars = new List<CandleWithVolume>();
        using var doc = JsonDocument.Parse(body);
        if (!doc.RootElement.TryGetProperty("data", out var data) || data.ValueKind != JsonValueKind.Array) return bars;
        foreach (var row in data.EnumerateArray())
        {
            if (row.ValueKind != JsonValueKind.Object) continue;
            if (!TryNumber(row, "time", out var ms) || !TryNumber(row, "open", out var o) || !TryNumber(row, "high", out var h)
                || !TryNumber(row, "low", out var l) || !TryNumber(row, "close", out var c)) continue;
            TryNumber(row, "volume", out var v);
            var stamp = DateTimeOffset.FromUnixTimeMilliseconds((long)ms);
            var minute = stamp.UtcDateTime.TimeOfDay;
            // IST wall-clock written as UTC: market hours read 09:15-15:30 "UTC" - shift to the real instant.
            var time = minute >= new TimeSpan(9, 0, 0) && minute <= new TimeSpan(15, 45, 0) ? stamp - Ist : stamp;
            var ist = time.ToOffset(Ist);
            if (DateOnly.FromDateTime(ist.DateTime) != date) continue;
            if (ist.TimeOfDay < new TimeSpan(9, 15, 0) || ist.TimeOfDay > new TimeSpan(15, 29, 59)) continue;
            if (!OptionPriceSanity.IsPlausibleBar(o, h, l, c)) continue;
            bars.Add(new CandleWithVolume(time, o, h, l, c, (long)Math.Max(0, v)));
        }
        bars.Sort((a, b) => a.Time.CompareTo(b.Time));
        // One bar per minute (a repeated stamp keeps the later row).
        return bars.GroupBy(b => b.Time).Select(g => g.Last()).ToList();
    }

    private static bool TryNumber(JsonElement row, string name, out decimal value)
    {
        value = 0;
        if (!row.TryGetProperty(name, out var e)) return false;
        return e.ValueKind switch
        {
            JsonValueKind.Number => e.TryGetDecimal(out value),
            JsonValueKind.String => decimal.TryParse(e.GetString(), NumberStyles.Number, CultureInfo.InvariantCulture, out value),
            _ => false,
        };
    }
}
