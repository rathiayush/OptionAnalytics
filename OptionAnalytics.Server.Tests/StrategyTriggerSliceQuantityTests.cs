using OptionAnalytics.Server.Services;

namespace OptionAnalytics.Server.Tests;

/// <summary>Covers StrategyTriggerHostedService.SliceQuantity - the exchange freeze-limit slicing
/// every quantity this app sends to Dhan (Super Order entries and plain square-off/hedge orders
/// alike) now goes through, since Dhan's Super Order has no native slicing or disclosedQuantity
/// support (confirmed against its own API reference) unlike a plain order.
///
/// The case worth pinning hardest is that every slice - and the leftover remainder - stays a whole
/// multiple of the contract's own lot size. Slicing at the raw-quantity level could produce a slice
/// that respects the freeze ceiling but is itself an invalid order; slicing in LOTS instead cannot.</summary>
public sealed class StrategyTriggerSliceQuantityTests
{
    [Fact]
    public void UnderTheLimit_ReturnsOneUnchangedSlice()
    {
        // 10 lots x 65 = 650, well under NIFTY's 1800 - nothing to slice, and the original quantity
        // must come back byte-for-byte rather than a re-derived equal number.
        var slices = StrategyTriggerHostedService.SliceQuantity(650, lotSize: 65, freezeLimit: 1800);

        Assert.Equal(new[] { 650 }, slices);
    }

    [Fact]
    public void ExactlyAtTheLimit_IsStillOneSlice()
    {
        var slices = StrategyTriggerHostedService.SliceQuantity(1800, lotSize: 65, freezeLimit: 1800);

        Assert.Equal(new[] { 1800 }, slices);
    }

    [Fact]
    public void OverTheLimit_SplitsIntoWholeLotSlices()
    {
        // NIFTY: lot 65, freeze 1800 -> floor(1800/65) = 27 lots (1755) per slice. 60 lots total
        // (3900) needs 27 + 27 + 6 lots: 1755, 1755, 390 - every slice a whole multiple of 65, none
        // exceeding 1800, and the three sum back to the original 3900.
        var slices = StrategyTriggerHostedService.SliceQuantity(3900, lotSize: 65, freezeLimit: 1800);

        Assert.Equal(new[] { 1755, 1755, 390 }, slices);
        Assert.Equal(3900, slices.Sum());
        Assert.All(slices, s => Assert.Equal(0, s % 65));
        Assert.All(slices, s => Assert.True(s <= 1800));
    }

    [Fact]
    public void BankNiftyFreezeLimit_SlicesCorrectly()
    {
        // BANKNIFTY: lot 30, freeze 600 -> floor(600/30) = 20 lots (600) per slice. 45 lots (1350)
        // needs 20 + 20 + 5: 600, 600, 150.
        var slices = StrategyTriggerHostedService.SliceQuantity(1350, lotSize: 30, freezeLimit: 600);

        Assert.Equal(new[] { 600, 600, 150 }, slices);
    }

    [Fact]
    public void SensexFreezeLimit_SlicesCorrectly()
    {
        // SENSEX: lot 20, freeze 1000 -> floor(1000/20) = 50 lots (1000) per slice. 120 lots
        // (2400) needs 50 + 50 + 20: 1000, 1000, 400.
        var slices = StrategyTriggerHostedService.SliceQuantity(2400, lotSize: 20, freezeLimit: 1000);

        Assert.Equal(new[] { 1000, 1000, 400 }, slices);
    }

    [Fact]
    public void EveryOverLimitSlice_IsAWholeMultipleOfTheLotSize()
    {
        // A remainder that happened to land on a non-lot-aligned raw quantity would be a real,
        // invalid order Dhan would reject - this is the property that matters most, checked across
        // a quantity that does NOT divide evenly into either the lot size or the freeze limit.
        var slices = StrategyTriggerHostedService.SliceQuantity(totalQuantity: 65 * 100, lotSize: 65, freezeLimit: 1800);

        Assert.All(slices, s => Assert.Equal(0, s % 65));
        Assert.Equal(65 * 100, slices.Sum());
    }

    [Fact]
    public void NonPositiveQuantity_ReturnsItUnchangedRatherThanLooping()
    {
        Assert.Equal(new[] { 0 }, StrategyTriggerHostedService.SliceQuantity(0, lotSize: 65, freezeLimit: 1800));
        Assert.Equal(new[] { -65 }, StrategyTriggerHostedService.SliceQuantity(-65, lotSize: 65, freezeLimit: 1800));
    }

    [Fact]
    public void InvalidLotSize_ReturnsOneSliceRatherThanDividingByZero()
    {
        Assert.Equal(new[] { 3900 }, StrategyTriggerHostedService.SliceQuantity(3900, lotSize: 0, freezeLimit: 1800));
    }

    [Fact]
    public void FreezeLimitSmallerThanOneLot_ReturnsOneSliceRatherThanAnEmptyOne()
    {
        // A misconfigured freeze limit (smaller than a single lot) can produce zero lots per slice,
        // which must never be read as "slice into nothing" - that would silently drop the whole
        // order. Left for Dhan's own real rejection to explain, per this method's own doc comment.
        var slices = StrategyTriggerHostedService.SliceQuantity(3900, lotSize: 65, freezeLimit: 10);

        Assert.Equal(new[] { 3900 }, slices);
    }
}
