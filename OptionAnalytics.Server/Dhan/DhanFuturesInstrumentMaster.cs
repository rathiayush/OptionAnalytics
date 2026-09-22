using System.Globalization;
using System.Text;
using Microsoft.Extensions.Options;

namespace OptionAnalytics.Server.Dhan;

/// <summary>
/// Downloads Dhan's scrip master CSV and keeps only NIFTY/BANKNIFTY/SENSEX index futures (FUTIDX)
/// rows - resolves which contract to fetch OHLC/OI for on OI Replay's own "show me the futures
/// too" chart (see OiReplayService). A cousin of DhanOptionChainMaster (same download, FUTIDX rows
/// instead of OPTIDX, no strike/option-type dimension since a future has exactly one contract per
/// underlying per expiry).
///
/// ONLY EVER RESOLVES A CURRENTLY-LISTED CONTRACT - Dhan's live scrip master, like the option
/// chain master, only ever lists contracts that have not yet expired. A REPLAY date old enough
/// that its own front-month contract has since expired and rolled off the master cannot be
/// resolved to a security id here at all (there is no "rolling futures" endpoint the way
/// DhanRollingOptionDataService has for options) - GetNearestExpiry still returns the CURRENTLY
/// nearest contract in that case, but a caller fetching that contract's OHLC for an old date will
/// simply get back zero bars (the contract did not exist yet on that date), which
/// OiReplayService's own futures fetch treats as "not available for this date" rather than an
/// error.
/// </summary>
public sealed class DhanFuturesInstrumentMaster
{
    private static readonly TimeSpan CacheLifetime = TimeSpan.FromHours(12);
    private static readonly TimeSpan EmptyRetryInterval = TimeSpan.FromMinutes(1);

    private static readonly string[] Underlyings = { "NIFTY", "BANKNIFTY", "SENSEX" };

    private readonly HttpClient _httpClient;
    private readonly DhanOptions _options;
    private readonly ILogger<DhanFuturesInstrumentMaster> _logger;
    private readonly SemaphoreSlim _loadLock = new(1, 1);

    private Dictionary<string, List<DhanFuturesInstrument>> _byUnderlying = new(StringComparer.OrdinalIgnoreCase);
    private DateTimeOffset _loadedAt = DateTimeOffset.MinValue;
    private DateTimeOffset _lastAttemptAt = DateTimeOffset.MinValue;

    public DhanFuturesInstrumentMaster(HttpClient httpClient, IOptions<DhanOptions> options, ILogger<DhanFuturesInstrumentMaster> logger)
    {
        _httpClient = httpClient;
        _options = options.Value;
        _logger = logger;
    }

    public async Task EnsureLoadedAsync(CancellationToken cancellationToken)
    {
        if (IsFresh()) return;

        await _loadLock.WaitAsync(cancellationToken);
        try
        {
            if (IsFresh()) return;
            if (_byUnderlying.Count == 0 && DateTimeOffset.UtcNow - _lastAttemptAt < EmptyRetryInterval) return;
            _lastAttemptAt = DateTimeOffset.UtcNow;

            try
            {
                await RefreshFromDhanAsync(cancellationToken);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                if (_byUnderlying.Count == 0) throw;
                _logger.LogWarning(ex, "Live Dhan scrip master check failed - continuing with the futures contracts already loaded.");
            }
        }
        finally
        {
            _loadLock.Release();
        }
    }

    private bool IsFresh() => _byUnderlying.Count > 0 && DateTimeOffset.UtcNow - _loadedAt < CacheLifetime;

    private async Task RefreshFromDhanAsync(CancellationToken cancellationToken)
    {
        using var response = await _httpClient.GetAsync(_options.ScripMasterUrl, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
        response.EnsureSuccessStatusCode();

        await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
        var parsed = ParseFuturesRows(stream);

        // Same "never let a zero-row parse wipe a working master" guard as DhanOptionChainMaster -
        // see that class's own doc comment for the real outage this pattern guards against.
        if (parsed.Count == 0)
        {
            _logger.LogError(
                "Dhan scrip master parsed to ZERO futures contracts. {Action} Check whether {Url} still serves the expected CSV columns.",
                _byUnderlying.Count > 0
                    ? "KEEPING the contracts already loaded rather than wiping them."
                    : "Nothing was loaded before either, so no futures contract can be resolved.",
                _options.ScripMasterUrl);
            return;
        }

        _byUnderlying = parsed
            .GroupBy(f => f.Underlying, StringComparer.OrdinalIgnoreCase)
            .ToDictionary(g => g.Key, g => g.OrderBy(f => f.Expiry).ToList(), StringComparer.OrdinalIgnoreCase);
        _loadedAt = DateTimeOffset.UtcNow;

        _logger.LogInformation("Futures instrument master ready: {Count} contract(s) across {Underlyings}.",
            parsed.Count, string.Join(", ", _byUnderlying.Keys));
    }

    public IReadOnlyList<DateOnly> GetExpiries(string underlying) =>
        _byUnderlying.TryGetValue(underlying, out var list) ? list.Select(f => f.Expiry).ToList() : Array.Empty<DateOnly>();

    /// <summary>The nearest (soonest) currently-listed contract that has not already expired as of
    /// <paramref name="asOf"/> - see this class's own doc comment for why an OLDER date's actual
    /// front-month contract may no longer be resolvable here at all.</summary>
    public DhanFuturesInstrument? GetNearestContract(string underlying, DateOnly asOf) =>
        _byUnderlying.TryGetValue(underlying, out var list) ? list.FirstOrDefault(f => f.Expiry >= asOf) : null;

    // ---- CSV parsing ---------------------------------------------------------------------------

    private static class Columns
    {
        public static readonly string[] SecurityId = { "SEM_SMST_SECURITY_ID", "SECURITY_ID" };
        public static readonly string[] Exchange = { "SEM_EXM_EXCH_ID", "EXCH_ID" };
        public static readonly string[] InstrumentName = { "SEM_INSTRUMENT_NAME", "INSTRUMENT" };
        public static readonly string[] TradingSymbol = { "SEM_TRADING_SYMBOL", "TRADING_SYMBOL" };
        public static readonly string[] Expiry = { "SEM_EXPIRY_DATE", "SM_EXPIRY_DATE", "EXPIRY_DATE" };
        public static readonly string[] LotSize = { "SEM_LOT_UNITS", "LOT_SIZE" };
        public static readonly string[] TickSize = { "SEM_TICK_SIZE", "TICK_SIZE" };
    }

    private List<DhanFuturesInstrument> ParseFuturesRows(Stream stream)
    {
        var futures = new List<DhanFuturesInstrument>();
        using var reader = new StreamReader(stream);

        var headerLine = reader.ReadLine();
        if (headerLine is null)
        {
            _logger.LogError("Dhan scrip master at {Url} returned an empty body - no header row.", _options.ScripMasterUrl);
            return futures;
        }

        var header = BuildHeaderMap(SplitCsvLine(headerLine));
        var securityIdIndex = Resolve(header, Columns.SecurityId);
        var exchangeIndex = Resolve(header, Columns.Exchange);
        var instrumentNameIndex = Resolve(header, Columns.InstrumentName);
        var tradingSymbolIndex = Resolve(header, Columns.TradingSymbol);
        var expiryIndex = Resolve(header, Columns.Expiry);
        var lotSizeIndex = Resolve(header, Columns.LotSize);
        var tickSizeIndex = Resolve(header, Columns.TickSize);

        if (securityIdIndex < 0 || exchangeIndex < 0 || instrumentNameIndex < 0 || tradingSymbolIndex < 0)
        {
            _logger.LogError("Dhan scrip master at {Url} is missing required columns. Header was: {Header}", _options.ScripMasterUrl, headerLine);
            return futures;
        }

        string? line;
        while ((line = reader.ReadLine()) is not null)
        {
            if (line.Length == 0) continue;
            var fields = SplitCsvLine(line);

            var instrumentName = Get(fields, instrumentNameIndex)?.Trim();
            if (!string.Equals(instrumentName, "FUTIDX", StringComparison.OrdinalIgnoreCase)) continue;

            var tradingSymbol = Get(fields, tradingSymbolIndex);
            if (string.IsNullOrWhiteSpace(tradingSymbol)) continue;

            // Same "UNDERLYING-Mon YYYY-FUT" leading-segment convention as DhanOptionChainMaster's
            // own DeriveUnderlying - see that method's own doc comment for why the dedicated
            // underlying-name column is not usable here either.
            var underlying = DeriveUnderlying(tradingSymbol);
            if (string.IsNullOrWhiteSpace(underlying) || !Underlyings.Contains(underlying, StringComparer.OrdinalIgnoreCase))
                continue;

            var exchange = Get(fields, exchangeIndex)?.Trim().ToUpperInvariant();
            var exchangeSegment = exchange switch
            {
                "NSE" => "NSE_FNO",
                "BSE" => "BSE_FNO",
                _ => null,
            };
            if (exchangeSegment is null) continue;

            if (!uint.TryParse(Get(fields, securityIdIndex), NumberStyles.Integer, CultureInfo.InvariantCulture, out var securityId))
                continue;

            var expiry = ParseExpiry(Get(fields, expiryIndex));
            if (expiry is null) continue;

            var lotSize = (int)ParseDecimal(Get(fields, lotSizeIndex));
            if (lotSize <= 0) continue;

            var tickSize = ParseDecimal(Get(fields, tickSizeIndex));
            if (tickSize <= 0) continue;

            futures.Add(new DhanFuturesInstrument(securityId, tradingSymbol, underlying, expiry.Value, exchangeSegment, lotSize, tickSize));
        }

        return futures;
    }

    private static string DeriveUnderlying(string tradingSymbol)
    {
        var dash = tradingSymbol.IndexOf('-');
        return dash > 0 ? tradingSymbol[..dash] : tradingSymbol;
    }

    private static Dictionary<string, int> BuildHeaderMap(string[] header)
    {
        var map = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
        for (var i = 0; i < header.Length; i++)
        {
            var name = header[i].Trim().Trim('﻿');
            if (name.Length > 0) map.TryAdd(name, i);
        }
        return map;
    }

    private static int Resolve(Dictionary<string, int> header, string[] candidates)
    {
        foreach (var candidate in candidates)
            if (header.TryGetValue(candidate, out var index)) return index;
        return -1;
    }

    private static string? Get(string[] fields, int index) => index >= 0 && index < fields.Length ? fields[index].Trim() : null;

    private static DateOnly? ParseExpiry(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw)) return null;
        var datePart = raw.Length > 10 ? raw[..10] : raw;
        if (DateOnly.TryParse(datePart, CultureInfo.InvariantCulture, DateTimeStyles.None, out var date))
            return date;
        return DateTime.TryParse(raw, CultureInfo.InvariantCulture, DateTimeStyles.None, out var dateTime)
            ? DateOnly.FromDateTime(dateTime)
            : null;
    }

    private static decimal ParseDecimal(string? raw) =>
        decimal.TryParse(raw, NumberStyles.Float, CultureInfo.InvariantCulture, out var value) ? value : 0m;

    private static string[] SplitCsvLine(string line)
    {
        var fields = new List<string>();
        var current = new StringBuilder();
        var inQuotes = false;

        foreach (var c in line)
        {
            if (c == '"') inQuotes = !inQuotes;
            else if (c == ',' && !inQuotes) { fields.Add(current.ToString()); current.Clear(); }
            else current.Append(c);
        }
        fields.Add(current.ToString());
        return fields.ToArray();
    }
}
