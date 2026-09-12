using OptionAnalytics.Server.Models;
using OptionAnalytics.Server.Services.Backtesting;

namespace OptionAnalytics.Server.Tests;

/// <summary>Covers the one thing v2 changes from v1: WHEN an alert candle becomes actionable.
///
/// The rule that matters is that a candle can only arm a level once it has CLOSED. While it is
/// still forming there is no way to know it finished entirely clear of the EMA, so arming it any
/// earlier would let a candle trigger against its own minutes - the look-ahead that would make v2's
/// tighter fills look better than they could ever really be.</summary>
public sealed class FiveEmaV2StrategyTests
{
    private static readonly DateTimeOffset T0 = new(2026, 1, 5, 3, 45, 0, TimeSpan.Zero); // 09:15 IST

    private static Candle Bar(int minutesFromOpen, decimal open, decimal high, decimal low, decimal close) =>
        new(T0.AddMinutes(minutesFromOpen), open, high, low, close);

    [Fact]
    public void AnAlertIsArmedOnlyFromTheMomentItsCandleCloses()
    {
        // Five 5-minute bars climbing well clear of a 2-bar EMA, so the last ones qualify as short
        // alert candles. Whatever ends up armed, it must never be actionable before its own bar has
        // finished - ActiveFrom is the bar's START plus the timeframe, never the start itself.
        var bars = new[]
        {
            Bar(0, 100, 102, 99, 101),
            Bar(5, 101, 104, 100, 103),
            Bar(10, 110, 115, 109, 114),
            Bar(15, 120, 125, 119, 124),
            Bar(20, 130, 135, 129, 134),
        };

        var states = FiveEmaV2Strategy.BuildAlertStatesForTest(bars, emaPeriod: 2, maxAgeBars: 0, timeframeMinutes: 5);

        Assert.Equal(bars.Length, states.Count);
        for (var i = 0; i < bars.Length; i++)
            Assert.Equal(bars[i].Time.AddMinutes(5), states[i].ActiveFrom);
    }

    [Fact]
    public void ACandleEntirelyAboveTheEmaArmsTheShortSideAtItsOwnLow()
    {
        // The taught rule: a candle clear ABOVE the EMA is a SHORT alert, broken by a later move
        // below that candle's low.
        var bars = new[]
        {
            Bar(0, 100, 102, 98, 100),
            Bar(5, 100, 102, 98, 100),
            Bar(10, 200, 210, 190, 205), // gaps clear above the EMA the flat bars established
        };

        var states = FiveEmaV2Strategy.BuildAlertStatesForTest(bars, emaPeriod: 2, maxAgeBars: 0, timeframeMinutes: 5);

        Assert.Equal(190m, states[^1].ShortBreakBelow);
        Assert.Null(states[^1].LongBreakAbove);
    }

    [Fact]
    public void ACandleEntirelyBelowTheEmaArmsTheLongSideAtItsOwnHigh()
    {
        var bars = new[]
        {
            Bar(0, 200, 202, 198, 200),
            Bar(5, 200, 202, 198, 200),
            Bar(10, 100, 110, 90, 95), // clear below
        };

        var states = FiveEmaV2Strategy.BuildAlertStatesForTest(bars, emaPeriod: 2, maxAgeBars: 0, timeframeMinutes: 5);

        Assert.Equal(110m, states[^1].LongBreakAbove);
        Assert.Null(states[^1].ShortBreakBelow);
    }

    [Fact]
    public void ACandleTouchingTheEmaCancelsBothSides()
    {
        // Price back at the average kills the setup outright - v1's rule, unchanged.
        var bars = new[]
        {
            Bar(0, 100, 102, 98, 100),
            Bar(5, 100, 102, 98, 100),
            Bar(10, 200, 210, 190, 205), // arms the short side
            Bar(15, 150, 260, 60, 150),  // straddles the EMA - cancels everything
        };

        var states = FiveEmaV2Strategy.BuildAlertStatesForTest(bars, emaPeriod: 2, maxAgeBars: 0, timeframeMinutes: 5);

        Assert.Null(states[^1].ShortBreakBelow);
        Assert.Null(states[^1].LongBreakAbove);
    }

    [Fact]
    public void OnlyOneSideIsEverArmedAtOnce()
    {
        // A candle clear above the EMA is simultaneously proof that any long alert - which needed
        // price BELOW the line - is dead. The two can never both be live.
        var bars = new[]
        {
            Bar(0, 200, 202, 198, 200),
            Bar(5, 200, 202, 198, 200),
            Bar(10, 100, 110, 90, 95),    // arms long
            Bar(15, 400, 420, 380, 410),  // now clear above - arms short, kills long
        };

        var states = FiveEmaV2Strategy.BuildAlertStatesForTest(bars, emaPeriod: 2, maxAgeBars: 0, timeframeMinutes: 5);

        foreach (var state in states)
            Assert.False(state.ShortBreakBelow is not null && state.LongBreakAbove is not null);

        Assert.NotNull(states[^1].ShortBreakBelow);
        Assert.Null(states[^1].LongBreakAbove);
    }

    [Fact]
    public void AlertsDoNotSurviveIntoTheNextDay()
    {
        // An overnight gap makes yesterday's level meaningless against today's price, so the state
        // carried into a new session must be empty rather than yesterday's last alert.
        var day1 = new[]
        {
            Bar(0, 100, 102, 98, 100),
            Bar(5, 100, 102, 98, 100),
            Bar(10, 200, 210, 190, 205), // arms short on day 1
        };
        var day2Start = T0.AddDays(1);
        var day2 = new[] { new Candle(day2Start, 500, 502, 498, 500) };

        var states = FiveEmaV2Strategy.BuildAlertStatesForTest(day1.Concat(day2).ToList(), emaPeriod: 2, maxAgeBars: 0, timeframeMinutes: 5);

        // Day 2's own bar may legitimately arm an alert of its OWN (it opens well clear of the EMA
        // here, so it does) - what must never happen is yesterday's 190 level still being live.
        Assert.NotEqual(190m, states[^1].ShortBreakBelow);
        Assert.Equal(498m, states[^1].ShortBreakBelow); // armed by today's bar, not yesterday's
    }

    [Fact]
    public void TheAlertRollsForwardToTheNewestQualifyingCandle()
    {
        // "The alert candle rolls forward to any newer qualifying candle" - so across a run of
        // candles each clear above the EMA, the live level is the LATEST one's low, not the first's.
        // That matters: the first candle's low is far below price by then and would never break.
        var bars = new[]
        {
            Bar(0, 100, 102, 98, 100),
            Bar(5, 100, 102, 98, 100),
            Bar(10, 300, 310, 290, 305),
            Bar(15, 400, 410, 390, 405),
            Bar(20, 500, 510, 490, 505),
        };

        var states = FiveEmaV2Strategy.BuildAlertStatesForTest(bars, emaPeriod: 2, maxAgeBars: 0, timeframeMinutes: 5);

        Assert.Equal(490m, states[^1].ShortBreakBelow); // the newest candle's low, not 290
    }
}
