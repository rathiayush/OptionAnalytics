using OptionAnalytics.Server.Models;
using OptionAnalytics.Server.Services.Backtesting;

namespace OptionAnalytics.Server.Tests;

/// <summary>
/// Covers TwoCandleBreakoutStrategy's own reasoning, not the shared OptionTradeSimulator machinery
/// (that strategy deliberately doesn't use it - see its own doc comment): the two-candle pair
/// detection, the 9:15 "day's first candle never pairs" filter, the max-range cap, and that a
/// breakout's spot-level stop/target actually resolves to the right option-premium P&L.
/// </summary>
public sealed class TwoCandleBreakoutStrategyTests
{
    private static readonly DateTimeOffset T0 = new(2026, 1, 5, 4, 0, 0, TimeSpan.Zero);

    private static DateTimeOffset At(int minutesFromT0) => T0.AddMinutes(minutesFromT0);

    private static Candle Bar(int minutesFromT0, decimal open, decimal high, decimal low, decimal close) =>
        new(At(minutesFromT0), open, high, low, close);

    private static BacktestStrategyContext Context(IReadOnlyList<Candle> spotBars, Func<decimal, bool, IReadOnlyList<Candle>>? getOptionBars = null) => new()
    {
        Underlying = "NIFTY",
        TimeframeMinutes = 1,
        Step = 50,
        SpotBars = spotBars,
        ConfluenceSignalsAscending = Array.Empty<BacktestSignal>(),
        AllSignals = Array.Empty<BacktestSignal>(),
        ObvCeSeries = Array.Empty<ObvPoint>(),
        ObvPeSeries = Array.Empty<ObvPoint>(),
        CdvCeSeries = Array.Empty<ObvPoint>(),
        CdvPeSeries = Array.Empty<ObvPoint>(),
        GetOptionBars = getOptionBars ?? ((_, _) => Array.Empty<Candle>()),
    };

    private static readonly IReadOnlyDictionary<string, decimal> DefaultParameters = new Dictionary<string, decimal>
    {
        ["side"] = OptionTradeSimulator.SideBuy,
        ["otmSteps"] = 1,
        ["riskRewardRatio"] = 2,
        ["maxRangePoints"] = 100,
        ["direction"] = 0, // both
    };

    [Fact]
    public void Simulate_BullishBreakout_EntersAtBreakoutBarCloseAndHitsTarget()
    {
        var spotBars = new[]
        {
            Bar(0, open: 100, high: 100, low: 100, close: 100),   // day's first bar - excluded from pairing
            Bar(1, open: 100, high: 101, low: 98,  close: 99),    // red
            Bar(2, open: 99,  high: 103, low: 98.5m, close: 102), // green - opposite colour -> pair (range 98-103)
            Bar(3, open: 102, high: 104, low: 101, close: 104),   // closes above 103 -> bullish breakout
            Bar(4, open: 104, high: 105, low: 103, close: 104.5m),// neither stop (98) nor target (116) hit yet
            Bar(5, open: 104.5m, high: 117, low: 104, close: 116.5m), // High 117 >= target 116 -> target hit
        };

        // ATM at the breakout's own spot close (104) rounds to 100; otmSteps=1 on the call side -> 150 strike.
        var optionBars = new[]
        {
            Bar(3, open: 38, high: 41, low: 37, close: 40), // breakout bar's own close = entry price
            Bar(5, open: 68, high: 72, low: 66, close: 70), // exit bar's own close = exit price
        };

        var context = Context(spotBars, (strike, isCall) => strike == 150 && isCall ? optionBars : Array.Empty<Candle>());
        var strategy = new TwoCandleBreakoutStrategy();

        var trades = strategy.Simulate(context, DefaultParameters);

        var trade = Assert.Single(trades);
        Assert.Equal("Bullish", trade.Direction);
        Assert.Equal("Buy", trade.Side);
        Assert.Equal("CE", trade.OptionType);
        Assert.Equal(150m, trade.Strike);
        Assert.Equal(At(3), trade.SignalTimeUtc);
        Assert.Equal(At(4), trade.EntryTimeUtc);
        Assert.Equal(40m, trade.EntryPrice);
        Assert.Equal(At(5), trade.ExitTimeUtc);
        Assert.Equal(70m, trade.ExitPrice);
        Assert.Equal("TakeProfit", trade.ExitReason);
        Assert.Equal(30m, trade.PnlPoints); // buyer: exit - entry
    }

    [Fact]
    public void EntrySignals_DaysFirstCandle_NeverFormsHalfOfAPair()
    {
        // Bar 0 (red) and bar 1 (green) are opposite-coloured and bar 2 closes above their combined
        // high - a real pattern IF bar 0 were eligible. It is the day's own first bar, so no pair
        // should ever form from it, and this must NOT fire as an entry.
        var spotBars = new[]
        {
            Bar(0, open: 100, high: 101, low: 98, close: 99),   // red - day's first bar
            Bar(1, open: 99,  high: 103, low: 98.5m, close: 102), // green
            Bar(2, open: 102, high: 110, low: 101, close: 109),  // would close above bar0/bar1's range (98-103)
        };

        var context = Context(spotBars);
        var strategy = new TwoCandleBreakoutStrategy();

        var signals = strategy.EntrySignals(context, DefaultParameters);

        Assert.DoesNotContain(signals, s => s.Kind == "Entry");
    }

    [Fact]
    public void EntrySignals_RangeWiderThanCap_IsSkippedEvenWhenItWouldHaveBrokenOut()
    {
        var parameters = new Dictionary<string, decimal>(DefaultParameters) { ["maxRangePoints"] = 10 };

        var spotBars = new[]
        {
            Bar(0, open: 100, high: 100, low: 100, close: 100), // day's first bar - excluded
            Bar(1, open: 100, high: 130, low: 90,  close: 95),  // red, wide bar
            Bar(2, open: 95,  high: 140, low: 92,  close: 135), // green, opposite colour - combined range is 90-140 (50pts), over the 10pt cap
            Bar(3, open: 135, high: 200, low: 134, close: 199), // would close well above 140 if the pair had armed
        };

        var context = Context(spotBars);
        var strategy = new TwoCandleBreakoutStrategy();

        var signals = strategy.EntrySignals(context, parameters);

        Assert.DoesNotContain(signals, s => s.Kind == "Entry");
        Assert.Contains(signals, s => s.Kind == "Rejected" && s.Summary.Contains("exceeds the 10"));
    }
}
