namespace OptionAnalytics.Server.Services;

/// <summary>
/// When this server's background work may call Dhan: IST weekdays 09:00 - 16:00 (the session with the pre-open before it
/// and the square-off / settling after it). Outside it nothing polls Dhan - no positions, orders, option chain, candles or
/// anything else - and the websocket feeds do not (re)connect: the market is shut, so nothing new would come back.
///
/// Two layers:
///  - each polling loop waits for the window (WaitForOpenAsync) or skips its round (IsOpen), so it does not spin;
///  - the safety net: work running in a BackgroundScope (every hosted service's loop, the server scanner's requests) has
///    its Dhan REST calls refused, NOT sent, outside the window (DhanApiClient) - so a loop added later is covered too.
/// A request a person makes from a page is not background and still goes to Dhan at any hour. Dhan token renewal
/// (DhanTotpAuthService) has its own HttpClient and keeps running overnight, so the session is valid at the open.
/// </summary>
public static class MarketHours
{
    public static readonly TimeSpan Opens = new(9, 0, 0);
    public static readonly TimeSpan Closes = new(16, 0, 0);

    public static DateTimeOffset Now => DateTimeOffset.UtcNow;

    /// <summary>Whether `now` is in the window: an IST weekday, 09:00 to 16:00.</summary>
    public static bool IsOpen(DateTimeOffset now)
    {
        var ist = now.ToOffset(IstClock.Offset);
        if (ist.DayOfWeek is DayOfWeek.Saturday or DayOfWeek.Sunday) return false;
        return ist.TimeOfDay >= Opens && ist.TimeOfDay < Closes;
    }

    public static bool IsOpenNow => IsOpen(Now);

    /// <summary>How long from `now` until the window next opens (zero while it is open).</summary>
    public static TimeSpan UntilOpen(DateTimeOffset now)
    {
        if (IsOpen(now)) return TimeSpan.Zero;
        var ist = now.ToOffset(IstClock.Offset);
        var day = ist.Date;
        if (ist.TimeOfDay >= Opens) day = day.AddDays(1);
        while (day.DayOfWeek is DayOfWeek.Saturday or DayOfWeek.Sunday) day = day.AddDays(1);
        return new DateTimeOffset(day + Opens, IstClock.Offset) - now;
    }

    /// <summary>Waits until the window is open; false if cancelled meanwhile. Sleeps in steps of at most 5 minutes so a
    /// clock change (or a test's clock) is noticed.</summary>
    public static async Task<bool> WaitForOpenAsync(CancellationToken cancellationToken)
    {
        while (!IsOpen(Now))
        {
            var wait = UntilOpen(Now);
            if (wait > TimeSpan.FromMinutes(5)) wait = TimeSpan.FromMinutes(5);
            if (wait < TimeSpan.FromSeconds(1)) wait = TimeSpan.FromSeconds(1);
            try { await Task.Delay(wait, cancellationToken); }
            catch (OperationCanceledException) { return false; }
        }
        return true;
    }

    // ---- Background work -----------------------------------------------------------------------------------------

    private static readonly AsyncLocal<bool> Background = new();

    /// <summary>Whether the code running now is background work (a BackgroundScope is open on this async flow).</summary>
    public static bool InBackground => Background.Value;

    /// <summary>Marks everything awaited from here (and the work it starts) as background: its Dhan REST calls are not sent
    /// outside the window. Used at the start of each hosted service's loop and for the server scanner's requests.</summary>
    public static IDisposable BackgroundScope()
    {
        var before = Background.Value;
        Background.Value = true;
        return new Restore(before);
    }

    /// <summary>Why a Dhan REST call must not be sent at `now`, else null: background work outside the window.</summary>
    public static string? BlockReason(DateTimeOffset now) =>
        InBackground && !IsOpen(now)
            ? "Not sent: background calls to Dhan stop outside market hours (IST weekdays 09:00 - 16:00)."
            : null;

    /// <summary>The header a page's timer refresh carries (POLL_HEADERS in shared.jsx).</summary>
    public const string PollHeader = "X-Poll";

    /// <summary>Runs the server scanner's requests and a page's timer refreshes (PollHeader) as background work.</summary>
    public static IApplicationBuilder UseBackgroundRequests(this IApplicationBuilder app) => app.Use(async (context, next) =>
    {
        if (context.User.IsInRole(Auth.ScannerRunnerKey.Role) || context.Request.Headers.ContainsKey(PollHeader))
        {
            using var background = BackgroundScope();
            await next();
        }
        else await next();
    });

    private sealed class Restore(bool before) : IDisposable
    {
        public void Dispose() => Background.Value = before;
    }
}
