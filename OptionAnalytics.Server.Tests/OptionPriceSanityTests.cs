using OptionAnalytics.Server.Models;

namespace OptionAnalytics.Server.Tests;

/// <summary>Covers OptionPriceSanity - found via a Strike Data page chart whose price axis blew
/// out to +14,000,000/-10,000,000 while its real candles sat around 475, meaning at least one
/// upstream bar held a garbage OHLC value. These tests fix the exact boundary this check draws:
/// a real, if unusual, premium must never be rejected, while a bar shaped like the actual bug
/// (one field's magnitude wildly larger than the others, even without breaking basic OHLC
/// ordering) must be.</summary>
public sealed class OptionPriceSanityTests
{
    [Theory]
    [InlineData(475.85)]
    [InlineData(0.05)] // the cheapest a real premium can plausibly print
    [InlineData(50000)] // a deep ITM premium in an extreme-volatility session - unusual, still real
    public void IsPlausiblePrice_ARealPremium_IsPlausible(decimal price)
    {
        Assert.True(OptionPriceSanity.IsPlausiblePrice(price));
    }

    [Theory]
    [InlineData(0)]
    [InlineData(-475.85)] // a premium can never be negative
    [InlineData(14_000_000)] // the exact shape of the bug this class was written for
    public void IsPlausiblePrice_NotARealPremium_IsImplausible(decimal price)
    {
        Assert.False(OptionPriceSanity.IsPlausiblePrice(price));
    }

    [Fact]
    public void IsPlausibleBar_OrdinaryCandle_IsPlausible()
    {
        Assert.True(OptionPriceSanity.IsPlausibleBar(open: 475, high: 480, low: 470, close: 478));
    }

    [Fact]
    public void IsPlausibleBar_FlatCandle_IsPlausible()
    {
        // Open == High == Low == Close is a legitimate (if quiet) bar, not a violation.
        Assert.True(OptionPriceSanity.IsPlausibleBar(open: 475, high: 475, low: 475, close: 475));
    }

    [Fact]
    public void IsPlausibleBar_HighIsCorruptedToAnImplausibleMagnitude_IsImplausible()
    {
        // The actual shape of the reported bug: Open/Low/Close all sit at a normal premium, but
        // High alone is corrupted to a value in the millions. High >= every other field still
        // holds here (14,000,000 >= 475), so a check that only enforced OHLC ORDERING - without
        // also checking each field's own plausibility - would let this exact bar through.
        Assert.False(OptionPriceSanity.IsPlausibleBar(open: 475, high: 14_000_000, low: 470, close: 478));
    }

    [Fact]
    public void IsPlausibleBar_LowIsCorruptedNegative_IsImplausible()
    {
        Assert.False(OptionPriceSanity.IsPlausibleBar(open: 475, high: 480, low: -10_000_000, close: 478));
    }

    [Fact]
    public void IsPlausibleBar_HighBelowLow_IsImplausible()
    {
        // A basic, real-trading-can-never-produce-this ordering violation, independent of magnitude.
        Assert.False(OptionPriceSanity.IsPlausibleBar(open: 475, high: 470, low: 480, close: 478));
    }

    [Fact]
    public void IsPlausibleBar_OpenAboveHigh_IsImplausible()
    {
        Assert.False(OptionPriceSanity.IsPlausibleBar(open: 490, high: 480, low: 470, close: 478));
    }

    [Fact]
    public void IsPlausibleBar_CloseBelowLow_IsImplausible()
    {
        Assert.False(OptionPriceSanity.IsPlausibleBar(open: 475, high: 480, low: 470, close: 460));
    }
}
