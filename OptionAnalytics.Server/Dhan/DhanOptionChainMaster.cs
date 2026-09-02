using System.Globalization;
using System.Text;
using Microsoft.Extensions.Options;

namespace OptionAnalytics.Server.Dhan;

/// <summary>
/// Downloads Dhan's scrip master CSV and keeps only NIFTY/BANKNIFTY index option (OPTIDX) rows -
/// the CDV feature's option-chain source. A cousin of DhanSpotInstrumentMaster (same download,
/// different rows kept) and a narrowed port of LiveSpreadCalculator's
/// DhanInstrumentMasterService.BuildOptionIndex/FindOption/TryReadOptionRow.
/// </summary>
public sealed class DhanOptionChainMaster
{
    private static readonly TimeSpan CacheLifetime = TimeSpan.FromHours(12);
    private static readonly string[] Underlyings = { "NIFTY", "BANKNIFTY" };

    private readonly HttpClient _httpClient;
    private readonly DhanOptions _options;
    private readonly ILogger<DhanOptionChainMaster> _logger;
    private readonly SemaphoreSlim _loadLock = new(1, 1);

    private Dictionary<string, DhanOptionInstrument> _byKey = new(StringComparer.OrdinalIgnoreCase);
    private Dictionary<string, List<DateOnly>> _expiriesByUnderlying = new(StringComparer.OrdinalIgnoreCase);
    private DateTimeOffset _loadedAt = DateTimeOffset.MinValue;

    public DhanOptionChainMaster(HttpClient httpClient, IOptions<DhanOptions> options, ILogger<DhanOptionChainMaster> logger)
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

            try
            {
                await RefreshFromDhanAsync(cancellationToken);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                if (_byKey.Count == 0) throw;
                _logger.LogWarning(ex, "Live Dhan scrip master check failed - continuing with the {Count} option contracts already loaded.", _byKey.Count);
            }
        }
        finally
        {
            _loadLock.Release();
        }
    }

    private bool IsFresh() => _byKey.Count > 0 && DateTimeOffset.UtcNow - _loadedAt < CacheLifetime;

    private async Task RefreshFromDhanAsync(CancellationToken cancellationToken)
    {
        using var response = await _httpClient.GetAsync(_options.ScripMasterUrl, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
        response.EnsureSuccessStatusCode();

        await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
        var options = ParseOptionRows(stream);

        _byKey = new Dictionary<string, DhanOptionInstrument>(StringComparer.OrdinalIgnoreCase);
        var expiries = new Dictionary<string, SortedSet<DateOnly>>(StringComparer.OrdinalIgnoreCase);

        foreach (var option in options)
        {
            _byKey[Key(option.Underlying, option.Expiry, option.Strike, option.IsCall)] = option;
            if (!expiries.TryGetValue(option.Underlying, out var set))
                expiries[option.Underlying] = set = new SortedSet<DateOnly>();
            set.Add(option.Expiry);
        }

        _expiriesByUnderlying = expiries.ToDictionary(kv => kv.Key, kv => kv.Value.ToList(), StringComparer.OrdinalIgnoreCase);
        _loadedAt = DateTimeOffset.UtcNow;

        _logger.LogInformation("Option chain master ready: {Count} NIFTY/BANKNIFTY option contracts loaded.", _byKey.Count);
    }

    public IReadOnlyList<DateOnly> GetExpiries(string underlying) =>
        _expiriesByUnderlying.TryGetValue(underlying, out var list) ? list : Array.Empty<DateOnly>();

    /// <summary>The nearest (soonest) expiry that hasn't already passed <paramref name="asOf"/>.</summary>
    public DateOnly? GetNearestExpiry(string underlying, DateOnly asOf) =>
        GetExpiries(underlying).Where(e => e >= asOf).Cast<DateOnly?>().FirstOrDefault();

    public DhanOptionInstrument? Find(string underlying, DateOnly expiry, decimal strike, bool isCall) =>
        _byKey.TryGetValue(Key(underlying, expiry, strike, isCall), out var match) ? match : null;

    private static string Key(string underlying, DateOnly expiry, decimal strike, bool isCall) =>
        $"{underlying}|{expiry:yyyy-MM-dd}|{strike:0.####}|{(isCall ? "CE" : "PE")}";

    // ---- CSV parsing ---------------------------------------------------------------------------

    private static class Columns
    {
        public static readonly string[] SecurityId = { "SEM_SMST_SECURITY_ID", "SECURITY_ID" };
        public static readonly string[] Exchange = { "SEM_EXM_EXCH_ID", "EXCH_ID" };
        public static readonly string[] InstrumentName = { "SEM_INSTRUMENT_NAME", "INSTRUMENT" };
        public static readonly string[] TradingSymbol = { "SEM_TRADING_SYMBOL", "TRADING_SYMBOL" };
        public static readonly string[] UnderlyingName = { "SM_SYMBOL_NAME", "UNDERLYING_SYMBOL", "SYMBOL_NAME" };
        public static readonly string[] Expiry = { "SEM_EXPIRY_DATE", "SM_EXPIRY_DATE", "EXPIRY_DATE" };
        public static readonly string[] Strike = { "SEM_STRIKE_PRICE", "STRIKE_PRICE" };
        public static readonly string[] OptionType = { "SEM_OPTION_TYPE", "OPTION_TYPE" };
        public static readonly string[] LotSize = { "SEM_LOT_UNITS", "LOT_SIZE" };
        public static readonly string[] TickSize = { "SEM_TICK_SIZE", "TICK_SIZE" };
    }

    private List<DhanOptionInstrument> ParseOptionRows(Stream stream)
    {
        var options = new List<DhanOptionInstrument>();
        using var reader = new StreamReader(stream);

        var headerLine = reader.ReadLine();
        if (headerLine is null) return options;

        var header = BuildHeaderMap(SplitCsvLine(headerLine));
        var securityIdIndex = Resolve(header, Columns.SecurityId);
        var exchangeIndex = Resolve(header, Columns.Exchange);
        var instrumentNameIndex = Resolve(header, Columns.InstrumentName);
        var tradingSymbolIndex = Resolve(header, Columns.TradingSymbol);
        var underlyingIndex = Resolve(header, Columns.UnderlyingName);
        var expiryIndex = Resolve(header, Columns.Expiry);
        var strikeIndex = Resolve(header, Columns.Strike);
        var optionTypeIndex = Resolve(header, Columns.OptionType);
        var lotSizeIndex = Resolve(header, Columns.LotSize);
        var tickSizeIndex = Resolve(header, Columns.TickSize);

        if (securityIdIndex < 0 || exchangeIndex < 0 || instrumentNameIndex < 0 || tradingSymbolIndex < 0)
        {
            _logger.LogError("Dhan scrip master at {Url} is missing required columns. Header was: {Header}", _options.ScripMasterUrl, headerLine);
            return options;
        }

        string? line;
        while ((line = reader.ReadLine()) is not null)
        {
            if (line.Length == 0) continue;
            var fields = SplitCsvLine(line);

            var instrumentName = Get(fields, instrumentNameIndex)?.Trim();
            if (!string.Equals(instrumentName, "OPTIDX", StringComparison.OrdinalIgnoreCase)) continue;

            var tradingSymbol = Get(fields, tradingSymbolIndex);
            if (string.IsNullOrWhiteSpace(tradingSymbol)) continue;

            // Confirmed against a real download: Dhan leaves SM_SYMBOL_NAME BLANK on every NSE
            // index option row (unlike futures rows, which populate it), so this column alone
            // silently drops every NIFTY/BANKNIFTY option. Fallback: Dhan's option trading symbols
            // are "UNDERLYING-MonYYYY-STRIKE-CE/PE", so the leading segment before the first dash
            // is the underlying either way.
            var underlying = Get(fields, underlyingIndex);
            if (string.IsNullOrWhiteSpace(underlying))
                underlying = DeriveUnderlying(tradingSymbol);
            if (string.IsNullOrWhiteSpace(underlying) || !Underlyings.Contains(underlying, StringComparer.OrdinalIgnoreCase))
                continue;

            if (!uint.TryParse(Get(fields, securityIdIndex), NumberStyles.Integer, CultureInfo.InvariantCulture, out var securityId))
                continue;

            var expiry = ParseExpiry(Get(fields, expiryIndex));
            if (expiry is null) continue;

            var optionType = Get(fields, optionTypeIndex)?.Trim().ToUpperInvariant();
            if (optionType is not ("CE" or "PE")) continue;

            var strike = ParseDecimal(Get(fields, strikeIndex));
            if (strike <= 0) continue;

            // A lot size that fails to parse would silently place an order in raw units instead
            // of lots - too dangerous to default; skip the row instead (same "no data" tolerance
            // as everywhere else in this backfill, just applied to a column not read before).
            var lotSize = (int)ParseDecimal(Get(fields, lotSizeIndex));
            if (lotSize <= 0) continue;
            var tickSize = ParseDecimal(Get(fields, tickSizeIndex));

            options.Add(new DhanOptionInstrument(securityId, tradingSymbol, underlying, expiry.Value, strike, optionType == "CE", "NSE_FNO", lotSize, tickSize));
        }

        return options;
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
