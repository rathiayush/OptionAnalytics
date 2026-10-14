using System.Diagnostics;
using System.Reflection;
using Microsoft.AspNetCore.DataProtection.KeyManagement;
using Microsoft.AspNetCore.Mvc;
using OptionAnalytics.Server.Dhan;

namespace OptionAnalytics.Server.Controllers;

/// <summary>What is deployed and whether logins survive a redeploy - shown in the app's header so
/// "when did this last deploy" and "why was I logged out" have answers on screen.
///
/// Logins survive a redeploy only if the Data Protection key ring that signs the login cookie is
/// kept on a volume that outlives the container (see Program.cs / Storage:DataProtectionKeysPath).
/// The key ring is created the first time a cookie is issued or read, so if its oldest key is
/// NEWER than this server process, the keys were generated at this start - every login issued
/// before the restart stopped working. Requires a signed-in user (Program.cs's fallback policy).</summary>
[ApiController]
[Route("api/system")]
public sealed class SystemController : ControllerBase
{
    private static readonly DateTimeOffset StartedUtc = new(Process.GetCurrentProcess().StartTime.ToUniversalTime());

    private readonly IKeyManager _keyManager;
    private readonly DhanMarketFeedClient _feedClient;

    public SystemController(IKeyManager keyManager, DhanMarketFeedClient feedClient)
    {
        _keyManager = keyManager;
        _feedClient = feedClient;
    }

    /// <summary>Feed: how each live-tick consumer (Spot, CDV, OI Replay) is keeping up over roughly
    /// the last minute - see TickConsumerStats. The header turns this into a "Feed OK / behind" tag.</summary>
    public sealed record SystemInfo(
        string? BuildTimeUtc,
        DateTimeOffset StartedUtc,
        DateTimeOffset? LoginKeysCreatedUtc,
        bool? LoginsSurviveRestart,
        int SubscribedInstruments,
        IReadOnlyList<TickConsumerStats> Feed);

    [HttpGet("info")]
    public SystemInfo Info()
    {
        var buildTimeUtc = Assembly.GetExecutingAssembly()
            .GetCustomAttributes<AssemblyMetadataAttribute>()
            .FirstOrDefault(a => a.Key == "BuildTimeUtc")?.Value;
        DateTimeOffset? oldestKey = null;
        try
        {
            var keys = _keyManager.GetAllKeys();
            if (keys.Count > 0) oldestKey = keys.Min(k => k.CreationDate);
        }
        catch
        {
            // Diagnostics only - an unreadable key ring just means "unknown" here.
        }
        return new SystemInfo(buildTimeUtc, StartedUtc, oldestKey, LoginsSurvivedRestart(oldestKey, StartedUtc),
            _feedClient.SubscribedCount, _feedClient.GetConsumerStats());
    }

    /// <summary>True when the key ring predates this process (it was loaded from storage, so logins
    /// issued before the restart still work); false when it was generated after the process started;
    /// null when there is no key yet. A minute of slack covers clock skew around process start.</summary>
    internal static bool? LoginsSurvivedRestart(DateTimeOffset? oldestKeyCreatedUtc, DateTimeOffset processStartedUtc) =>
        oldestKeyCreatedUtc is null ? null : oldestKeyCreatedUtc < processStartedUtc - TimeSpan.FromMinutes(1);
}
