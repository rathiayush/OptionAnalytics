using OptionAnalytics.Server.Services;

namespace OptionAnalytics.Server.Tests;

/// <summary>Covers CdvUnderlyingState.ComputeLookbackChange directly (made internal + this project
/// added via InternalsVisibleTo) rather than through GetLookbackTable's full live-state machinery -
/// it is a small, pure function and the one behaviour worth pinning down here is the near-zero /
/// zero-crossing guard that stops a %-change from blowing up into a meaningless, alarming-looking
/// swing (e.g. "-923%") whenever the reference reading was merely close to zero rather than exactly
/// zero. Bars-ago itself is irrelevant to this function's own logic (it only ever indexes
/// lastIndex - barsAgo), so tests build whatever series length makes each case clearest.</summary>
public sealed class CdvLookbackChangeTests
{
    [Fact]
    public void ComputeLookbackChange_NormalMove_ReturnsPercentChange()
    {
        // Both readings on the same (positive) side of zero - an ordinary, meaningful percentage.
        var series = new decimal?[] { 100m, 80m };

        var result = CdvUnderlyingState.ComputeLookbackChange(series, 1);

        Assert.Equal(80m, result.Current);
        Assert.Equal(100m, result.Previous);
        Assert.Equal(-20m, result.PercentChange);
    }

    [Fact]
    public void ComputeLookbackChange_PreviousExactlyZero_SuppressesPercentButKeepsLevels()
    {
        var series = new decimal?[] { 0m, -15m };

        var result = CdvUnderlyingState.ComputeLookbackChange(series, 1);

        Assert.Equal(-15m, result.Current);
        Assert.Equal(0m, result.Previous);
        Assert.Null(result.PercentChange);
    }

    [Fact]
    public void ComputeLookbackChange_PreviousNearZeroButOppositeSignFromCurrent_SuppressesPercent()
    {
        // The exact shape that produced "-923.55%" in practice: previous is small but NOT zero
        // (1.82), current has moved far away on the OTHER side of zero (-15) - previous == 0 alone
        // would miss this, since previous here is genuinely nonzero.
        var series = new decimal?[] { 1.82m, -15m };

        var result = CdvUnderlyingState.ComputeLookbackChange(series, 1);

        Assert.Equal(-15m, result.Current);
        Assert.Equal(1.82m, result.Previous);
        Assert.Null(result.PercentChange);
    }

    [Fact]
    public void ComputeLookbackChange_CurrentExactlyZero_SuppressesPercent()
    {
        var series = new decimal?[] { 40m, 0m };

        var result = CdvUnderlyingState.ComputeLookbackChange(series, 1);

        Assert.Equal(0m, result.Current);
        Assert.Equal(40m, result.Previous);
        Assert.Null(result.PercentChange);
    }

    [Fact]
    public void ComputeLookbackChange_BothNegative_ReturnsPercentChange()
    {
        // Same side of zero (both negative) - a real move, not a crossing, so the percentage stays.
        var series = new decimal?[] { -10m, -15m };

        var result = CdvUnderlyingState.ComputeLookbackChange(series, 1);

        Assert.Equal(-15m, result.Current);
        Assert.Equal(-10m, result.Previous);
        Assert.Equal(-50m, result.PercentChange);
    }

    [Fact]
    public void ComputeLookbackChange_NotEnoughHistoryForThatManyBarsAgo_ReturnsNullPrevious()
    {
        var series = new decimal?[] { 42m };

        var result = CdvUnderlyingState.ComputeLookbackChange(series, 5);

        Assert.Equal(42m, result.Current);
        Assert.Null(result.Previous);
        Assert.Null(result.PercentChange);
    }

    [Fact]
    public void ComputeLookbackChange_EmaNotYetSeeded_ReturnsAllNull()
    {
        var series = new decimal?[] { null, null };

        var result = CdvUnderlyingState.ComputeLookbackChange(series, 1);

        Assert.Null(result.Current);
        Assert.Null(result.Previous);
        Assert.Null(result.PercentChange);
    }
}
