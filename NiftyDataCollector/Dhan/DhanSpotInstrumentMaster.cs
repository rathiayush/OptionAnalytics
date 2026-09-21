using System.Globalization;
using System.Text;

namespace NiftyDataCollector.Dhan;

/// <summary>
/// Downloads Dhan's scrip master CSV once and resolves whichever index rows this collector is
/// configured to track (NIFTY, BANKNIFTY, ...) from that single pass - a trim of
/// OptionAnalytics.Server's own DhanSpotInstrumentMaster, same CSV, same column-resolution logic.
/// Copied rather than referenced - see this project's own README for why this collector
/// intentionally duplicates rather than shares code with OptionAnalytics.Server.
/// </summary>
public sealed class DhanSpotInstrumentMaster
{
    private const string ScripMasterUrl = "https://images.dhan.co/api-data/api-scrip-master.csv";
    private static readonly TimeSpan CacheLifetime = TimeSpan.FromHours(12);

    /// <summary>Canonical name (matches Collector:Underlyings[].Name in config) -> the trading
    /// symbol/underlying-name spellings Dhan's scrip master uses for that index. Add a new entry
    /// here to track another index - nothing else in this class needs to change.</summary>
    private static readonly Dictionary<string, string[]> IndexAliases = new(StringComparer.OrdinalIgnoreCase)
    {
        ["NIFTY"] = new[] { "NIFTY 50", "NIFTY50", "NIFTY" },
        ["BANKNIFTY"] = new[] { "NIFTY BANK", "BANKNIFTY", "NIFTY BANK 50" },
    };

    private readonly HttpClient _httpClient;
    private readonly ILogger<DhanSpotInstrumentMaster> _logger;
    private readonly SemaphoreSlim _loadLock = new(1, 1);

    private readonly Dictionary<string, DhanSpotInstrument> _resolved = new(StringComparer.OrdinalIgnoreCase);
    private DateTimeOffset _loadedAt = DateTimeOffset.MinValue;

    public DhanSpotInstrumentMaster(HttpClient httpClient, ILogger<DhanSpotInstrumentMaster> logger)
    {
        _httpClient = httpClient;
        _logger = logger;
    }

    /// <summary>The named index's own securityId/segment (canonicalName must be a key in
    /// IndexAliases, e.g. "NIFTY" or "BANKNIFTY"), refreshing the scrip master first if it is
    /// missing or older than CacheLifetime. One CSV download refreshes every tracked index at once,
    /// not just the one asked for. Throws only when NEITHER a fresh nor a previously cached
    /// resolution exists for this name - a transient download failure with a still-valid cached
    /// value is logged and swallowed instead.</summary>
    public async Task<DhanSpotInstrument> ResolveAsync(string canonicalName, CancellationToken cancellationToken)
    {
        if (_resolved.TryGetValue(canonicalName, out var cached) && DateTimeOffset.UtcNow - _loadedAt < CacheLifetime) return cached;

        await _loadLock.WaitAsync(cancellationToken);
        try
        {
            if (_resolved.TryGetValue(canonicalName, out cached) && DateTimeOffset.UtcNow - _loadedAt < CacheLifetime) return cached;

            try
            {
                await RefreshAsync(cancellationToken);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                if (!_resolved.ContainsKey(canonicalName)) throw;
                _logger.LogWarning(ex, "Scrip master refresh failed - continuing with the previously resolved {Name} instrument.", canonicalName);
            }

            if (!_resolved.TryGetValue(canonicalName, out cached))
                throw new InvalidOperationException($"Could not resolve a {canonicalName} spot/index row from the Dhan scrip master - check IndexAliases in DhanSpotInstrumentMaster.");
            return cached;
        }
        finally
        {
            _loadLock.Release();
        }
    }

    private async Task RefreshAsync(CancellationToken cancellationToken)
    {
        _logger.LogInformation("Downloading Dhan scrip master from {Url}...", ScripMasterUrl);
        using var response = await _httpClient.GetAsync(ScripMasterUrl, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
        response.EnsureSuccessStatusCode();

        await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
        var found = ParseIndices(stream);

        foreach (var (name, _) in IndexAliases)
        {
            if (found.TryGetValue(name, out var instrument))
            {
                _resolved[name] = instrument;
                _logger.LogInformation("Resolved {Name} spot -> securityId={Id} ({Symbol}, segment={Segment})", name, instrument.SecurityId, instrument.TradingSymbol, instrument.DhanSegment);
            }
            else if (!_resolved.ContainsKey(name))
            {
                _logger.LogError("Could not find a {Name} row in the Dhan scrip master.", name);
            }
        }

        _loadedAt = DateTimeOffset.UtcNow;
    }

    private static class Columns
    {
        public static readonly string[] SecurityId = { "SEM_SMST_SECURITY_ID", "SECURITY_ID" };
        public static readonly string[] Exchange = { "SEM_EXM_EXCH_ID", "EXCH_ID" };
        public static readonly string[] InstrumentName = { "SEM_INSTRUMENT_NAME", "INSTRUMENT" };
        public static readonly string[] TradingSymbol = { "SEM_TRADING_SYMBOL", "TRADING_SYMBOL" };
        public static readonly string[] UnderlyingName = { "SM_SYMBOL_NAME", "UNDERLYING_SYMBOL", "SYMBOL_NAME" };
    }

    private Dictionary<string, DhanSpotInstrument> ParseIndices(Stream stream)
    {
        var found = new Dictionary<string, DhanSpotInstrument>(StringComparer.OrdinalIgnoreCase);

        using var reader = new StreamReader(stream);
        var headerLine = reader.ReadLine();
        if (headerLine is null) { _logger.LogError("Dhan scrip master was empty - no header row."); return found; }

        var header = BuildHeaderMap(SplitCsvLine(headerLine));
        var securityIdIndex = Resolve(header, Columns.SecurityId);
        var exchangeIndex = Resolve(header, Columns.Exchange);
        var instrumentNameIndex = Resolve(header, Columns.InstrumentName);
        var tradingSymbolIndex = Resolve(header, Columns.TradingSymbol);
        var underlyingIndex = Resolve(header, Columns.UnderlyingName);

        if (securityIdIndex < 0 || exchangeIndex < 0 || instrumentNameIndex < 0 || tradingSymbolIndex < 0)
        {
            _logger.LogError("Dhan scrip master is missing required columns. Header was: {Header}", headerLine);
            return found;
        }

        string? line;
        while ((line = reader.ReadLine()) is not null && found.Count < IndexAliases.Count)
        {
            if (line.Length == 0) continue;
            var fields = SplitCsvLine(line);

            var instrumentName = Get(fields, instrumentNameIndex)?.Trim();
            if (!string.Equals(instrumentName, "INDEX", StringComparison.OrdinalIgnoreCase)) continue;

            var exchange = Get(fields, exchangeIndex)?.Trim();
            if (!string.Equals(exchange, "NSE", StringComparison.OrdinalIgnoreCase)) continue;

            var tradingSymbol = Get(fields, tradingSymbolIndex);
            var name = Get(fields, underlyingIndex);

            foreach (var (canonicalName, aliases) in IndexAliases)
            {
                if (found.ContainsKey(canonicalName)) continue;
                if (!aliases.Contains(tradingSymbol, StringComparer.OrdinalIgnoreCase) &&
                    !aliases.Contains(name, StringComparer.OrdinalIgnoreCase))
                    continue;

                if (!uint.TryParse(Get(fields, securityIdIndex), NumberStyles.Integer, CultureInfo.InvariantCulture, out var securityId))
                    continue;

                found[canonicalName] = new DhanSpotInstrument(securityId, tradingSymbol ?? canonicalName, name ?? canonicalName, "IDX_I");
                break;
            }
        }

        return found;
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
