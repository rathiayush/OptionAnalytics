using OptionAnalytics.Server.Models;
using OptionAnalytics.Server.Services.Backtesting;

namespace OptionAnalytics.Server.Tests;

/// <summary>Covers FlowConfirmation.Favors/Confirms in isolation - shared by EmaCrossAtmFlowStrategy
/// (a required confirmation gate) and FiveEmaStrategy (an optional opt-in one), so it is tested once
/// here rather than per strategy.</summary>
public sealed class FlowConfirmationTests
{
    private static readonly DateTimeOffset T0 = new(2026, 1, 5, 4, 0, 0, TimeSpan.Zero);

    private static DateTimeOffset At(int minute) => T0.AddMinutes(minute);

    // ---- Favors ----------------------------------------------------------------------------------
    // Two conditions, both required: ORDERING (the winning side above the other, right now) AND
    // RISING (that same winning side higher now than one `window` earlier).

    private static readonly TimeSpan FlowWindow = TimeSpan.FromMinutes(5);

    [Fact]
    public void Favors_BullishNeedsCeAbovePeAndCeRising()
    {
        var ce = new[] { new ObvPoint(At(5), 100), new ObvPoint(At(10), 140) };
        var pe = new[] { new ObvPoint(At(5), 100), new ObvPoint(At(10), 100) };

        Assert.True(FlowConfirmation.Favors(ce, pe, At(10), bullish: true, FlowWindow));
        Assert.False(FlowConfirmation.Favors(ce, pe, At(10), bullish: false, FlowWindow));
    }

    [Fact]
    public void Favors_BearishNeedsPeAboveCeAndPeRising()
    {
        var ce = new[] { new ObvPoint(At(5), 100), new ObvPoint(At(10), 100) };
        var pe = new[] { new ObvPoint(At(5), 100), new ObvPoint(At(10), 140) };

        Assert.True(FlowConfirmation.Favors(ce, pe, At(10), bullish: false, FlowWindow));
        Assert.False(FlowConfirmation.Favors(ce, pe, At(10), bullish: true, FlowWindow));
    }

    [Fact]
    public void Favors_OrderingAloneIsNotEnoughIfTheWinningSideIsFalling()
    {
        // CE is still above PE right now, but CE's own lead is SHRINKING (200 -> 140) rather than
        // growing - being ahead is not the same as still gaining, and this rule requires both.
        var ce = new[] { new ObvPoint(At(5), 200), new ObvPoint(At(10), 140) };
        var pe = new[] { new ObvPoint(At(5), 50), new ObvPoint(At(10), 100) };

        Assert.False(FlowConfirmation.Favors(ce, pe, At(10), bullish: true, FlowWindow));
    }

    [Fact]
    public void Favors_RisingAloneIsNotEnoughIfOrderingDoesNotHold()
    {
        // CE is rising, but PE is still above it right now - the direction isn't actually won yet.
        var ce = new[] { new ObvPoint(At(5), 50), new ObvPoint(At(10), 90) };
        var pe = new[] { new ObvPoint(At(5), 80), new ObvPoint(At(10), 100) };

        Assert.False(FlowConfirmation.Favors(ce, pe, At(10), bullish: true, FlowWindow));
    }

    [Fact]
    public void Favors_ExactlyEqualFavorsNeitherSide()
    {
        var ce = new[] { new ObvPoint(At(5), 100), new ObvPoint(At(10), 100) };
        var pe = new[] { new ObvPoint(At(5), 100), new ObvPoint(At(10), 100) };

        Assert.False(FlowConfirmation.Favors(ce, pe, At(10), bullish: true, FlowWindow));
        Assert.False(FlowConfirmation.Favors(ce, pe, At(10), bullish: false, FlowWindow));
    }

    [Fact]
    public void Favors_ReadsTheLastPointAtOrBeforeTheGivenTime()
    {
        // Neither series has a point exactly on the spot bar's own timestamp - each is read as "the
        // last value known by then", which is what makes this work across series that do not share
        // an index (CE/PE bars do not necessarily land on the same timestamps as spot's). Same for
        // the window-ago end: CE's own "5 minutes before now" reading comes from its point at 1, the
        // last one at or before 5.
        var ce = new[] { new ObvPoint(At(1), 100), new ObvPoint(At(7), 140) };
        var pe = new[] { new ObvPoint(At(2), 100), new ObvPoint(At(8), 100) };

        Assert.True(FlowConfirmation.Favors(ce, pe, At(10), bullish: true, FlowWindow));
    }

    [Fact]
    public void Favors_NoReadingAtNowFavorsNeitherDirection()
    {
        // Nothing at or before the given time yet: "no data" must not pass a filter whose whole job
        // is to require evidence for whichever direction is being confirmed.
        var ce = new[] { new ObvPoint(At(11), 100) };
        var pe = new[] { new ObvPoint(At(10), 50) };

        Assert.False(FlowConfirmation.Favors(ce, pe, At(10), bullish: true, FlowWindow));
        Assert.False(FlowConfirmation.Favors(Array.Empty<ObvPoint>(), Array.Empty<ObvPoint>(), At(10), bullish: true, FlowWindow));
    }

    [Fact]
    public void Favors_OrderingHoldsButNoReadingBeforeTheWindowIsNotConfirmed()
    {
        // CE is above PE right now, but neither series has anything at or before the window-ago
        // instant to compare against - there is no evidence of a slope yet, so this must not pass.
        var ce = new[] { new ObvPoint(At(10), 140) };
        var pe = new[] { new ObvPoint(At(10), 100) };

        Assert.False(FlowConfirmation.Favors(ce, pe, At(10), bullish: true, FlowWindow));
    }

    // ---- Favors: minRisePercent (optional) --------------------------------------------------------

    [Fact]
    public void Favors_MinRisePercent_AcceptsExactlyAtTheThresholdAndRejectsJustOver()
    {
        // CE: 100 -> 130 over the window - exactly a 30% rise, with PE flat and always below.
        var ce = new[] { new ObvPoint(At(5), 100), new ObvPoint(At(10), 130) };
        var pe = new[] { new ObvPoint(At(5), 50), new ObvPoint(At(10), 50) };

        Assert.True(FlowConfirmation.Favors(ce, pe, At(10), bullish: true, FlowWindow, minRisePercent: 30));
        Assert.False(FlowConfirmation.Favors(ce, pe, At(10), bullish: true, FlowWindow, minRisePercent: 31));
    }

    [Fact]
    public void Favors_MinRisePercentZero_KeepsThePlainAnyRiseReading()
    {
        // The same modest rise as above still passes when the threshold is off (0, the default) -
        // adding this parameter must not tighten the existing "any rise" behavior on its own.
        var ce = new[] { new ObvPoint(At(5), 100), new ObvPoint(At(10), 101) };
        var pe = new[] { new ObvPoint(At(5), 50), new ObvPoint(At(10), 50) };

        Assert.True(FlowConfirmation.Favors(ce, pe, At(10), bullish: true, FlowWindow, minRisePercent: 0));
        Assert.False(FlowConfirmation.Favors(ce, pe, At(10), bullish: true, FlowWindow, minRisePercent: 5));
    }

    [Fact]
    public void Favors_MinRisePercent_RejectsWhenTheBaseCrossedZero()
    {
        // CE went from -10 to +50 - a real rise (and still passes with the threshold OFF), but a
        // "600% rise" off a base that straddles zero is not a meaningful percentage, so any actual
        // threshold must reject it rather than compute a misleading number.
        var ce = new[] { new ObvPoint(At(5), -10), new ObvPoint(At(10), 50) };
        var pe = new[] { new ObvPoint(At(5), -100), new ObvPoint(At(10), 0) };

        Assert.True(FlowConfirmation.Favors(ce, pe, At(10), bullish: true, FlowWindow, minRisePercent: 0));
        Assert.False(FlowConfirmation.Favors(ce, pe, At(10), bullish: true, FlowWindow, minRisePercent: 10));
    }

    [Fact]
    public void Favors_MinRisePercent_RejectsWhenTheBaseIsExactlyZero()
    {
        var ce = new[] { new ObvPoint(At(5), 0), new ObvPoint(At(10), 50) };
        var pe = new[] { new ObvPoint(At(5), -10), new ObvPoint(At(10), 0) };

        Assert.True(FlowConfirmation.Favors(ce, pe, At(10), bullish: true, FlowWindow, minRisePercent: 0));
        Assert.False(FlowConfirmation.Favors(ce, pe, At(10), bullish: true, FlowWindow, minRisePercent: 10));
    }

    // ---- Confirms --------------------------------------------------------------------------------

    [Theory]
    [InlineData(0, true, false, true)]    // OBV only  - OBV favoring is enough
    [InlineData(0, false, true, false)]   // OBV only  - CDV favoring does not count
    [InlineData(1, false, true, true)]    // CDV only
    [InlineData(1, true, false, false)]   // CDV only  - OBV favoring does not count
    [InlineData(2, true, false, true)]    // Either
    [InlineData(2, false, false, false)]  // Either    - neither favoring fails
    [InlineData(3, true, true, true)]     // Both
    [InlineData(3, true, false, false)]   // Both      - one is not enough
    public void Confirms_HonoursEachMode(int mode, bool obvFavors, bool cdvFavors, bool expected)
    {
        Assert.Equal(expected, FlowConfirmation.Confirms(mode, obvFavors, cdvFavors));
    }
}
