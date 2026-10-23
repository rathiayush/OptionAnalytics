using System.Diagnostics;
using System.Reflection;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.DataProtection.KeyManagement;
using Microsoft.AspNetCore.Mvc;
using OptionAnalytics.Server.Auth;
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
    private readonly DhanRestRateLimiter _dhanLimiter;

    public SystemController(IKeyManager keyManager, DhanMarketFeedClient feedClient, DhanRestRateLimiter dhanLimiter)
    {
        _keyManager = keyManager;
        _feedClient = feedClient;
        _dhanLimiter = dhanLimiter;
    }

    public sealed record DhanCallsByEndpoint(string Category, string Method, string Path, int LastMinute, int Last15Minutes, int Failed);
    public sealed record DhanRepeatedCall(string Context, int Times, int Failed, string? LastError, DateTimeOffset LastAt);
    public sealed record DhanCallsReport(int LastMinute, int Last15Minutes, IReadOnlyList<DhanCallsByEndpoint> Endpoints, IReadOnlyList<DhanRepeatedCall> Repeated);

    /// <summary>What this server sent to Dhan's REST API in the last 15 minutes (every attempt): per endpoint, and the
    /// same request asked 3+ times - a loop shows here (DhanRestRateLimiter's call log).</summary>
    [HttpGet("dhan-calls")]
    [Authorize(Roles = AuthRoles.Admin)]
    public DhanCallsReport DhanCalls() => DhanCallsReportOf(_dhanLimiter.RecentCalls(), DateTimeOffset.UtcNow);

    internal static DhanCallsReport DhanCallsReportOf(IReadOnlyList<DhanRestRateLimiter.DhanCall> calls, DateTimeOffset now)
    {
        var minuteAgo = now - TimeSpan.FromMinutes(1);
        var endpoints = calls.GroupBy(c => (c.Category, c.Method, c.Path))
            .Select(g => new DhanCallsByEndpoint(g.Key.Category.ToString(), g.Key.Method, g.Key.Path, g.Count(c => c.At >= minuteAgo), g.Count(), g.Count(c => !c.Success)))
            .OrderByDescending(e => e.Last15Minutes).ToList();
        var repeated = calls.GroupBy(c => c.Context).Where(g => g.Count() >= 3)
            .Select(g => new DhanRepeatedCall(g.Key, g.Count(), g.Count(c => !c.Success), g.LastOrDefault(c => !c.Success)?.Error, g.Max(c => c.At)))
            .OrderByDescending(r => r.Times).Take(50).ToList();
        return new DhanCallsReport(calls.Count(c => c.At >= minuteAgo), calls.Count, endpoints, repeated);
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
