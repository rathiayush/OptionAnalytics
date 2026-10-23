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

    public sealed record DhanCallsByEndpoint(string Category, string Method, string Path, int LastMinute, int Last15Minutes, int LastHour, int Failed);
    public sealed record DhanRepeatedCall(string Context, int Times, int Failed, string? LastError, DateTimeOffset LastAt);
    public sealed record DhanCallEntry(DateTimeOffset At, string Category, string Method, string Path, string Context, bool Success, int Status,
        string? Error, string? ErrorCode, string? Body, string? Response, double DurationMs, string? Diagnosis);
    public sealed record DhanCallsReport(int LastMinute, int Last15Minutes, int LastHour, int Failed, IReadOnlyList<DhanCallsByEndpoint> Endpoints,
        IReadOnlyList<DhanRepeatedCall> Repeated, IReadOnlyList<DhanCallEntry> Recent);

    /// <summary>What this server sent to Dhan's REST API in the last hour (every attempt, up to 5,000): per endpoint, the
    /// same request asked 3+ times (a loop shows here), and each call - newest first, with its payload as sent, a failed
    /// call's answer exactly as Dhan sent it (errorCode, errorMessage ...) and a likely cause (DhanRestRateLimiter's call
    /// log). The Dhan calls page shows it and filters it.</summary>
    [HttpGet("dhan-calls")]
    [Authorize(Roles = AuthRoles.Admin)]
    public DhanCallsReport DhanCalls() => DhanCallsReportOf(_dhanLimiter.RecentCalls(), DateTimeOffset.UtcNow);

    internal static DhanCallsReport DhanCallsReportOf(IReadOnlyList<DhanRestRateLimiter.DhanCall> calls, DateTimeOffset now)
    {
        var minuteAgo = now - TimeSpan.FromMinutes(1);
        var quarterAgo = now - TimeSpan.FromMinutes(15);
        var endpoints = calls.GroupBy(c => (c.Category, c.Method, c.Path))
            .Select(g => new DhanCallsByEndpoint(g.Key.Category.ToString(), g.Key.Method, g.Key.Path, g.Count(c => c.At >= minuteAgo), g.Count(c => c.At >= quarterAgo), g.Count(), g.Count(c => !c.Success)))
            .OrderByDescending(e => e.LastHour).ToList();
        var repeated = calls.GroupBy(c => c.Context).Where(g => g.Count() >= 3)
            .Select(g => new DhanRepeatedCall(g.Key, g.Count(), g.Count(c => !c.Success), g.LastOrDefault(c => !c.Success)?.Error, g.Max(c => c.At)))
            .OrderByDescending(r => r.Times).Take(50).ToList();
        var recent = calls.OrderByDescending(c => c.At)
            .Select(c => new DhanCallEntry(c.At, c.Category.ToString(), c.Method, c.Path, c.Context, c.Success, c.Status, c.Error,
                Field(c.Response, "errorCode"), c.Body, c.Response, Math.Round(c.DurationMs), c.Success ? null : Diagnose(c, now)))
            .ToList();
        return new DhanCallsReport(calls.Count(c => c.At >= minuteAgo), calls.Count(c => c.At >= quarterAgo), calls.Count, calls.Count(c => !c.Success), endpoints, repeated, recent);
    }

    /// <summary>The likely cause of a failed Dhan call, read from its answer and body - or null when nothing stands out.</summary>
    internal static string? Diagnose(DhanRestRateLimiter.DhanCall call, DateTimeOffset now)
    {
        var error = call.Error ?? "";
        bool Has(string s) => error.Contains(s, StringComparison.OrdinalIgnoreCase);
        if (call.Status == 429 || Has("DH-904") || Has("too many") || Has("Not sent:"))
            return "Rate limit - Dhan allows 5 data calls a second, 10 orders a second for the whole account (or this server held the call back).";
        if (Has("806")) return "Data API plan not active on this Dhan account.";
        if (Has("807") || Has("808") || Has("809") || Has("DH-901") || Has("Invalid Token") || call.Status is 401 or 403)
            return "Access token expired or invalid - it lasts 24 hours; renew it (TOTP auto-renewal or a new token).";
        if (Has("no answer")) return "Dhan did not answer in time (20 s for a data call) - slow or unreachable.";
        if (Has("DH-905") || Has("Input_Exception"))
        {
            var ist = now.ToOffset(IstClock.Offset);
            var toDate = Field(call.Body, "toDate");
            if (toDate is not null && DateTime.TryParse(toDate, System.Globalization.CultureInfo.InvariantCulture, System.Globalization.DateTimeStyles.None, out var to))
            {
                var dateOnly = toDate.Length <= 10;
                if (dateOnly ? DateOnly.FromDateTime(to) > DateOnly.FromDateTime(ist.DateTime) : to > ist.DateTime)
                    return $"toDate {toDate} is in the future (now {ist:yyyy-MM-dd HH:mm} IST) - Dhan refuses a range that ends after now.";
            }
            var fromDate = Field(call.Body, "fromDate");
            if (fromDate is not null && DateTime.TryParse(fromDate, System.Globalization.CultureInfo.InvariantCulture, System.Globalization.DateTimeStyles.None, out var from)
                && (from.DayOfWeek is DayOfWeek.Saturday or DayOfWeek.Sunday) && (toDate is null || toDate[..Math.Min(10, toDate.Length)] == fromDate[..Math.Min(10, fromDate.Length)] || call.Path.Contains("rollingoption")))
                return $"fromDate {fromDate} is a weekend - Dhan has no data for it and answers DH-905.";
            if (call.Path.Contains("rollingoption") && Field(call.Body, "strike") is { } strike
                && int.TryParse(strike.Replace("ATM", "").Replace("+", ""), out var steps) && Math.Abs(steps) > 3 && Field(call.Body, "expiryCode") is { } code && code != "1")
                return $"Strike {strike} with expiryCode {code}: Dhan allows ATM±10 only for the near expiry, ATM±3 otherwise.";
            return "Dhan refused the request (DH-905) and nothing in the payload stands out (a trading day, no future toDate). Dhan also answers DH-905 "
                + "when it has no data for the range, and accounts with active plans got it on every chart call until Dhan support fixed it on their "
                + "side - send Dhan support this call (Copy for Dhan support).";
        }
        return null;
    }

    private static string? Field(string? body, string name)
    {
        if (string.IsNullOrEmpty(body)) return null;
        try
        {
            using var doc = System.Text.Json.JsonDocument.Parse(body);
            return doc.RootElement.ValueKind == System.Text.Json.JsonValueKind.Object && doc.RootElement.TryGetProperty(name, out var v) ? v.ToString() : null;
        }
        catch (System.Text.Json.JsonException) { return null; }
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
