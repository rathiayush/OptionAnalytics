using OptionAnalytics.Server.Models;
using OptionAnalytics.Server.Services.Backtesting;

namespace OptionAnalytics.Server.Tests;

/// <summary>Covers OrbOrderBlockStrategy's entry rule: a strong close beyond the first 15 minutes'
/// range, the nearest opposite-colored 1-min candle before that move as the order block, and an
/// entry on the later retrace into it - invalidated if price closes through the order block's far
/// side first, abandoned if the retrace never comes within retraceLookaheadBars. All fixtures use a
/// single session's worth of 1-minute SpotBarsOneMinute (bars 0-14 = the opening range, flat at
/// 100/100).</summary>
public sealed class OrbOrderBlockStrategyTests
{
    // 09:15 IST - NSE's real continuous-session open, since the opening range is defined from the
    // session's own start, not an arbitrary epoch-aligned point (contrast SrFlowSellStrategyTests'
    // own 30-minute channel, which deliberately avoids 09:15 for a different reason).
    private static readonly DateTimeOffset T0 = new(2026, 1, 5, 3, 45, 0, TimeSpan.Zero);

    private static Candle Bar(int minute, decimal open, decimal high, decimal low, decimal close) =>
        new(T0.AddMinutes(minute), open, high, low, close);

    private static List<Candle> OpeningRange(int minutes = 15, decimal level = 100) =>
        Enumerable.Range(0, minutes).Select(i => Bar(i, level, level, level, level)).ToList();

    private static BacktestStrategyContext Context(
        IReadOnlyList<Candle> bars, Func<decimal, bool, IReadOnlyList<Candle>>? getOptionBarsOneMinute = null,
        IReadOnlyList<OiIvPoint>? ceOiIvBand = null, IReadOnlyList<OiIvPoint>? peOiIvBand = null) => new()
    {
        Underlying = "NIFTY",
        TimeframeMinutes = 1,
        Step = 50,
        SpotBars = bars,
        SpotBarsOneMinute = bars,
        SpotVolumeBarsOneMinute = Array.Empty<CandleWithVolume>(),
        ConfluenceSignalsAscending = Array.Empty<BacktestSignal>(),
        AllSignals = Array.Empty<BacktestSignal>(),
        ObvCeSeries = Array.Empty<ObvPoint>(),
        ObvPeSeries = Array.Empty<ObvPoint>(),
        CdvCeSeries = Array.Empty<ObvPoint>(),
        CdvPeSeries = Array.Empty<ObvPoint>(),
        GetOptionBars = (_, _) => Array.Empty<Candle>(),
        GetOptionBarsOneMinute = getOptionBarsOneMinute ?? ((_, _) => Array.Empty<Candle>()),
        AtmCeBars = Array.Empty<Candle>(),
        AtmPeBars = Array.Empty<Candle>(),
        AtmCeVolumeBars = Array.Empty<CandleWithVolume>(),
        AtmPeVolumeBars = Array.Empty<CandleWithVolume>(),
        AtmStrike = null,
        CeOiIvBand = ceOiIvBand ?? Array.Empty<OiIvPoint>(),
        PeOiIvBand = peOiIvBand ?? Array.Empty<OiIvPoint>(),
    };

    private static Dictionary<string, decimal> Parameters(Action<Dictionary<string, decimal>>? overrides = null)
    {
        var p = new Dictionary<string, decimal>
        {
            ["side"] = OptionTradeSimulator.SideBuy,
            ["otmSteps"] = 1,
            ["squareOffMinutes"] = 0,
            ["signalStartMinutes"] = 0, // disabled - keeps fixtures independent of wall-clock IST
            ["excludeLastDays"] = 0,
            ["maxHoldingBars"] = 0,
            ["direction"] = 0, // both sides
            ["openingRangeMinutes"] = 15,
            ["breakoutBufferPoints"] = 5,
            ["orderBlockLookbackBars"] = 20,
            ["retraceLookaheadBars"] = 30,
            ["stopBufferPoints"] = 2,
            ["riskRewardMultiple"] = 3,
        };
        overrides?.Invoke(p);
        return p;
    }

    /// <summary>Bar 15: a bearish candle (the order block) sitting right before bar 16's breakout.
    /// Bar 17 holds above the order block; bar 18 dips back into it (Low 100 <= the order block's
    /// own High 101) - the retrace this strategy enters on.</summary>
    private static List<Candle> BullishSetup()
    {
        var bars = OpeningRange();
        bars.Add(Bar(15, 100, 101, 97, 98));   // order block (bearish: Close < Open)
        bars.Add(Bar(16, 98, 107, 98, 106));   // breakout: Close 106 >= 100 + 5
        bars.Add(Bar(17, 106, 112, 108, 110)); // holds above the order block, no retrace yet
        bars.Add(Bar(18, 110, 110, 100, 102)); // retrace: Low 100 <= order block High 101
        return bars;
    }

    [Fact]
    public void NoSignal_WhenTheDayHasNoMoreBarsThanTheOpeningRangeItself()
    {
        var context = Context(OpeningRange());

        var signals = new OrbOrderBlockStrategy().EntrySignals(context, Parameters());

        Assert.Empty(signals);
    }

    [Fact]
    public void BullishEntry_FiresOnTheRetraceIntoTheOrderBlock()
    {
        var context = Context(BullishSetup());

        var signals = new OrbOrderBlockStrategy().EntrySignals(context, Parameters());

        var signal = Assert.Single(signals);
        Assert.Equal("Entry", signal.Kind);
        Assert.Equal("Bullish", signal.Direction);
        Assert.Equal(T0.AddMinutes(18), signal.TimeUtc);
        Assert.Contains("order block", signal.Summary);
        Assert.Contains("stop 95", signal.Summary); // order block Low 97 - stopBufferPoints 2
        Assert.Contains("target 123", signal.Summary); // entry 102, risk 7, 1:3 -> 102 + 21
    }

    [Fact]
    public void NoSignalAtAll_WhenNoOppositeCandleExistsForTheOrderBlock()
    {
        // Every bar up to and including the breakout is flat (Open == Close), so no bearish candle
        // exists anywhere in the lookback window - there is no order block to trade off, and the
        // breakout itself produces no signal at all (not even Rejected).
        var bars = OpeningRange();
        bars.Add(Bar(15, 100, 106, 100, 106)); // breakout bar itself, but flat/bullish, not opposite

        var context = Context(bars);
        var signals = new OrbOrderBlockStrategy().EntrySignals(context, Parameters());

        Assert.Empty(signals);
    }

    [Fact]
    public void NoEntry_WhenTheOrderBlockIsInvalidatedBeforeAnyRetrace()
    {
        var bars = OpeningRange();
        bars.Add(Bar(15, 100, 101, 97, 98));   // order block [97-101]
        bars.Add(Bar(16, 98, 107, 98, 106));   // breakout
        bars.Add(Bar(17, 106, 106, 90, 96));   // closes BELOW the order block's own Low (97) - invalidated
        bars.Add(Bar(18, 96, 100, 95, 99));    // would have "retraced" into [97,101] but the setup is already dead

        var context = Context(bars);
        var signals = new OrbOrderBlockStrategy().EntrySignals(context, Parameters());

        Assert.Empty(signals);
    }

    [Fact]
    public void NoEntry_WhenTheRetraceNeverComesWithinTheLookaheadWindow()
    {
        var bars = OpeningRange();
        bars.Add(Bar(15, 100, 101, 97, 98));  // order block [97-101]
        bars.Add(Bar(16, 98, 107, 98, 106));  // breakout
        for (var m = 17; m <= 19; m++) bars.Add(Bar(m, 110, 115, 108, 112)); // stays well above, never dips back in

        var context = Context(bars);
        var signals = new OrbOrderBlockStrategy().EntrySignals(context, Parameters(p => p["retraceLookaheadBars"] = 2));

        Assert.Empty(signals);
    }

    [Fact]
    public void DirectionFilter_SkipsBullishEntryWhenBearishOnly()
    {
        var context = Context(BullishSetup());

        var signals = new OrbOrderBlockStrategy().EntrySignals(context, Parameters(p => p["direction"] = 2)); // bearish only

        var signal = Assert.Single(signals);
        Assert.Equal("Rejected", signal.Kind);
        Assert.Contains("bearish only", signal.Summary);
    }

    [Fact]
    public void BearishEntry_FiresOnTheRetraceIntoTheOrderBlock_Mirror()
    {
        var bars = OpeningRange();
        bars.Add(Bar(15, 100, 103, 99, 102));  // order block (bullish: Close > Open)
        bars.Add(Bar(16, 102, 102, 93, 94));   // breakout down: Close 94 <= 100 - 5
        bars.Add(Bar(17, 94, 92, 88, 90));     // holds below, no retrace yet
        bars.Add(Bar(18, 90, 100, 90, 98));    // retrace: High 100 >= order block Low 99

        var context = Context(bars);
        var signals = new OrbOrderBlockStrategy().EntrySignals(context, Parameters());

        var signal = Assert.Single(signals);
        Assert.Equal("Entry", signal.Kind);
        Assert.Equal("Bearish", signal.Direction);
    }

    [Fact]
    public void Simulate_ResolvesTheOrderBlockStopOrTarget_ThroughOptionTradeSimulatorsSignalExits()
    {
        var bars = BullishSetup();
        bars.Add(Bar(19, 102, 124, 101, 123)); // target 123 (see BullishEntry test) is hit here

        // Flat option premium at every 1-minute bar - only the EXIT TIME/REASON is under test here,
        // not option pricing itself.
        var optionBars = bars.Select(b => new Candle(b.Time, 100m, 100.5m, 99.5m, 100m)).ToList();
        var context = Context(bars, (_, _) => optionBars);

        var trades = new OrbOrderBlockStrategy().Simulate(context, Parameters());

        var trade = Assert.Single(trades);
        Assert.Equal("OrderBlockTarget", trade.ExitReason);
        Assert.Equal(T0.AddMinutes(20), trade.ExitTimeUtc); // bar 19's own close time (bar.Time + 1 minute)
    }

    // BullishSetup's own entry fires at bar 18 (T0+18min), entry price (bar.Close) 102, target 123 -
    // see BullishEntry_FiresOnTheRetraceIntoTheOrderBlock's own asserted values above.

    [Fact]
    public void OiWallFilter_Off_IgnoresAWallEvenWhenOneWouldOtherwiseBlock()
    {
        var band = new[] { new OiIvPoint(T0.AddMinutes(18), 115m, 500_000, null) };
        var context = Context(BullishSetup(), ceOiIvBand: band);

        var signals = new OrbOrderBlockStrategy().EntrySignals(context, Parameters()); // useOiWallFilter defaults to 0

        var signal = Assert.Single(signals);
        Assert.Equal("Entry", signal.Kind);
    }

    [Fact]
    public void OiWallFilter_On_BlocksWhenTheHeaviestCallOiStrikeSitsBetweenEntryAndTarget()
    {
        // Entry 102, target 123 - a Call-OI wall at 115 sits squarely in between.
        var band = new[]
        {
            new OiIvPoint(T0.AddMinutes(18), 115m, 500_000, null), // the wall
            new OiIvPoint(T0.AddMinutes(18), 150m, 10_000, null),  // far OTM, much lower OI - not the wall
        };
        var context = Context(BullishSetup(), ceOiIvBand: band);

        var signals = new OrbOrderBlockStrategy().EntrySignals(context, Parameters(p => p["useOiWallFilter"] = 1));

        var signal = Assert.Single(signals);
        Assert.Equal("Rejected", signal.Kind);
        Assert.Contains("OI wall at 115", signal.Summary);
        Assert.Equal(115m, signal.OiWallStrike);
        Assert.Equal(500_000, signal.OiWallOpenInterest);
    }

    [Fact]
    public void OiWallFilter_On_AllowsEntry_WhenTheWallIsBehindPriceNotAheadOfIt()
    {
        // A heavy-OI strike at 90 sits BELOW the entry price (102) - irrelevant to an upside target.
        var band = new[] { new OiIvPoint(T0.AddMinutes(18), 90m, 500_000, null) };
        var context = Context(BullishSetup(), ceOiIvBand: band);

        var signals = new OrbOrderBlockStrategy().EntrySignals(context, Parameters(p => p["useOiWallFilter"] = 1));

        var signal = Assert.Single(signals);
        Assert.Equal("Entry", signal.Kind);
        // The filter's own diagnostics are still attached to the accepted entry - what the frontend
        // needs to show "the basis of entry" (here: the nearest wall it saw, even though it didn't
        // block) when this signal/trade row is clicked.
        Assert.Equal(90m, signal.OiWallStrike);
        Assert.Equal(500_000, signal.OiWallOpenInterest);
    }

    [Fact]
    public void OiWallFilter_On_AllowsEntry_WhenTheWallSitsWellBeyondTheTargetWithBuffer()
    {
        // Target is 123 (+10 default buffer = 133) - a wall at 200 is nowhere near it.
        var band = new[] { new OiIvPoint(T0.AddMinutes(18), 200m, 500_000, null) };
        var context = Context(BullishSetup(), ceOiIvBand: band);

        var signals = new OrbOrderBlockStrategy().EntrySignals(context, Parameters(p => p["useOiWallFilter"] = 1));

        var signal = Assert.Single(signals);
        Assert.Equal("Entry", signal.Kind);
        Assert.Equal(200m, signal.OiWallStrike);
    }

    [Fact]
    public void OiWallFilter_On_AllowsEntry_WhenNoOiDataIsAvailableAtAll()
    {
        // Empty band (e.g. live Backtrack, which has no historical OI source at all) must fail OPEN,
        // never silently block every trade just because this filter's own data isn't there.
        var context = Context(BullishSetup()); // no ceOiIvBand/peOiIvBand supplied - empty

        var signals = new OrbOrderBlockStrategy().EntrySignals(context, Parameters(p => p["useOiWallFilter"] = 1));

        var signal = Assert.Single(signals);
        Assert.Equal("Entry", signal.Kind);
        Assert.Null(signal.OiWallStrike); // nothing to show - no data, not a false zero
    }

    [Fact]
    public void IvSpikeFilter_On_BlocksWhenNearTheMoneyIvJumpsPastTheThreshold()
    {
        // IV 15 -> 25 over 5 bars is a 66.7% rise, comfortably past the default 20% threshold.
        var band = new[]
        {
            new OiIvPoint(T0.AddMinutes(10), 100m, null, 15m),
            new OiIvPoint(T0.AddMinutes(18), 100m, null, 25m),
        };
        var context = Context(BullishSetup(), ceOiIvBand: band);

        var signals = new OrbOrderBlockStrategy().EntrySignals(context, Parameters(p => p["useIvSpikeFilter"] = 1));

        var signal = Assert.Single(signals);
        Assert.Equal("Rejected", signal.Kind);
        Assert.Contains("IV spiked", signal.Summary);
        Assert.Equal(25m, signal.IvNow);
        Assert.Equal(15m, signal.IvPrior);
        Assert.Equal(5, signal.IvLookbackBars);
    }

    [Fact]
    public void IvSpikeFilter_On_AllowsEntry_WhenIvIsFlat()
    {
        var band = new[]
        {
            new OiIvPoint(T0.AddMinutes(10), 100m, null, 15m),
            new OiIvPoint(T0.AddMinutes(18), 100m, null, 15.5m), // well under the 20% threshold
        };
        var context = Context(BullishSetup(), ceOiIvBand: band);

        var signals = new OrbOrderBlockStrategy().EntrySignals(context, Parameters(p => p["useIvSpikeFilter"] = 1));

        var signal = Assert.Single(signals);
        Assert.Equal("Entry", signal.Kind);
        // Diagnostics attached even though the check was clear - the frontend's "basis of entry"
        // view for an accepted trade.
        Assert.Equal(15.5m, signal.IvNow);
        Assert.Equal(15m, signal.IvPrior);
    }

    [Fact]
    public void IvSpikeFilter_On_AllowsEntry_WhenNoIvDataIsAvailableAtAll()
    {
        var context = Context(BullishSetup()); // empty band - fails open, same as the OI wall filter

        var signals = new OrbOrderBlockStrategy().EntrySignals(context, Parameters(p => p["useIvSpikeFilter"] = 1));

        var signal = Assert.Single(signals);
        Assert.Equal("Entry", signal.Kind);
    }
}
