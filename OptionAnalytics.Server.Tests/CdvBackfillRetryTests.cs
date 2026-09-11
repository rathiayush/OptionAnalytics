using OptionAnalytics.Server.Services;

namespace OptionAnalytics.Server.Tests;

/// <summary>Covers CdvUnderlyingState's backfill-retry bookkeeping - the floor that stops a strike
/// Dhan has no history for from being re-requested on every recenter.
///
/// Why this matters enough to test: Backfilled is only ever set by a fetch that actually returned
/// bars, so a contract that has never traded - or every contract on an exchange this account holds
/// no data entitlement for - stays "needs backfill" permanently. The recenter loop runs every 30
/// SECONDS rather than 30 minutes whenever any underlying is not fully live, and each pass can ask
/// for up to 66 strikes per expiry, so without this floor one dead exchange spends the shared Dhan
/// history rate limit that the underlyings which DO work need for their own backfills.</summary>
public sealed class CdvBackfillRetryTests
{
    private const uint SecurityId = 1100042;

    private static CdvUnderlyingState TrackedState()
    {
        var state = new CdvUnderlyingState("SENSEX");
        state.EnsureTracked(SecurityId, strike: 85000, isCall: true);
        return state;
    }

    private static readonly TimeSpan Base = TimeSpan.FromSeconds(45);
    private static readonly TimeSpan Max = TimeSpan.FromMinutes(30);

    [Fact]
    public void NeverAttempted_NeedsBackfillImmediately()
    {
        // A brand new strike must not be held back - there is no earlier attempt for it to be "too
        // soon" after.
        var state = TrackedState();

        Assert.True(state.NeedsBackfill(SecurityId, Base, Max));
    }

    [Fact]
    public void JustAttempted_IsHeldBackUntilTheIntervalPasses()
    {
        // The actual fix: a strike whose fetch just came back empty is NOT asked for again on the
        // next recenter 30 seconds later.
        var state = TrackedState();
        state.MarkBackfillAttempted(SecurityId);

        Assert.False(state.NeedsBackfill(SecurityId, Base, Max));
    }

    [Fact]
    public void AttemptedLongerAgoThanTheInterval_IsRetried()
    {
        // The floor delays retries, it must never cancel them - data that simply was not available
        // yet (a pre-open start, or being last in the backfill queue) still has to fill on its own.
        var state = TrackedState();
        state.MarkBackfillAttempted(SecurityId);

        Assert.True(state.NeedsBackfill(SecurityId, TimeSpan.Zero, TimeSpan.Zero));
    }

    [Fact]
    public void TheWaitDoublesWithEachFailure()
    {
        // One failure waits Base; two wait 2xBase; three wait 4xBase. A strike that is merely slow
        // recovers on the first short wait, while one that keeps failing backs itself off.
        var state = TrackedState();

        state.MarkBackfillAttempted(SecurityId);
        Assert.True(state.NeedsBackfill(SecurityId, TimeSpan.Zero, Max));

        // Elapsed is ~0 in a unit test, so the assertions are framed as "is this wait already
        // satisfied", with Base standing in for the elapsed time being compared against.
        state.MarkBackfillAttempted(SecurityId);
        state.MarkBackfillAttempted(SecurityId);
        Assert.False(state.NeedsBackfill(SecurityId, Base, Max));
    }

    [Fact]
    public void TheWaitIsCappedAtTheMaximum()
    {
        // Attempts climb all day on a permanently dead strike - the escalation must saturate rather
        // than grow without bound (or overflow the shift).
        var state = TrackedState();
        for (var i = 0; i < 500; i++) state.MarkBackfillAttempted(SecurityId);

        // Capped at Max, so a wait of exactly Max is satisfied however many failures have stacked up.
        Assert.True(state.NeedsBackfill(SecurityId, Max, TimeSpan.Zero));
    }

    [Fact]
    public void UntrackedStrike_NeverNeedsBackfill()
    {
        // Nothing to retry for a securityId this state has never tracked - EnsureTracked owns that
        // case, and claiming otherwise would queue a fetch for a contract with no state behind it.
        var state = TrackedState();

        Assert.False(state.NeedsBackfill(999999, TimeSpan.Zero, TimeSpan.Zero));
        Assert.False(state.NeedsBackfill(999999));
    }

    [Fact]
    public void MarkingAnUntrackedStrike_IsANoOpRatherThanAThrow()
    {
        // RecenterAsync stamps the attempt before the call, and a strike can roll out of the window
        // between those two points - that must not take the whole backfill batch down.
        var state = TrackedState();

        state.MarkBackfillAttempted(999999);

        Assert.False(state.NeedsBackfill(999999, TimeSpan.Zero, TimeSpan.Zero));
    }

    [Fact]
    public void TheIntervalOnlyGatesRetries_NotTheUngatedOverload()
    {
        // The original single-argument NeedsBackfill is still what "has this strike ever been
        // seeded?" means, independently of retry pacing - BackfillStrikesAsync's own bookkeeping
        // relies on that distinction.
        var state = TrackedState();
        state.MarkBackfillAttempted(SecurityId);

        Assert.True(state.NeedsBackfill(SecurityId));
        Assert.False(state.NeedsBackfill(SecurityId, Base, Max));
    }
}
