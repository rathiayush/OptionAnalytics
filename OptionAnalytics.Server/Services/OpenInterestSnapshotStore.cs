using System.Globalization;
using System.Text.Json;
using OptionAnalytics.Server.Models;

namespace OptionAnalytics.Server.Services;

/// <summary>
/// On-disk record of each morning's OI baseline, one plain CSV per underlying/expiry/day - same
/// "no db, plain CSV + meta.json sidecar" convention as HistoricalSpotDataStore/ExpiredOptionDataStore.
/// This is what makes the baseline survive a Dokploy redeploy landing mid-morning: OpenInterestHostedService
/// checks here before deciding it needs to capture a fresh one, and today's file (once written) is
/// never overwritten again that same day.
///
/// Only the BASELINE is persisted. The CURRENT snapshot is a live number that only means anything a
/// few seconds old, so OpenInterestHostedService keeps it in memory only - persisting it would just
/// be a slower, staler copy of what a live Dhan call already gives it every poll.
///
/// A useful side effect: once this has accumulated enough days, it becomes the seed for a real
/// historical OI series - something Dhan's own API can never provide (see DhanOptionChainQuotes) -
/// which is what would eventually let an OI-based strategy be backtested rather than live-only.
/// </summary>
public sealed class OpenInterestSnapshotStore
{
    private static readonly JsonSerializerOptions JsonOptions = new() { WriteIndented = true };

    private readonly string _directory;
    private readonly ILogger<OpenInterestSnapshotStore> _logger;

    public OpenInterestSnapshotStore(IHostEnvironment environment, IConfiguration configuration, ILogger<OpenInterestSnapshotStore> logger)
    {
        // Same convention as HistoricalSpotDataStore's own Storage:HistoricalDataPath - a rooted
        // override (docker-compose's mounted volume) wins outright, a relative one (or the plain
        // "open-interest" default) resolves next to the app.
        var configured = configuration["Storage:OpenInterestPath"];
        var relativeOrAbsolute = string.IsNullOrWhiteSpace(configured) ? "open-interest" : configured;
        _directory = Path.IsPathRooted(relativeOrAbsolute)
            ? relativeOrAbsolute
            : Path.Combine(environment.ContentRootPath, relativeOrAbsolute);
        _logger = logger;

        Directory.CreateDirectory(_directory);
    }

    private static string Slug(string underlying, DateOnly expiry, DateOnly day) =>
        $"{underlying.ToUpperInvariant()}_{expiry:yyyyMMdd}_{day:yyyyMMdd}_oi_baseline";

    private string CsvPath(string underlying, DateOnly expiry, DateOnly day) => Path.Combine(_directory, $"{Slug(underlying, expiry, day)}.csv");
    private string MetaPath(string underlying, DateOnly expiry, DateOnly day) => Path.Combine(_directory, $"{Slug(underlying, expiry, day)}.meta.json");

    private sealed record Meta(DateTimeOffset CapturedAtUtc);

    /// <summary>True once today's baseline for this underlying/expiry has already been captured and
    /// fully written - what stops OpenInterestHostedService from re-capturing (and overwriting a
    /// morning's true opening OI with a later, already-moved number) on every poll, and from
    /// re-capturing at all after a mid-day restart.</summary>
    public bool HasBaseline(string underlying, DateOnly expiry, DateOnly day) => File.Exists(MetaPath(underlying, expiry, day));

    /// <summary>Loads today's already-captured baseline, or null if none exists yet (see
    /// HasBaseline). Missing/corrupt rows are skipped rather than failing the whole load - the same
    /// tolerance HistoricalSpotDataStore.Read applies to its own CSV.</summary>
    public (DateTimeOffset CapturedAtUtc, IReadOnlyDictionary<decimal, OiStrikeSnapshot> Baseline)? Load(string underlying, DateOnly expiry, DateOnly day)
    {
        var metaPath = MetaPath(underlying, expiry, day);
        if (!File.Exists(metaPath)) return null;

        Meta? meta;
        try
        {
            meta = JsonSerializer.Deserialize<Meta>(File.ReadAllText(metaPath));
        }
        catch (Exception ex) when (ex is JsonException or IOException)
        {
            _logger.LogWarning(ex, "Could not read {Path} - treating {Underlying}/{Expiry}'s OI baseline for {Day} as absent.", metaPath, underlying, expiry, day);
            return null;
        }
        if (meta is null) return null;

        var csvPath = CsvPath(underlying, expiry, day);
        if (!File.Exists(csvPath)) return null;

        var baseline = new Dictionary<decimal, OiStrikeSnapshot>();
        using (var reader = new StreamReader(csvPath))
        {
            reader.ReadLine(); // header
            string? line;
            while ((line = reader.ReadLine()) is not null)
            {
                if (line.Length == 0) continue;
                var parts = line.Split(',');
                if (parts.Length != 5) continue;
                if (!decimal.TryParse(parts[0], NumberStyles.Float, CultureInfo.InvariantCulture, out var strike)) continue;

                baseline[strike] = new OiStrikeSnapshot(
                    ParseNullableLong(parts[1]), ParseNullableDecimal(parts[2]),
                    ParseNullableLong(parts[3]), ParseNullableDecimal(parts[4]));
            }
        }

        return (meta.CapturedAtUtc, baseline);
    }

    /// <summary>Writes today's baseline - CSV first, meta only once that succeeds, same crash-safety
    /// ordering as HistoricalSpotDataStore.SaveAsync so a process killed mid-write never leaves
    /// behind a meta file claiming a baseline the CSV doesn't actually have.</summary>
    public async Task SaveAsync(string underlying, DateOnly expiry, DateOnly day, DateTimeOffset capturedAtUtc, IReadOnlyDictionary<decimal, OiStrikeSnapshot> baseline, CancellationToken cancellationToken)
    {
        var csvPath = CsvPath(underlying, expiry, day);
        var tempPath = csvPath + ".tmp";

        await using (var writer = new StreamWriter(tempPath, append: false))
        {
            await writer.WriteLineAsync("Strike,CeOpenInterest,CePremium,PeOpenInterest,PePremium");
            foreach (var (strike, snap) in baseline.OrderBy(kv => kv.Key))
            {
                await writer.WriteLineAsync(string.Join(',',
                    strike.ToString(CultureInfo.InvariantCulture),
                    FormatNullable(snap.CeOpenInterest),
                    FormatNullable(snap.CePremium),
                    FormatNullable(snap.PeOpenInterest),
                    FormatNullable(snap.PePremium)));
            }
        }

        File.Move(tempPath, csvPath, overwrite: true);

        var meta = new Meta(capturedAtUtc);
        await File.WriteAllTextAsync(MetaPath(underlying, expiry, day), JsonSerializer.Serialize(meta, JsonOptions), cancellationToken);

        _logger.LogInformation("Captured this morning's OI baseline for {Underlying} {Expiry}: {Count} strike(s) at {CapturedAt:u}.", underlying, expiry, baseline.Count, capturedAtUtc);
    }

    private static string FormatNullable(long? value) => value?.ToString(CultureInfo.InvariantCulture) ?? "";
    private static string FormatNullable(decimal? value) => value?.ToString(CultureInfo.InvariantCulture) ?? "";
    private static long? ParseNullableLong(string s) => long.TryParse(s, NumberStyles.Integer, CultureInfo.InvariantCulture, out var v) ? v : null;
    private static decimal? ParseNullableDecimal(string s) => decimal.TryParse(s, NumberStyles.Float, CultureInfo.InvariantCulture, out var v) ? v : null;
}
