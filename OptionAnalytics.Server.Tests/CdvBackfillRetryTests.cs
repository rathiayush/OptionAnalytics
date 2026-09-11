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

    [Fact]
    public void NeverAttempted_NeedsBackfillImmediately()
    {
        // A brand new strike must not be held back by the retry floor - there is no earlier attempt
        // for it to be "too soon" after.
        var state = TrackedState();

        Assert.True(state.NeedsBackfill(SecurityId, TimeSpan.FromMinutes(30)));
    }

    [Fact]
    public void JustAttempted_IsHeldBackUntilTheIntervalPasses()
    {
        // The actual fix: a strike whose fetch just came back empty is NOT asked for again on the
        // next recenter 30 seconds later.
        var state = TrackedState();
        state.MarkBackfillAttempted(SecurityId);

        Assert.False(state.NeedsBackfill(SecurityId, TimeSpan.FromMinutes(30)));
    }

    [Fact]
    public void AttemptedLongerAgoThanTheInterval_IsRetried()
    {
        // The floor delays retries, it must never cancel them - a transient failure (auth not ready,
        // a brief Dhan outage) still has to recover on its own once the interval has passed.
        var state = TrackedState();
        state.MarkBackfillAttempted(SecurityId);

        Assert.True(state.NeedsBackfill(SecurityId, TimeSpan.Zero));
    }

    [Fact]
    public void UntrackedStrike_NeverNeedsBackfill()
    {
        // Nothing to retry for a securityId this state has never tracked - EnsureTracked owns that
        // case, and claiming otherwise would queue a fetch for a contract with no state behind it.
        var state = TrackedState();

        Assert.False(state.NeedsBackfill(999999, TimeSpan.Zero));
        Assert.False(state.NeedsBackfill(999999));
    }

    [Fact]
    public void MarkingAnUntrackedStrike_IsANoOpRatherThanAThrow()
    {
        // RecenterAsync stamps the attempt before the call, and a strike can roll out of the window
        // between those two points - that must not take the whole backfill batch down.
        var state = TrackedState();

        state.MarkBackfillAttempted(999999);

        Assert.False(state.NeedsBackfill(999999, TimeSpan.Zero));
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
        Assert.False(state.NeedsBackfill(SecurityId, TimeSpan.FromMinutes(30)));
    }
}
