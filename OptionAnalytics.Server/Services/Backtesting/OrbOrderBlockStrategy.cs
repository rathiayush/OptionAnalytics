using OptionAnalytics.Server.Models;

namespace OptionAnalytics.Server.Services.Backtesting;

/// <summary>
/// The user's own setup, translated directly: "15min range, strong breakout on opening range, shift
/// to 1 min, wait for price to retrace in order block and then target 1:3, 20-25 min SL."
///
/// THE OPENING RANGE: the first openingRangeMinutes of each session (15 by default, from
/// SpotBarsOneMinute - independent of whatever timeframe the page itself is running at, the same
/// "own separate aggregation" convention SrFlowSellStrategy's own 30-minute channel uses). A "strong"
/// breakout is a later 1-minute bar's CLOSE clearing that range by breakoutBufferPoints - price
/// action only, no order-flow filter.
///
/// THE ORDER BLOCK: once a breakout fires, walk BACKWARD (bounded by orderBlockLookbackBars) for the
/// nearest opposite-colored 1-minute candle - the standard ICT definition (the last down-close
/// candle right before an up-move is the "bullish order block" that move originated from, and the
/// mirror for a down-move). No such candle within the lookback -> no valid setup, skip this breakout
/// entirely; a fresh one later in the day can still try again.
///
/// THE ENTRY: waits (up to retraceLookaheadBars) for a LATER bar to dip back into the order block's
/// own High/Low zone - the "retrace" the user asked for - and enters right there, at that bar's own
/// close. The order block is INVALIDATED (dropped, no entry) if price closes back through its far
/// side first - the classic sign the level was never real support/resistance. Whichever happens
/// first, the search for a fresh breakout resumes immediately after - so more than one attempt per
/// day per direction is possible if an earlier one is invalidated or times out.
///
/// RISK: the order block's OWN far boundary (+ a small buffer) is the stop; the target is
/// riskRewardMultiple times that same distance (1:3 by default) - both computed in SPOT points at
/// the moment of entry, then resolved into the exact TIME spot first reaches either one by walking
/// SpotBarsOneMinute forward (the same "precompute the crossing time in spot terms, hand only the
/// TIME to OptionTradeSimulator.Run" pattern the shared engine's own signalExits mechanism exists
/// for). maxHoldingBars is the 20-25 minute cutoff if neither is reached first - both risk controls
/// the user asked for, together, exactly as chosen.
///
/// BUYING, not selling - a retracement entry into a confirmed order block is a continuation trade
/// with the break, buying the leg that benefits.
///
/// TWO OPTIONAL FILTERS, both off by default, both EXPIRED-BACKTEST-ONLY (see
/// BacktestStrategyContext.CeOiIvBand/PeOiIvBand's own doc comment: live Backtrack has no
/// historical OI/IV source, so these silently no-op there rather than reject every trade):
///   - useOiWallFilter: at the moment of entry, finds the strike carrying the heaviest OI on the
///     side that would act as resistance/support against this trade (Call OI above spot for a
///     bullish trade, Put OI below spot for a bearish one - the standard "OI wall" read: writers
///     concentrated at a strike tend to defend it). Rejects the entry if that wall sits between the
///     entry price and the target (within oiWallBufferPoints of it), on the theory that a real OI
///     concentration is more likely to cap the move before target than a fresh order-block breakout
///     is to blow through it.
///   - useIvSpikeFilter: rejects an entry if the traded side's own IV (read from the band member
///     nearest ATM) has jumped more than ivSpikeThresholdPercent over the last ivSpikeLookbackBars -
///     a hard IV spike right at the signal more often means a news-driven, whippy move than a clean
///     trending breakout.
/// </summary>
public sealed class OrbOrderBlockStrategy : IBacktestStrategy
{
    public string Key => "orb-order-block-retrace";
    public string Name => "15-min ORB + 1-min Order Block Retrace (1:3)";
    public string Description => "A strong close beyond the first 15 minutes' range, then on the 1-minute chart: find the last opposite-colored candle before that move (the order block), wait for price to retrace into it, and buy there. Stop is the order block's own far side, target is a tunable risk:reward multiple (1:3 by default), with a 20-25 minute time cutoff alongside it.";

    private const decimal DirectionBoth = 0;
    private const decimal DirectionLongOnly = 1;
    private const decimal DirectionShortOnly = 2;

    public IReadOnlyList<BacktestParameterSpec> Parameters { get; } = new[]
    {
        OptionTradeSimulator.SideParameter(),
        OptionTradeSimulator.StrikeOffsetParameter(),
        OptionTradeSimulator.SquareOffTimeParameter(),
        OptionTradeSimulator.SignalStartTimeParameter(),
        OptionTradeSimulator.ExcludeLastDaysParameter(),
        OptionTradeSimulator.MaxHoldingTimeParameter() with { Default = 22 }, // midpoint of the user's own "20-25 min"
        new BacktestParameterSpec("direction", "Take", Default: DirectionBoth, Min: DirectionBoth, Max: DirectionShortOnly, Step: 1, Options: new[]
        {
            new BacktestParameterOption(DirectionBoth, "Both sides"),
            new BacktestParameterOption(DirectionLongOnly, "Bullish only"),
            new BacktestParameterOption(DirectionShortOnly, "Bearish only"),
        }),
        new BacktestParameterSpec("openingRangeMinutes", "Opening range length (minutes from session start)", Default: 15, Min: 5, Max: 60, Step: 5),
        new BacktestParameterSpec("breakoutBufferPoints", "Close must clear the opening range by at least (points)", Default: 5, Min: 0, Max: 200, Step: 1),
        new BacktestParameterSpec("orderBlockLookbackBars", "Search back this many 1-min bars for the order block candle", Default: 20, Min: 1, Max: 60, Step: 1),
        new BacktestParameterSpec("retraceLookaheadBars", "Give up waiting for the retrace after (1-min bars)", Default: 30, Min: 1, Max: 120, Step: 1),
        new BacktestParameterSpec("stopBufferPoints", "Stop placed this far beyond the order block's far side (points)", Default: 2, Min: 0, Max: 200, Step: 1),
        new BacktestParameterSpec("riskRewardMultiple", "Target = this many times the stop distance", Default: 3, Min: 1, Max: 10, Step: 0.5m),
        new BacktestParameterSpec("useOiWallFilter", "Reject entries where an OI wall sits between price and target (Expired Backtest only)", Default: 0, Min: 0, Max: 1, Step: 1, Options: new[]
        {
            new BacktestParameterOption(0, "Off"),
            new BacktestParameterOption(1, "On"),
        }),
        new BacktestParameterSpec("oiWallBufferPoints", "Clearance beyond an OI wall required before it's considered blocking (points)", Default: 10, Min: 0, Max: 200, Step: 1),
        new BacktestParameterSpec("useIvSpikeFilter", "Reject entries where the traded side's IV just spiked (Expired Backtest only)", Default: 0, Min: 0, Max: 1, Step: 1, Options: new[]
        {
            new BacktestParameterOption(0, "Off"),
            new BacktestParameterOption(1, "On"),
        }),
        new BacktestParameterSpec("ivSpikeLookbackBars", "Compare IV against this many 1-min bars ago", Default: 5, Min: 1, Max: 60, Step: 1),
        new BacktestParameterSpec("ivSpikeThresholdPercent", "IV rise over the lookback that counts as a spike (%)", Default: 20, Min: 1, Max: 200, Step: 1),
    };

    public IReadOnlyList<BacktestTrade> Simulate(BacktestStrategyContext context, IReadOnlyDictionary<string, decimal> parameters)
    {
        var (entries, signals, signalExits) = Evaluate(context, parameters);
        return OptionTradeSimulator.Run(context, entries, parameters, signalExits: signalExits, oneMinuteFills: true);
    }

    public IReadOnlyList<BacktestSignal> EntrySignals(BacktestStrategyContext context, IReadOnlyDictionary<string, decimal> parameters) =>
        Evaluate(context, parameters).Signals;

    private sealed record OrderBlock(bool Bullish, decimal High, decimal Low);

    private (List<(DateTimeOffset Time, string Direction)> Entries, List<BacktestSignal> Signals, Dictionary<DateTimeOffset, (DateTimeOffset Time, string Reason)> SignalExits) Evaluate(
        BacktestStrategyContext context, IReadOnlyDictionary<string, decimal> parameters)
    {
        var direction = parameters["direction"];
        var takeLongs = direction != DirectionShortOnly;
        var takeShorts = direction != DirectionLongOnly;
        var signalStartMinutes = (int)parameters.GetValueOrDefault("signalStartMinutes", 555);
        var openingRangeMinutes = Math.Max(1, (int)parameters["openingRangeMinutes"]);
        var breakoutBufferPoints = parameters["breakoutBufferPoints"];
        var orderBlockLookbackBars = Math.Max(1, (int)parameters["orderBlockLookbackBars"]);
        var retraceLookaheadBars = Math.Max(1, (int)parameters["retraceLookaheadBars"]);
        var stopBufferPoints = parameters["stopBufferPoints"];
        var riskRewardMultiple = parameters["riskRewardMultiple"];
        var useOiWallFilter = parameters.GetValueOrDefault("useOiWallFilter", 0m) >= 0.5m;
        var oiWallBufferPoints = parameters.GetValueOrDefault("oiWallBufferPoints", 10m);
        var useIvSpikeFilter = parameters.GetValueOrDefault("useIvSpikeFilter", 0m) >= 0.5m;
        var ivSpikeLookbackBars = Math.Max(1, (int)parameters.GetValueOrDefault("ivSpikeLookbackBars", 5m));
        var ivSpikeThresholdPercent = parameters.GetValueOrDefault("ivSpikeThresholdPercent", 20m);

        var entries = new List<(DateTimeOffset, string)>();
        var signals = new List<BacktestSignal>();
        var signalExits = new Dictionary<DateTimeOffset, (DateTimeOffset, string)>();

        var allBars = context.SpotBarsOneMinute;
        if (allBars.Count == 0) return (entries, signals, signalExits);

        void Emit(Candle bar, bool bearish, string detail, decimal? stop = null, decimal? target = null, int? dayEndIndexExclusive = null, int? entryIndex = null)
        {
            var dir = bearish ? "Bearish" : "Bullish";
            var beforeSignalStart = signalStartMinutes > 0 && IstClock.MinutesOfDay(bar.Time) < signalStartMinutes;

            if (beforeSignalStart)
                signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Rejected", dir, $"{detail} - skipped, before {IstClock.FormatMinutesOfDay(signalStartMinutes)} IST (pre-open)"));
            else if (bearish && !takeShorts)
                signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Rejected", dir, $"{detail} - skipped, bullish only"));
            else if (!bearish && !takeLongs)
                signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Rejected", dir, $"{detail} - skipped, bearish only"));
            else if (useOiWallFilter && target is { } targetForWall && OiWallBlocksEntry(context, bar.Time, bearish, bar.Close, targetForWall, oiWallBufferPoints, out var wallReason, out var blockingWall))
                signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Rejected", dir, $"{detail} - skipped, {wallReason}")
                {
                    OiWallStrike = blockingWall?.Strike,
                    OiWallOpenInterest = blockingWall?.OpenInterest,
                });
            else if (useIvSpikeFilter && IvSpikeBlocksEntry(context, bar.Time, bearish, bar.Close, ivSpikeLookbackBars, ivSpikeThresholdPercent, out var ivReason, out var blockingIvNow, out var blockingIvPrior))
                signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Rejected", dir, $"{detail} - skipped, {ivReason}")
                {
                    IvNow = blockingIvNow,
                    IvPrior = blockingIvPrior,
                    IvLookbackBars = ivSpikeLookbackBars,
                });
            else
            {
                // Diagnostics attached whenever the corresponding filter is ON, whether or not it
                // actually found anything to flag - this is what lets the frontend show "the basis
                // of entry" (what the OI-wall/IV check saw, even when it was clear) on a click,
                // not just what blocked a rejected signal.
                var acceptedWall = useOiWallFilter ? StrikeWithMaxOiAtOrBefore(bearish ? context.PeOiIvBand : context.CeOiIvBand, bar.Time) : null;
                var acceptedIvNow = useIvSpikeFilter ? NearestStrikeAtOrBefore(bearish ? context.PeOiIvBand : context.CeOiIvBand, bar.Time, bar.Close)?.ImpliedVolatility : null;
                var acceptedIvPrior = useIvSpikeFilter ? NearestStrikeAtOrBefore(bearish ? context.PeOiIvBand : context.CeOiIvBand, bar.Time.AddMinutes(-ivSpikeLookbackBars), bar.Close)?.ImpliedVolatility : null;

                signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Entry", dir, detail)
                {
                    OiWallStrike = acceptedWall?.Strike,
                    OiWallOpenInterest = acceptedWall?.OpenInterest,
                    IvNow = acceptedIvNow,
                    IvPrior = acceptedIvPrior,
                    IvLookbackBars = useIvSpikeFilter ? ivSpikeLookbackBars : null,
                });
                entries.Add((bar.Time, dir));

                if (stop is { } s && target is { } t && entryIndex is { } ei && dayEndIndexExclusive is { } dayEnd)
                {
                    var exit = FindSpotExit(allBars, ei, dayEnd, bearish, s, t);
                    if (exit is { } e) signalExits[bar.Time] = e;
                }
            }
        }

        var dayStart = 0;
        while (dayStart < allBars.Count)
        {
            var day = IstClock.IstDate(allBars[dayStart].Time);
            var dayEnd = dayStart;
            while (dayEnd < allBars.Count && IstClock.IstDate(allBars[dayEnd].Time) == day) dayEnd++;
            // [dayStart, dayEnd) is this calendar day's own bar range within allBars.

            if (dayEnd - dayStart > openingRangeMinutes)
            {
                decimal orHigh = allBars[dayStart].High, orLow = allBars[dayStart].Low;
                for (var k = dayStart + 1; k < dayStart + openingRangeMinutes; k++)
                {
                    orHigh = Math.Max(orHigh, allBars[k].High);
                    orLow = Math.Min(orLow, allBars[k].Low);
                }

                OrderBlock? pendingOb = null;
                var pendingObStartIndex = 0;

                for (var i = dayStart + openingRangeMinutes; i < dayEnd; i++)
                {
                    var bar = allBars[i];

                    if (pendingOb is { } ob)
                    {
                        var invalidated = ob.Bullish ? bar.Close < ob.Low : bar.Close > ob.High;
                        if (invalidated) { pendingOb = null; continue; }

                        if (i - pendingObStartIndex > retraceLookaheadBars) { pendingOb = null; continue; }

                        var retraced = ob.Bullish ? bar.Low <= ob.High : bar.High >= ob.Low;
                        if (retraced)
                        {
                            var stop = ob.Bullish ? ob.Low - stopBufferPoints : ob.High + stopBufferPoints;
                            var risk = Math.Abs(bar.Close - stop);
                            var target = ob.Bullish ? bar.Close + riskRewardMultiple * risk : bar.Close - riskRewardMultiple * risk;
                            Emit(bar, bearish: !ob.Bullish,
                                $"Retraced into the {(ob.Bullish ? "bullish" : "bearish")} order block [{ob.Low:0.##}-{ob.High:0.##}] at {bar.Close:0.##} - stop {stop:0.##}, target {target:0.##} (1:{riskRewardMultiple:0.#})",
                                stop, target, dayEnd, i);
                            pendingOb = null;
                        }
                        continue;
                    }

                    if (bar.Close >= orHigh + breakoutBufferPoints)
                    {
                        var found = FindOrderBlock(allBars, i, dayStart, orderBlockLookbackBars, bullishMove: true);
                        if (found is { } ob2) { pendingOb = ob2; pendingObStartIndex = i; }
                    }
                    else if (bar.Close <= orLow - breakoutBufferPoints)
                    {
                        var found = FindOrderBlock(allBars, i, dayStart, orderBlockLookbackBars, bullishMove: false);
                        if (found is { } ob2) { pendingOb = ob2; pendingObStartIndex = i; }
                    }
                }
            }

            dayStart = dayEnd;
        }

        return (entries, signals.OrderByDescending(sig => sig.TimeUtc).ToList(), signalExits);
    }

    /// <summary>Walks backward from just before breakoutIndex (bounded by lookbackBars and the
    /// day's own start) for the nearest candle whose color is OPPOSITE the breakout direction - the
    /// standard ICT order block definition. Null when nothing opposite-colored exists in that
    /// window (a clean run of same-direction candles into the breakout, with no order block to
    /// trade off).</summary>
    private static OrderBlock? FindOrderBlock(IReadOnlyList<Candle> bars, int breakoutIndex, int dayStart, int lookbackBars, bool bullishMove)
    {
        var floor = Math.Max(dayStart, breakoutIndex - lookbackBars);
        for (var i = breakoutIndex - 1; i >= floor; i--)
        {
            var bar = bars[i];
            var isOpposite = bullishMove ? bar.Close < bar.Open : bar.Close > bar.Open;
            if (isOpposite) return new OrderBlock(bullishMove, bar.High, bar.Low);
        }
        return null;
    }

    /// <summary>Walks SpotBarsOneMinute forward from just after the entry bar (bounded by the same
    /// calendar day, since every trade here is intraday) for the first bar whose High/Low reaches
    /// either the stop or the target - conservative when a single bar spans both (checks the stop
    /// first), same choice OptionTradeSimulator.Run's own premium stop/target makes. Returns that
    /// bar's own Time (never a price - see this class's own doc comment for why only the TIME feeds
    /// OptionTradeSimulator.Run's signalExits) and which one it was, or null if neither is reached
    /// before the day's bars run out.</summary>
    private static (DateTimeOffset Time, string Reason)? FindSpotExit(
        IReadOnlyList<Candle> bars, int entryIndex, int dayEndExclusive, bool bearish, decimal stop, decimal target)
    {
        for (var i = entryIndex + 1; i < dayEndExclusive; i++)
        {
            var bar = bars[i];
            var stopHit = bearish ? bar.High >= stop : bar.Low <= stop;
            if (stopHit) return (bar.Time, "OrderBlockStop");

            var targetHit = bearish ? bar.Low <= target : bar.High >= target;
            if (targetHit) return (bar.Time, "OrderBlockTarget");
        }
        return null;
    }

    /// <summary>True when a real OI concentration sits between the entry price and the target, on
    /// the side that would act as resistance (bullish trade - looks at CeOiIvBand, the highest Call
    /// OI strike) or support (bearish trade - PeOiIvBand, highest Put OI). Fails OPEN (returns
    /// false, never blocks) whenever OI data simply is not there - an empty band (live Backtrack),
    /// no snapshot at-or-before asOf yet, or no band member reporting both a resolved strike and OI
    /// at that snapshot - since this filter's entire premise (a real OI wall) cannot be evaluated
    /// without it, and a strategy parameter should never silently reject every trade just because
    /// the data source it depends on happens to be unavailable.</summary>
    private static bool OiWallBlocksEntry(
        BacktestStrategyContext context, DateTimeOffset asOf, bool bearish, decimal entryPrice, decimal target, decimal wallBufferPoints,
        out string reason, out OiIvPoint? wall)
    {
        reason = "";
        var band = bearish ? context.PeOiIvBand : context.CeOiIvBand;

        wall = StrikeWithMaxOiAtOrBefore(band, asOf);
        if (wall is not { Strike: { } wallStrike, OpenInterest: { } wallOi }) return false;

        // Only a wall AHEAD of the trade (above entry for a bullish trade, below for a bearish one)
        // can cap it - a wall already behind price is irrelevant to where this trade is headed.
        var wallIsAhead = bearish ? wallStrike < entryPrice : wallStrike > entryPrice;
        if (!wallIsAhead) return false;

        // Blocking means the wall (plus its own buffer) sits ON THE WAY to target - i.e. target
        // reaches into or past it - not merely that a wall exists somewhere beyond target.
        var targetReachesWall = bearish ? wallStrike >= target - wallBufferPoints : wallStrike <= target + wallBufferPoints;
        if (!targetReachesWall) return false;

        reason = $"OI wall at {wallStrike:0.##} ({wallOi:N0} OI) sits in the way of the {(bearish ? "downside" : "upside")} target {target:0.##}";
        return true;
    }

    /// <summary>True when the near-the-money strike's own IV has risen by at least
    /// thresholdPercent over the last lookbackBars 1-min bars. Fails open (returns false) exactly
    /// like OiWallBlocksEntry whenever IV data is not there to compare - no band, no snapshot at
    /// either point in time, or a zero/missing prior IV that would make a percentage change
    /// meaningless.</summary>
    private static bool IvSpikeBlocksEntry(
        BacktestStrategyContext context, DateTimeOffset asOf, bool bearish, decimal referencePrice, int lookbackBars, decimal thresholdPercent,
        out string reason, out decimal? currentIvOut, out decimal? priorIvOut)
    {
        reason = "";
        currentIvOut = null;
        priorIvOut = null;
        var band = bearish ? context.PeOiIvBand : context.CeOiIvBand;

        var current = NearestStrikeAtOrBefore(band, asOf, referencePrice);
        if (current?.ImpliedVolatility is not { } currentIv) return false;
        currentIvOut = currentIv;

        var prior = NearestStrikeAtOrBefore(band, asOf.AddMinutes(-lookbackBars), referencePrice);
        if (prior?.ImpliedVolatility is not { } priorIv || priorIv <= 0) return false;
        priorIvOut = priorIv;

        var changePercent = (currentIv - priorIv) / priorIv * 100m;
        if (changePercent < thresholdPercent) return false;

        reason = $"IV spiked {changePercent:0.#}% over the last {lookbackBars} bar(s) ({priorIv:0.##} -> {currentIv:0.##})";
        return true;
    }

    /// <summary>The band point with the highest OpenInterest among every strike reported at the
    /// LATEST snapshot time at-or-before asOf - every band member is fetched at the same 1-minute
    /// resolution, so distinct strikes share the same timestamps, making "the latest shared
    /// timestamp not after asOf" a well-defined single snapshot to compare across strikes. Points
    /// missing a resolved Strike or OpenInterest are excluded from consideration entirely (can't
    /// meaningfully call one of them "the wall"), which also means a genuinely empty/unavailable
    /// band correctly returns null rather than a spurious match.</summary>
    private static OiIvPoint? StrikeWithMaxOiAtOrBefore(IReadOnlyList<OiIvPoint> band, DateTimeOffset asOf)
    {
        DateTimeOffset? snapshotTime = null;
        foreach (var p in band)
            if (p.Time <= asOf && (snapshotTime is null || p.Time > snapshotTime))
                snapshotTime = p.Time;
        if (snapshotTime is null) return null;

        OiIvPoint? best = null;
        foreach (var p in band)
            if (p.Time == snapshotTime && p.Strike is not null && p.OpenInterest is not null
                && (best is null || p.OpenInterest > best.Value.OpenInterest))
                best = p;
        return best;
    }

    /// <summary>The band point at the LATEST snapshot time at-or-before asOf whose own resolved
    /// strike sits closest to referencePrice - a proxy for "the near-the-money strike's own IV at
    /// this moment" when the exact traded strike isn't known at this point in the evaluation (that
    /// only gets resolved later, per-trade, by OptionTradeSimulator). Same exclusion/empty-band
    /// behavior as StrikeWithMaxOiAtOrBefore.</summary>
    private static OiIvPoint? NearestStrikeAtOrBefore(IReadOnlyList<OiIvPoint> band, DateTimeOffset asOf, decimal referencePrice)
    {
        DateTimeOffset? snapshotTime = null;
        foreach (var p in band)
            if (p.Time <= asOf && (snapshotTime is null || p.Time > snapshotTime))
                snapshotTime = p.Time;
        if (snapshotTime is null) return null;

        OiIvPoint? nearest = null;
        foreach (var p in band)
            if (p.Time == snapshotTime && p.Strike is not null
                && (nearest is null || Math.Abs(p.Strike.Value - referencePrice) < Math.Abs(nearest.Value.Strike!.Value - referencePrice)))
                nearest = p;
        return nearest;
    }
}
