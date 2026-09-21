using System.Globalization;
using System.Text;

namespace NiftyDataCollector.Dhan;

/// <summary>
/// Downloads Dhan's scrip master CSV and resolves NIFTY's own cash/index row - a NIFTY-only trim
/// of OptionAnalytics.Server's own DhanSpotInstrumentMaster (same CSV, same column-resolution
/// logic, kept identical on purpose so a future BANKNIFTY extension is a one-line change to
/// IndexAliases, not a rewrite). Copied rather than referenced - see this project's own README for
/// why this collector intentionally duplicates rather than shares code with OptionAnalytics.Server.
/// </summary>
public sealed class DhanSpotInstrumentMaster
{
    private const string ScripMasterUrl = "https://images.dhan.co/api-data/api-scrip-master.csv";
    private static readonly TimeSpan CacheLifetime = TimeSpan.FromHours(12);
    private static readonly string[] NiftyAliases = { "NIFTY 50", "NIFTY50", "NIFTY" };

    private readonly HttpClient _httpClient;
    private readonly ILogger<DhanSpotInstrumentMaster> _logger;
    private readonly SemaphoreSlim _loadLock = new(1, 1);

    private DhanSpotInstrument? _nifty;
    private DateTimeOffset _loadedAt = DateTimeOffset.MinValue;

    public DhanSpotInstrumentMaster(HttpClient httpClient, ILogger<DhanSpotInstrumentMaster> logger)
    {
        _httpClient = httpClient;
        _logger = logger;
    }

    /// <summary>NIFTY's own securityId/segment, refreshing the scrip master first if it is missing
    /// or older than CacheLifetime. Throws only when NEITHER a fresh nor a previously cached
    /// resolution exists - a transient download failure with a still-valid cached value is logged
    /// and swallowed instead, same "keep serving the last good answer" rule
    /// OptionAnalytics.Server's own scrip master classes use.</summary>
    public async Task<DhanSpotInstrument> ResolveNiftyAsync(CancellationToken cancellationToken)
    {
        if (_nifty is not null && DateTimeOffset.UtcNow - _loadedAt < CacheLifetime) return _nifty;

        await _loadLock.WaitAsync(cancellationToken);
        try
        {
            if (_nifty is not null && DateTimeOffset.UtcNow - _loadedAt < CacheLifetime) return _nifty;

            try
            {
                await RefreshAsync(cancellationToken);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                if (_nifty is null) throw;
                _logger.LogWarning(ex, "Scrip master refresh failed - continuing with the previously resolved NIFTY instrument.");
            }

            if (_nifty is null) throw new InvalidOperationException("Could not resolve a NIFTY spot/index row from the Dhan scrip master.");
            return _nifty;
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
        var resolved = ParseForNifty(stream);

        if (resolved is null)
        {
            _logger.LogError("Could not find a NIFTY row in the Dhan scrip master - {Action}",
                _nifty is not null ? "keeping the previously resolved instrument." : "nothing was resolved before either.");
            return;
        }

        _nifty = resolved;
        _loadedAt = DateTimeOffset.UtcNow;
        _logger.LogInformation("Resolved NIFTY spot -> securityId={Id} ({Symbol}, segment={Segment})", resolved.SecurityId, resolved.TradingSymbol, resolved.DhanSegment);
    }

    private static class Columns
    {
        public static readonly string[] SecurityId = { "SEM_SMST_SECURITY_ID", "SECURITY_ID" };
        public static readonly string[] Exchange = { "SEM_EXM_EXCH_ID", "EXCH_ID" };
        public static readonly string[] InstrumentName = { "SEM_INSTRUMENT_NAME", "INSTRUMENT" };
        public static readonly string[] TradingSymbol = { "SEM_TRADING_SYMBOL", "TRADING_SYMBOL" };
        public static readonly string[] UnderlyingName = { "SM_SYMBOL_NAME", "UNDERLYING_SYMBOL", "SYMBOL_NAME" };
    }

    private DhanSpotInstrument? ParseForNifty(Stream stream)
    {
        using var reader = new StreamReader(stream);
        var headerLine = reader.ReadLine();
        if (headerLine is null) { _logger.LogError("Dhan scrip master was empty - no header row."); return null; }

        var header = BuildHeaderMap(SplitCsvLine(headerLine));
        var securityIdIndex = Resolve(header, Columns.SecurityId);
        var exchangeIndex = Resolve(header, Columns.Exchange);
        var instrumentNameIndex = Resolve(header, Columns.InstrumentName);
        var tradingSymbolIndex = Resolve(header, Columns.TradingSymbol);
        var underlyingIndex = Resolve(header, Columns.UnderlyingName);

        if (securityIdIndex < 0 || exchangeIndex < 0 || instrumentNameIndex < 0 || tradingSymbolIndex < 0)
        {
            _logger.LogError("Dhan scrip master is missing required columns. Header was: {Header}", headerLine);
            return null;
        }

        string? line;
        while ((line = reader.ReadLine()) is not null)
        {
            if (line.Length == 0) continue;
            var fields = SplitCsvLine(line);

            var instrumentName = Get(fields, instrumentNameIndex)?.Trim();
            if (!string.Equals(instrumentName, "INDEX", StringComparison.OrdinalIgnoreCase)) continue;

            var exchange = Get(fields, exchangeIndex)?.Trim();
            if (!string.Equals(exchange, "NSE", StringComparison.OrdinalIgnoreCase)) continue;

            var tradingSymbol = Get(fields, tradingSymbolIndex);
            var name = Get(fields, underlyingIndex);
            if (!NiftyAliases.Contains(tradingSymbol, StringComparer.OrdinalIgnoreCase) &&
                !NiftyAliases.Contains(name, StringComparer.OrdinalIgnoreCase))
                continue;

            if (!uint.TryParse(Get(fields, securityIdIndex), NumberStyles.Integer, CultureInfo.InvariantCulture, out var securityId))
                continue;

            return new DhanSpotInstrument(securityId, tradingSymbol ?? "NIFTY 50", name ?? "NIFTY 50", "IDX_I");
        }

        return null;
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
