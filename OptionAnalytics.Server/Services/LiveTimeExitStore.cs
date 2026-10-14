using System.Text.Json;

namespace OptionAnalytics.Server.Services;

/// <summary>A live trade the server closes itself at a set time (LiveTradingService.SetTimeExit) - the
/// strategy scanner's time stop / 15:10 square-off - whether or not any browser is open.</summary>
public sealed record LiveTimeExit(IReadOnlyList<string> OrderIds, DateTimeOffset ExitAt, decimal SlippagePoints, string Reason)
{
    /// <summary>Tries made so far (a failed exit is retried - LiveTradingService.TimeExitRetryInterval).</summary>
    public int Attempts { get; init; }

    /// <summary>Not tried again before this.</summary>
    public DateTimeOffset NextTry { get; init; }
}

/// <summary>
/// The scheduled time exits on disk, so a redeploy or restart during market hours does not drop them:
/// a small JSON file at Storage:LiveTimeExitsPath (env Storage__LiveTimeExitsPath; on the volume in
/// production - see docker-compose.yml), rewritten whole (temp file + move) on every change.
/// </summary>
public sealed class LiveTimeExitStore
{
    private static readonly JsonSerializerOptions JsonOptions = new() { WriteIndented = true };
    private readonly string _path;
    private readonly ILogger<LiveTimeExitStore> _logger;

    public LiveTimeExitStore(IHostEnvironment environment, IConfiguration configuration, ILogger<LiveTimeExitStore> logger)
    {
        var configured = configuration["Storage:LiveTimeExitsPath"];
        _path = string.IsNullOrWhiteSpace(configured) ? Path.Combine(environment.ContentRootPath, "live-time-exits.json") : configured;
        _logger = logger;
        var directory = Path.GetDirectoryName(_path);
        if (!string.IsNullOrEmpty(directory)) Directory.CreateDirectory(directory);
    }

    public IReadOnlyList<LiveTimeExit> Load()
    {
        try
        {
            return File.Exists(_path) ? JsonSerializer.Deserialize<List<LiveTimeExit>>(File.ReadAllText(_path)) ?? new() : new();
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Could not read the live time exits at {Path}.", _path);
            return new List<LiveTimeExit>();
        }
    }

    public void Save(IReadOnlyList<LiveTimeExit> exits)
    {
        try
        {
            var temp = _path + ".tmp";
            File.WriteAllText(temp, JsonSerializer.Serialize(exits, JsonOptions));
            File.Move(temp, _path, overwrite: true);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Could not save the live time exits to {Path}.", _path);
        }
    }
}
