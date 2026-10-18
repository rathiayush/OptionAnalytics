using System.Globalization;
using System.Text;
using Microsoft.Extensions.Options;

namespace OptionAnalytics.Server.Dhan;

/// <summary>
/// Downloads Dhan's scrip master CSV and keeps only the cash/index rows this app needs to
/// resolve NIFTY 50, NIFTY BANK and SENSEX to their IDX_I security ids. A deliberately narrow
/// cousin of LiveSpreadCalculator's DhanInstrumentMasterService: that one indexes the whole
/// futures/options universe for a trading engine; this app only ever needs a few spot instruments,
/// so it keeps just the INDEX/EQUITY rows and discards everything else (futures, options,
/// currency, commodity - the bulk of Dhan's ~200k-row file) as it streams past.
/// </summary>
public sealed class DhanSpotInstrumentMaster
{
    private static readonly TimeSpan CacheLifetime = TimeSpan.FromHours(12);

    /// <summary>Underlying -> the display name(s) its index spot is listed under, tried in order.
    /// Same aliasing problem LiveSpreadCalculator's SpotSymbology solves for the trading app's
    /// full underlying list, narrowed here to the indices this app charts. NIFTY/BANKNIFTY are
    /// NSE-listed; SENSEX is BSE-listed - both exchanges are kept below (see ParseSpotRows), so
    /// which one a name actually resolves against is left entirely to this table, not a hardcoded
    /// exchange filter that would only ever admit one of the two.</summary>
    private static readonly Dictionary<string, string[]> IndexAliases = new(StringComparer.OrdinalIgnoreCase)
    {
        ["NIFTY"] = new[] { "NIFTY 50", "NIFTY50", "NIFTY" },
        ["BANKNIFTY"] = new[] { "NIFTY BANK", "BANKNIFTY" },
        ["SENSEX"] = new[] { "SENSEX" },
    };

    private readonly HttpClient _httpClient;
    private readonly DhanOptions _options;
    private readonly ILogger<DhanSpotInstrumentMaster> _logger;
    private readonly SemaphoreSlim _loadLock = new(1, 1);

    private List<DhanSpotInstrument> _spotInstruments = new();
    private DateTimeOffset _loadedAt = DateTimeOffset.MinValue;

    public DhanSpotInstrumentMaster(HttpClient httpClient, IOptions<DhanOptions> options, ILogger<DhanSpotInstrumentMaster> logger)
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
                if (_spotInstruments.Count == 0) throw;

                _logger.LogWarning(ex, "Live Dhan scrip master check failed - continuing with the {Count} spot instruments already loaded until the next refresh attempt.", _spotInstruments.Count);
            }
        }
        finally
        {
            _loadLock.Release();
        }
    }

    private bool IsFresh() => _spotInstruments.Count > 0 && DateTimeOffset.UtcNow - _loadedAt < CacheLifetime;

    private async Task RefreshFromDhanAsync(CancellationToken cancellationToken)
    {
        _logger.LogInformation("Downloading Dhan scrip master from {Url}...", _options.ScripMasterUrl);

        // One kept copy shared by every instrument master (DhanScripMasterFile), not a download each.
        await using var stream = await DhanScripMasterFile.OpenAsync(_httpClient, _options.ScripMasterUrl, _logger, cancellationToken);
        var parsed = ParseSpotRows(stream);

        // Same rule as DhanOptionChainMaster: a refresh that parses to NOTHING must never replace a
        // master that works. A 200 response that yields zero rows (a renamed column, an error page
        // served with a success status, a truncated body) throws nothing, so the catch above -
        // which DOES preserve the old data - never sees it, and the previous good copy would be
        // silently wiped. Everything downstream then fails to resolve an instrument at all.
        if (parsed.Count == 0)
        {
            _logger.LogError(
                "Dhan scrip master parsed to ZERO cash/index rows. {Action} Check whether {Url} still serves the expected CSV columns.",
                _spotInstruments.Count > 0
                    ? $"KEEPING the {_spotInstruments.Count} row(s) already loaded rather than wiping them."
                    : "Nothing was loaded before either, so no spot instrument can be resolved.",
                _options.ScripMasterUrl);
            return;
        }

        _spotInstruments = parsed;
        _loadedAt = DateTimeOffset.UtcNow;

        _logger.LogInformation("Dhan spot instrument master ready: {Count} cash/index rows loaded.", _spotInstruments.Count);

        var nifty = FindSpot("NIFTY");
        var bankNifty = FindSpot("BANKNIFTY");
        var sensex = FindSpot("SENSEX");
        if (nifty is null) _logger.LogWarning("Could not find a NIFTY spot/index row in the Dhan scrip master.");
        if (bankNifty is null) _logger.LogWarning("Could not find a BANKNIFTY spot/index row in the Dhan scrip master.");
        if (sensex is null) _logger.LogWarning("Could not find a SENSEX spot/index row in the Dhan scrip master.");
        if (nifty is not null) _logger.LogInformation("Resolved NIFTY spot -> securityId={Id} ({Symbol}, segment={Segment})", nifty.SecurityId, nifty.TradingSymbol, nifty.DhanSegment);
        if (bankNifty is not null) _logger.LogInformation("Resolved BANKNIFTY spot -> securityId={Id} ({Symbol}, segment={Segment})", bankNifty.SecurityId, bankNifty.TradingSymbol, bankNifty.DhanSegment);
        if (sensex is not null) _logger.LogInformation("Resolved SENSEX spot -> securityId={Id} ({Symbol}, segment={Segment})", sensex.SecurityId, sensex.TradingSymbol, sensex.DhanSegment);
    }

    /// <summary>Matches an underlying (NIFTY/BANKNIFTY) to its cash/index row, trying the
    /// underlying name itself and then each known display alias.</summary>
    public DhanSpotInstrument? FindSpot(string underlying)
    {
        var candidates = IndexAliases.TryGetValue(underlying, out var aliases) ? aliases : new[] { underlying };

        foreach (var candidate in candidates)
        {
            var match = _spotInstruments.FirstOrDefault(i =>
                string.Equals(i.TradingSymbol, candidate, StringComparison.OrdinalIgnoreCase) ||
                string.Equals(i.Name, candidate, StringComparison.OrdinalIgnoreCase));
            if (match is not null) return match;
        }

        return null;
    }

    // ---- CSV parsing ---------------------------------------------------------------------------

    private static class Columns
    {
        public static readonly string[] SecurityId = { "SEM_SMST_SECURITY_ID", "SECURITY_ID" };
        public static readonly string[] Exchange = { "SEM_EXM_EXCH_ID", "EXCH_ID" };
        public static readonly string[] InstrumentName = { "SEM_INSTRUMENT_NAME", "INSTRUMENT" };
        public static readonly string[] TradingSymbol = { "SEM_TRADING_SYMBOL", "TRADING_SYMBOL" };
        public static readonly string[] UnderlyingName = { "SM_SYMBOL_NAME", "UNDERLYING_SYMBOL", "SYMBOL_NAME" };
    }

    private List<DhanSpotInstrument> ParseSpotRows(Stream stream)
    {
        var spot = new List<DhanSpotInstrument>();
        using var reader = new StreamReader(stream);

        var headerLine = reader.ReadLine();
        if (headerLine is null)
        {
            _logger.LogError("Dhan scrip master was empty - no header row.");
            return spot;
        }

        var header = BuildHeaderMap(SplitCsvLine(headerLine));
        var securityIdIndex = Resolve(header, Columns.SecurityId);
        var exchangeIndex = Resolve(header, Columns.Exchange);
        var instrumentNameIndex = Resolve(header, Columns.InstrumentName);
        var tradingSymbolIndex = Resolve(header, Columns.TradingSymbol);
        var underlyingIndex = Resolve(header, Columns.UnderlyingName);

        if (securityIdIndex < 0 || exchangeIndex < 0 || instrumentNameIndex < 0 || tradingSymbolIndex < 0)
        {
            _logger.LogError("Dhan scrip master at {Url} is missing required columns. Header was: {Header}", _options.ScripMasterUrl, headerLine);
            return spot;
        }

        string? line;
        while ((line = reader.ReadLine()) is not null)
        {
            if (line.Length == 0) continue;
            var fields = SplitCsvLine(line);

            var instrumentName = Get(fields, instrumentNameIndex)?.Trim();
            var isIndex = string.Equals(instrumentName, "INDEX", StringComparison.OrdinalIgnoreCase);
            var isEquity = string.Equals(instrumentName, "EQUITY", StringComparison.OrdinalIgnoreCase);
            if (!isIndex && !isEquity) continue;

            // NIFTY/BANKNIFTY are NSE-listed, SENSEX is BSE-listed - both are kept here and left to
            // IndexAliases/FindSpot's own name matching to tell apart, rather than a single hardcoded
            // exchange that would only ever admit one of the two.
            var exchange = Get(fields, exchangeIndex)?.Trim();
            if (!string.Equals(exchange, "NSE", StringComparison.OrdinalIgnoreCase) &&
                !string.Equals(exchange, "BSE", StringComparison.OrdinalIgnoreCase))
                continue;

            if (!uint.TryParse(Get(fields, securityIdIndex), NumberStyles.Integer, CultureInfo.InvariantCulture, out var securityId))
                continue;

            var tradingSymbol = Get(fields, tradingSymbolIndex);
            if (string.IsNullOrWhiteSpace(tradingSymbol)) continue;

            var name = Get(fields, underlyingIndex);
            if (string.IsNullOrWhiteSpace(name)) name = tradingSymbol;

            // A Dhan securityId is only unique WITHIN a segment - IDX_I for the index level,
            // NSE_EQ for a cash equity. Getting this wrong subscribes a completely different
            // instrument that happens to share the numeric id.
            spot.Add(new DhanSpotInstrument(securityId, tradingSymbol, name, isIndex ? "IDX_I" : "NSE_EQ"));
        }

        return spot;
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
