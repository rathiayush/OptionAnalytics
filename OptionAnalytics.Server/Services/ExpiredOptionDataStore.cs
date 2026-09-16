using System.Globalization;
using System.Text.Json;
using OptionAnalytics.Server.Models;

namespace OptionAnalytics.Server.Services;

/// <summary>
/// On-disk cache of raw rolling-option bars, one plain CSV per real expiry contract (see
/// ExpiredOptionDataPrefetchHostedService for what fills it) - the option-premium counterpart to
/// HistoricalSpotDataStore's own spot cache, at the same user request ("i do not need db okay").
///
/// ONE FILE PER (underlying, expiryFlag, expiryDate) - not per strike/side - covering every token
/// in the fetched band (ATM+-FlowChainRadius) and both CALL/PUT sides together, distinguished by the
/// StrikeToken/OptionType columns. This is deliberately the SAME granularity
/// ExpiredOptionBacktestService.FetchAcrossSegmentsAsync fetches at (one whole contract's worth of
/// data per token/side), so a cache hit there is a straight file read with no re-assembly.
///
/// WHAT "one contract's own data" MEANS, and why a cache keyed this way covers any narrower live
/// request for the same contract: every FetchSegment ExpiredOptionBacktestService.BuildFetchSegments
/// produces has a `.To` that IS the real expiry date the segment's data belongs to (segment 1's own
/// `.To` is always the target expiry itself; segment 2's is always the PRIOR same-cadence expiry) -
/// so caching this class's own [FromDay,ToDay] range as "that contract's entire natural single-
/// segment life" (from just after the previous same-cadence expiry through this one) is a strict
/// superset of any live segment's own narrower [From,To] window for the same target, and multiple
/// contracts compose to cover a multi-segment request the exact same way FetchAcrossSegmentsAsync's
/// own segment loop does live.
///
/// A small sidecar ".meta.json" per contract records exactly which [FromDay,ToDay] window the CSV
/// covers, written only after the CSV itself is fully written - same completeness-guard convention
/// as HistoricalSpotDataStore's own meta file.
/// </summary>
public sealed class ExpiredOptionDataStore
{
    private static readonly JsonSerializerOptions JsonOptions = new() { WriteIndented = true };
    private const string TimeFormat = "yyyy-MM-ddTHH:mm:sszzz";

    private readonly string _directory;
    private readonly ILogger<ExpiredOptionDataStore> _logger;

    public ExpiredOptionDataStore(IHostEnvironment environment, IConfiguration configuration, ILogger<ExpiredOptionDataStore> logger)
    {
        // Same convention as HistoricalSpotDataStore's own path resolution - Storage:ExpiredOptionDataPath
        // (env var Storage__ExpiredOptionDataPath) points this at the mounted volume in production;
        // a relative default resolves next to the app for a local run either way.
        var configured = configuration["Storage:ExpiredOptionDataPath"];
        var relativeOrAbsolute = string.IsNullOrWhiteSpace(configured) ? "expired-option-data" : configured;
        _directory = Path.IsPathRooted(relativeOrAbsolute)
            ? relativeOrAbsolute
            : Path.Combine(environment.ContentRootPath, relativeOrAbsolute);
        _logger = logger;

        Directory.CreateDirectory(_directory);
    }

    private static string ContractKey(string underlying, string expiryFlag, DateOnly expiryDate) =>
        $"{underlying.ToUpperInvariant()}_{expiryFlag.ToUpperInvariant()}_{expiryDate:yyyy-MM-dd}";

    private string CsvPath(string underlying, string expiryFlag, DateOnly expiryDate) =>
        Path.Combine(_directory, $"{ContractKey(underlying, expiryFlag, expiryDate)}.csv");

    private string MetaPath(string underlying, string expiryFlag, DateOnly expiryDate) =>
        Path.Combine(_directory, $"{ContractKey(underlying, expiryFlag, expiryDate)}.meta.json");

    private sealed record Meta(DateOnly FromDay, DateOnly ToDay, DateTimeOffset FetchedAtUtc);

    /// <summary>True when a previous prefetch already wrote this exact contract's own CSV - the
    /// guard ExpiredOptionDataPrefetchHostedService uses to skip a contract it already has, and
    /// ExpiredOptionBacktestService.FetchAcrossSegmentsAsync uses to decide whether a given segment
    /// can be served from disk instead of a live Dhan call.</summary>
    public bool HasContract(string underlying, string expiryFlag, DateOnly expiryDate) =>
        ReadMeta(underlying, expiryFlag, expiryDate) is not null;

    private Meta? ReadMeta(string underlying, string expiryFlag, DateOnly expiryDate)
    {
        var path = MetaPath(underlying, expiryFlag, expiryDate);
        if (!File.Exists(path)) return null;

        try
        {
            return JsonSerializer.Deserialize<Meta>(File.ReadAllText(path));
        }
        catch (Exception ex) when (ex is JsonException or IOException)
        {
            _logger.LogWarning(ex, "Could not read {Path} - treating {Key} as not cached.", path, ContractKey(underlying, expiryFlag, expiryDate));
            return null;
        }
    }

    /// <summary>Every cached bar for one token/side within a contract's own file, clipped to
    /// [fromDay,toDay] (IST calendar dates, both inclusive) - the same clipping
    /// DhanRollingOptionDataService.ClipToRange applies to a live fetch, so a cache hit behaves
    /// identically to the live call it replaces. Callers should check HasContract first; this
    /// returns empty if the file itself is missing.</summary>
    public IReadOnlyList<(CandleWithVolume Bar, decimal? Strike, decimal? Spot)> Read(
        string underlying, string expiryFlag, DateOnly expiryDate, string strikeToken, string optionType, DateOnly fromDay, DateOnly toDay)
    {
        var path = CsvPath(underlying, expiryFlag, expiryDate);
        if (!File.Exists(path)) return Array.Empty<(CandleWithVolume, decimal?, decimal?)>();

        var result = new List<(CandleWithVolume Bar, decimal? Strike, decimal? Spot)>();
        using var reader = new StreamReader(path);
        reader.ReadLine(); // header

        string? line;
        while ((line = reader.ReadLine()) is not null)
        {
            if (line.Length == 0) continue;
            var parts = line.Split(',');
            if (parts.Length != 9) continue;
            if (!string.Equals(parts[0], strikeToken, StringComparison.OrdinalIgnoreCase)) continue;
            if (!string.Equals(parts[1], optionType, StringComparison.OrdinalIgnoreCase)) continue;

            if (!DateTimeOffset.TryParseExact(parts[2], TimeFormat, CultureInfo.InvariantCulture, DateTimeStyles.None, out var time))
                continue;

            var day = IstClock.IstDate(time);
            if (day < fromDay || day > toDay) continue;

            var bar = new CandleWithVolume(
                time,
                decimal.Parse(parts[3], CultureInfo.InvariantCulture),
                decimal.Parse(parts[4], CultureInfo.InvariantCulture),
                decimal.Parse(parts[5], CultureInfo.InvariantCulture),
                decimal.Parse(parts[6], CultureInfo.InvariantCulture),
                long.Parse(parts[7], CultureInfo.InvariantCulture));
            var strike = parts[8].Length > 0 ? decimal.Parse(parts[8], CultureInfo.InvariantCulture) : (decimal?)null;
            // Spot is intentionally not persisted (see SaveAsync's own doc comment) - callers that
            // need it fall back to null exactly like a live bar whose own response omitted it does.
            result.Add((bar, strike, null));
        }

        return result;
    }

    /// <summary>Overwrites this contract's whole CSV with every token/side member's own bars
    /// (assumed already time-ascending within each member) and only then writes the meta file
    /// recording [fromDay,toDay] as covered - same ordering guarantee as HistoricalSpotDataStore's
    /// own SaveAsync, for the same reason (a process killed mid-write must never leave a meta file
    /// claiming coverage the CSV does not actually have).
    ///
    /// Spot is deliberately NOT persisted, only Strike: FilterToExpectedStrike (the one reader of a
    /// bar's own Spot) already falls back to matching against a separately fetched spot series when
    /// Spot is null, exactly the behavior a cached bar gets here - and dropping it keeps the CSV
    /// roughly a third smaller across the sheer volume this store holds (a full year across every
    /// expiry and the whole ATM+-10 band) for a value nothing else in this app ever reads back
    /// out.</summary>
    public async Task SaveAsync(
        string underlying, string expiryFlag, DateOnly expiryDate, DateOnly fromDay, DateOnly toDay,
        IReadOnlyList<(string StrikeToken, string OptionType, IReadOnlyList<(CandleWithVolume Bar, decimal? Strike, decimal? Spot)> Bars)> members,
        CancellationToken cancellationToken)
    {
        var csvPath = CsvPath(underlying, expiryFlag, expiryDate);
        var tempPath = csvPath + ".tmp";

        await using (var writer = new StreamWriter(tempPath, append: false))
        {
            await writer.WriteLineAsync("StrikeToken,OptionType,TimeUtc,Open,High,Low,Close,Volume,Strike");
            foreach (var member in members)
            {
                foreach (var (bar, strike, _) in member.Bars)
                {
                    await writer.WriteLineAsync(string.Join(',',
                        member.StrikeToken,
                        member.OptionType,
                        bar.Time.ToString(TimeFormat, CultureInfo.InvariantCulture),
                        bar.Open.ToString(CultureInfo.InvariantCulture),
                        bar.High.ToString(CultureInfo.InvariantCulture),
                        bar.Low.ToString(CultureInfo.InvariantCulture),
                        bar.Close.ToString(CultureInfo.InvariantCulture),
                        bar.Volume.ToString(CultureInfo.InvariantCulture),
                        strike?.ToString(CultureInfo.InvariantCulture) ?? ""));
                }
            }
        }

        File.Move(tempPath, csvPath, overwrite: true);

        var meta = new Meta(fromDay, toDay, DateTimeOffset.UtcNow);
        await File.WriteAllTextAsync(MetaPath(underlying, expiryFlag, expiryDate), JsonSerializer.Serialize(meta, JsonOptions), cancellationToken);

        var totalBars = members.Sum(m => m.Bars.Count);
        _logger.LogInformation("Saved {Count} cached rolling-option bar(s) across {Members} token/side member(s) for {Key} ({From}..{To}) to {Path}.",
            totalBars, members.Count, ContractKey(underlying, expiryFlag, expiryDate), fromDay, toDay, csvPath);
    }
}
