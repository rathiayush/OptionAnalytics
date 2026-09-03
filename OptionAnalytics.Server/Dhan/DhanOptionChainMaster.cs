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

    /// <summary>Minimum gap between download attempts while the master is EMPTY. Without it, every
    /// caller of EnsureLoadedAsync re-downloads a multi-megabyte CSV on every call the moment the
    /// master has nothing in it (IsFresh is false with zero contracts by design), which turns a
    /// broken master into a download on every recenter AND every order attempt.</summary>
    private static readonly TimeSpan EmptyRetryInterval = TimeSpan.FromMinutes(1);
    private static readonly string[] Underlyings = { "NIFTY", "BANKNIFTY" };

    private readonly HttpClient _httpClient;
    private readonly DhanOptions _options;
    private readonly ILogger<DhanOptionChainMaster> _logger;
    private readonly SemaphoreSlim _loadLock = new(1, 1);

    private Dictionary<string, DhanOptionInstrument> _byKey = new(StringComparer.OrdinalIgnoreCase);
    private Dictionary<string, List<DateOnly>> _expiriesByUnderlying = new(StringComparer.OrdinalIgnoreCase);
    private DateTimeOffset _loadedAt = DateTimeOffset.MinValue;
    private DateTimeOffset _lastAttemptAt = DateTimeOffset.MinValue;

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
            if (_byKey.Count == 0 && DateTimeOffset.UtcNow - _lastAttemptAt < EmptyRetryInterval) return;
            _lastAttemptAt = DateTimeOffset.UtcNow;

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

    /// <summary>Forces an immediate re-download and re-parse, bypassing both the normal 12-hour
    /// cache (IsFresh) and the 1-minute empty-retry throttle - the Contracts page's manual "Refresh
    /// master" button, for exactly the situation that button exists to fix: the master reads as
    /// empty right now and the automatic retry hasn't caught up yet. Unlike EnsureLoadedAsync, this
    /// never rethrows - a download/parse failure is reported back to the caller as a plain string
    /// instead, since it is answering an HTTP request, not running unattended in a background
    /// loop.
    ///
    /// RefreshFromDhanAsync's own zero-row guard still applies underneath this - a parse that
    /// yields nothing still keeps whatever was loaded before rather than wiping it, this call just
    /// forces the ATTEMPT to happen right now instead of waiting.</summary>
    public async Task<(int ContractCount, DateTimeOffset? LoadedAt, string? Error)> ForceRefreshAsync(CancellationToken cancellationToken)
    {
        await _loadLock.WaitAsync(cancellationToken);
        try
        {
            string? error = null;
            try
            {
                await RefreshFromDhanAsync(cancellationToken);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                _logger.LogError(ex, "Manual scrip-master refresh failed.");
                error = ex.Message;
            }
            _lastAttemptAt = DateTimeOffset.UtcNow;

            if (error is null && _byKey.Count == 0)
                error = "Download succeeded but parsed to zero contracts - check the server log for \"Dhan scrip master parsed to ZERO\" to see which parse step dropped them.";

            var loadedAt = _loadedAt == DateTimeOffset.MinValue ? (DateTimeOffset?)null : _loadedAt;
            return (_byKey.Count, loadedAt, error);
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
        var (options, stats) = ParseOptionRows(stream);

        // A refresh that parses to NOTHING must never replace a master that works.
        //
        // This is the bug that took live trading down: the old code built the new dictionary FIRST
        // and assigned it unconditionally, so a 200 response that parsed to zero rows - Dhan
        // changing a column name, an error page served with a success status, a truncated body -
        // silently wiped a perfectly good in-memory chain. Nothing threw, so the catch in
        // EnsureLoadedAsync (which does preserve the old data) never ran. Every strike then read as
        // "not listed", every order was skipped, and the only visible symptom was orders quietly
        // not being placed.
        //
        // Keeping the previous copy is strictly better than an empty one: option contracts change
        // slowly, so yesterday's chain is nearly always right, whereas an empty one is certainly
        // wrong about everything.
        if (options.Count == 0)
        {
            _logger.LogError(
                "Dhan scrip master parsed to ZERO NIFTY/BANKNIFTY option contracts. {Stats} " +
                "{Action} Check whether {Url} still serves the expected CSV columns.",
                stats,
                _byKey.Count > 0
                    ? $"KEEPING the {_byKey.Count} contract(s) already loaded rather than wiping them."
                    : "Nothing was loaded before either, so no contract can be resolved and no order can be placed.",
                _options.ScripMasterUrl);
            return;
        }

        var byKey = new Dictionary<string, DhanOptionInstrument>(StringComparer.OrdinalIgnoreCase);
        var expiries = new Dictionary<string, SortedSet<DateOnly>>(StringComparer.OrdinalIgnoreCase);

        foreach (var option in options)
        {
            byKey[Key(option.Underlying, option.Expiry, option.Strike, option.IsCall)] = option;
            if (!expiries.TryGetValue(option.Underlying, out var set))
                expiries[option.Underlying] = set = new SortedSet<DateOnly>();
            set.Add(option.Expiry);
        }

        // Swapped in only once both are fully built, so a reader never sees a half-filled master.
        _byKey = byKey;
        _expiriesByUnderlying = expiries.ToDictionary(kv => kv.Key, kv => kv.Value.ToList(), StringComparer.OrdinalIgnoreCase);
        _loadedAt = DateTimeOffset.UtcNow;

        _logger.LogInformation("Option chain master ready: {Count} NIFTY/BANKNIFTY option contracts loaded. {Stats}", _byKey.Count, stats);
    }

    public IReadOnlyList<DateOnly> GetExpiries(string underlying) =>
        _expiriesByUnderlying.TryGetValue(underlying, out var list) ? list : Array.Empty<DateOnly>();

    /// <summary>The nearest (soonest) expiry that hasn't already passed <paramref name="asOf"/>.</summary>
    public DateOnly? GetNearestExpiry(string underlying, DateOnly asOf) =>
        GetExpiries(underlying).Where(e => e >= asOf).Cast<DateOnly?>().FirstOrDefault();

    /// <summary>Every contract this master holds for one underlying and expiry, strike order. What
    /// the contracts page lists - deliberately the MASTER's view rather than what CDV happens to
    /// track, because the question it answers is "does this app know these contracts exist at
    /// all", which is what silently stopped being true when a refresh wiped the master.</summary>
    public IReadOnlyList<DhanOptionInstrument> GetContracts(string underlying, DateOnly expiry) =>
        _byKey.Values
            .Where(o => string.Equals(o.Underlying, underlying, StringComparison.OrdinalIgnoreCase) && o.Expiry == expiry)
            .OrderBy(o => o.Strike)
            .ToList();

    /// <summary>The master's own health: how many contracts it holds, when it last loaded, and
    /// every expiry it lists. Zero contracts here is the failure that reads downstream as every
    /// strike being "not listed" - see RefreshFromDhanAsync.</summary>
    public (int ContractCount, DateTimeOffset? LoadedAt, IReadOnlyList<string> Underlyings) Status()
    {
        var loaded = _loadedAt == DateTimeOffset.MinValue ? (DateTimeOffset?)null : _loadedAt;
        return (_byKey.Count, loaded, _expiriesByUnderlying.Keys.OrderBy(k => k).ToList());
    }

    public DhanOptionInstrument? Find(string underlying, DateOnly expiry, decimal strike, bool isCall) =>
        _byKey.TryGetValue(Key(underlying, expiry, strike, isCall), out var match) ? match : null;

    /// <summary>What IS listed near a strike that Find could not resolve, as one log-ready line.
    /// A "not listed" answer is otherwise unfalsifiable from the outside: it cannot distinguish a
    /// genuinely absent contract from a stale scrip master, a wrong expiry, or rows this parser
    /// dropped (it skips any row whose lot size will not parse - see ParseOptionRows). Naming the
    /// nearest strikes it DOES have, and how many contracts that expiry holds at all, turns the
    /// next occurrence into a diagnosis instead of a guess.</summary>
    public string DescribeNearestListed(string underlying, DateOnly expiry, decimal strike, bool isCall)
    {
        var side = isCall ? "CE" : "PE";
        var onExpiry = _byKey.Values
            .Where(o => string.Equals(o.Underlying, underlying, StringComparison.OrdinalIgnoreCase)
                && o.Expiry == expiry && o.IsCall == isCall)
            .Select(o => o.Strike)
            .ToList();

        if (onExpiry.Count == 0)
        {
            var expiries = GetExpiries(underlying);
            return $"no {side} contracts at all are loaded for {underlying} on {expiry:yyyy-MM-dd}; " +
                $"the master holds {_byKey.Count} contract(s) and lists expiries [{string.Join(", ", expiries.Take(6).Select(e => e.ToString("yyyy-MM-dd")))}]";
        }

        var nearest = onExpiry.OrderBy(s => Math.Abs(s - strike)).Take(5).OrderBy(s => s);
        return $"{onExpiry.Count} {side} strike(s) are loaded for {underlying} {expiry:yyyy-MM-dd}, " +
            $"nearest to {strike:0.##}: [{string.Join(", ", nearest.Select(v => v.ToString("0.##")))}]";
    }

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

    /// <summary>Why rows did not survive the parse. Every filter below is a legitimate reason to
    /// drop a row on a healthy download (most rows are not NIFTY/BANKNIFTY index options at all),
    /// so these numbers mean nothing in the happy path - but when the parse yields ZERO they say
    /// exactly WHICH step ate everything, which is the difference between "Dhan renamed a column"
    /// and "we downloaded an error page".</summary>
    private sealed class ParseStats
    {
        public int DataRows;
        public int OptIdxRows;
        public int MatchedUnderlying;
        public int DroppedSecurityId;
        public int DroppedExpiry;
        public int DroppedOptionType;
        public int DroppedStrike;
        public int DroppedLotSize;
        public int Kept;

        public override string ToString() =>
            $"Read {DataRows} data row(s): {OptIdxRows} OPTIDX, {MatchedUnderlying} on NIFTY/BANKNIFTY, kept {Kept}. " +
            $"Dropped - securityId {DroppedSecurityId}, expiry {DroppedExpiry}, optionType {DroppedOptionType}, " +
            $"strike {DroppedStrike}, lotSize {DroppedLotSize}.";
    }

    private (List<DhanOptionInstrument> Options, ParseStats Stats) ParseOptionRows(Stream stream)
    {
        var options = new List<DhanOptionInstrument>();
        var stats = new ParseStats();
        using var reader = new StreamReader(stream);

        var headerLine = reader.ReadLine();
        if (headerLine is null)
        {
            _logger.LogError("Dhan scrip master at {Url} returned an empty body - no header row.", _options.ScripMasterUrl);
            return (options, stats);
        }

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
            return (options, stats);
        }

        string? line;
        while ((line = reader.ReadLine()) is not null)
        {
            if (line.Length == 0) continue;
            stats.DataRows++;
            var fields = SplitCsvLine(line);

            var instrumentName = Get(fields, instrumentNameIndex)?.Trim();
            if (!string.Equals(instrumentName, "OPTIDX", StringComparison.OrdinalIgnoreCase)) continue;
            stats.OptIdxRows++;

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
            stats.MatchedUnderlying++;

            if (!uint.TryParse(Get(fields, securityIdIndex), NumberStyles.Integer, CultureInfo.InvariantCulture, out var securityId))
            {
                stats.DroppedSecurityId++;
                continue;
            }

            var expiry = ParseExpiry(Get(fields, expiryIndex));
            if (expiry is null)
            {
                stats.DroppedExpiry++;
                continue;
            }

            var optionType = Get(fields, optionTypeIndex)?.Trim().ToUpperInvariant();
            if (optionType is not ("CE" or "PE"))
            {
                stats.DroppedOptionType++;
                continue;
            }

            var strike = ParseDecimal(Get(fields, strikeIndex));
            if (strike <= 0)
            {
                stats.DroppedStrike++;
                continue;
            }

            // A lot size that fails to parse would silently place an order in raw units instead
            // of lots - too dangerous to default; skip the row instead (same "no data" tolerance
            // as everywhere else in this backfill, just applied to a column not read before).
            var lotSize = (int)ParseDecimal(Get(fields, lotSizeIndex));
            if (lotSize <= 0)
            {
                stats.DroppedLotSize++;
                continue;
            }
            var tickSize = ParseDecimal(Get(fields, tickSizeIndex));

            options.Add(new DhanOptionInstrument(securityId, tradingSymbol, underlying, expiry.Value, strike, optionType == "CE", "NSE_FNO", lotSize, tickSize));
            stats.Kept++;
        }

        return (options, stats);
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
