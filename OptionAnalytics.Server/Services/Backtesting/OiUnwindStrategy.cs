using OptionAnalytics.Server.Models;

namespace OptionAnalytics.Server.Services.Backtesting;

/// <summary>
/// A directional option-BUYING strategy built on open interest rather than price action: find the
/// strongest CE/PE "wall" near ATM (a strike where OI is concentrated), and buy through it the
/// moment that wall's own writers look like they are covering rather than defending it - the setup
/// the user described directly: "find smart support and resistance on the basis of OI ... check if
/// option sellers are in profit or not ... if OI is decreasing and price sustained or increase then
/// we can take entry."
///
/// THE WALL: among CE strikes at/above ATM (resistance) and PE strikes at/below ATM (support),
/// within oiScanSteps of it, rank strikes twice - once by current absolute OI, once by OI BUILDUP
/// since this morning's baseline - and blend the two ranks via oiChangeWeightPercent (0 = absolute
/// OI only, 100 = today's buildup only, 50 = an even blend). This directly answers "both, combined"
/// rather than picking one basis outright, since either alone misses something: absolute OI alone
/// can point at a stale wall nobody is adding to anymore, and buildup alone can point at a strike
/// still small in absolute terms.
///
/// WRITERS COVERING: at the wall's own strike, OI must have DROPPED at least oiUnwindThresholdPercent
/// from this morning's baseline (they are closing, not adding), AND that leg's own premium must have
/// decayed at least premiumDecayThresholdPercent from its own baseline while price is still on the
/// writer's winning side of the strike (spot <= strike for a CE writer, >= for a PE one) - the
/// user's own two-part check, "price vs strike + premium decay," for telling a writer who has
/// genuinely been winning (and is now taking the win off the table) from one merely trimming size or
/// hedging.
///
/// PRICE ACTION: fires the bar price FIRST reaches within levelZonePoints of the wall (the previous
/// bar was still clearly on the wrong side) while also closing no worse than the previous bar - "OI
/// decreasing and price sustained or increasing," in the user's own words. Only the immediate move
/// into the level matters here, not a full breakout+retest sequence (contrast SrFlowSellStrategy,
/// which uses OBV/CDV acceleration for that job instead of OI) - OI unwinding into the test IS the
/// confirmation this strategy trades on.
///
/// LIVE ONLY - THIS CANNOT BE BACKTESTED: BacktestStrategyContext.OpenInterest is a live snapshot
/// with no history (see OiChainSnapshot's own doc comment - Dhan's Option Chain API only ever
/// answers "right now"), so this strategy only ever evaluates the MOST RECENTLY CLOSED bar, exactly
/// once per call. That is precisely what StrategyTriggerHostedService needs (re-run on every bar
/// close; only the newest bar can possibly be new), but it means EntrySignals/Simulate return at
/// most one signal no matter how much history context.SpotBars covers - there is nothing to replay
/// further back than "now." This strategy is therefore deliberately left out of
/// ExpiredOptionBacktestService.SupportedStrategyKeys, which only ever replays expired, historical
/// contracts.
///
/// BUYING, not selling: unlike SrFlowSellStrategy this trades WITH the break, buying the leg that
/// benefits (CE for a resistance break, PE for a support break) - the classic "shorts covering fuels
/// the move further" read on unwinding OI, not a premium-selling play.
/// </summary>
public sealed class OiUnwindStrategy : IBacktestStrategy
{
    public string Key => "oi-unwind-flow";
    public string Name => "OI Unwind at Smart S/R (live only)";
    public string Description => "Finds the strongest CE/PE open-interest wall near ATM (blending absolute OI and today's own buildup) and buys through it once that side's writers are covering - OI down from this morning's baseline and premium decayed while spot is still on their winning side - as price first presses into the level and holds. Needs a live, currently-tracked option chain with today's morning OI baseline already captured; not available for Expired Backtest or any other historical replay.";

    private const decimal DirectionBoth = 0;
    private const decimal DirectionLongOnly = 1;
    private const decimal DirectionShortOnly = 2;

    public IReadOnlyList<BacktestParameterSpec> Parameters { get; } = new[]
    {
        OptionTradeSimulator.SideParameter(),
        OptionTradeSimulator.StrikeOffsetParameter(),
        OptionTradeSimulator.StopLossParameter(),
        OptionTradeSimulator.TakeProfitParameter(),
        OptionTradeSimulator.SquareOffTimeParameter(),
        OptionTradeSimulator.SignalStartTimeParameter(),
        OptionTradeSimulator.ExcludeLastDaysParameter(),
        OptionTradeSimulator.MaxHoldingTimeParameter(),
        new BacktestParameterSpec("direction", "Take", Default: DirectionBoth, Min: DirectionBoth, Max: DirectionShortOnly, Step: 1, Options: new[]
        {
            new BacktestParameterOption(DirectionBoth, "Both sides"),
            new BacktestParameterOption(DirectionLongOnly, "Bullish only"),
            new BacktestParameterOption(DirectionShortOnly, "Bearish only"),
        }),
        new BacktestParameterSpec("oiScanSteps", "Scan this many strikes each side of ATM for the OI wall", Default: 10, Min: 1, Max: 20, Step: 1),
        new BacktestParameterSpec("oiChangeWeightPercent", "Weight on today's OI buildup vs. absolute OI (0=absolute only, 100=buildup only)", Default: 50, Min: 0, Max: 100, Step: 5),
        new BacktestParameterSpec("oiUnwindThresholdPercent", "Writers must have covered at least this much OI since this morning (%)", Default: 10, Min: 1, Max: 90, Step: 1),
        new BacktestParameterSpec("premiumDecayThresholdPercent", "That strike's own premium must have decayed at least this much since this morning (%)", Default: 10, Min: 0, Max: 90, Step: 1),
        new BacktestParameterSpec("levelZonePoints", "Counts as testing the level within (points)", Default: 20, Min: 1, Max: 500, Step: 1),
    };

    public IReadOnlyList<BacktestTrade> Simulate(BacktestStrategyContext context, IReadOnlyDictionary<string, decimal> parameters) =>
        OptionTradeSimulator.Run(context, Evaluate(context, parameters).Entries, parameters);

    public IReadOnlyList<BacktestSignal> EntrySignals(BacktestStrategyContext context, IReadOnlyDictionary<string, decimal> parameters) =>
        Evaluate(context, parameters).Signals;

    public IReadOnlyDictionary<string, decimal> DefaultsForTimeframe(int timeframeMinutes)
    {
        var scale = OptionTradeSimulator.TimeframeScale(timeframeMinutes);
        return new Dictionary<string, decimal>
        {
            ["slPoints"] = 10m * scale,
            ["tpPoints"] = 20m * scale,
            ["levelZonePoints"] = 20m * scale,
        };
    }

    private (List<(DateTimeOffset Time, string Direction)> Entries, List<BacktestSignal> Signals) Evaluate(
        BacktestStrategyContext context, IReadOnlyDictionary<string, decimal> parameters)
    {
        var direction = parameters["direction"];
        var takeLongs = direction != DirectionShortOnly;
        var takeShorts = direction != DirectionLongOnly;
        var signalStartMinutes = (int)parameters.GetValueOrDefault("signalStartMinutes", 555);
        var oiScanSteps = Math.Max(1, (int)parameters["oiScanSteps"]);
        var oiChangeWeightPercent = parameters["oiChangeWeightPercent"];
        var oiUnwindThresholdPercent = parameters["oiUnwindThresholdPercent"];
        var premiumDecayThresholdPercent = parameters["premiumDecayThresholdPercent"];
        var levelZonePoints = parameters["levelZonePoints"];

        var entries = new List<(DateTimeOffset, string)>();
        var signals = new List<BacktestSignal>();

        var bars = context.SpotBars;
        var step = context.Step;
        var oi = context.OpenInterest;

        // Only the most recently closed bar is ever evaluated - see this class's own doc comment for
        // why open interest has no history to replay any further back than "right now".
        if (bars.Count < 2 || context.AtmStrike is not { } atmStrike || step <= 0 || oi is null || oi.Baseline.Count == 0)
            return (entries, signals);

        var i = bars.Count - 1;
        var bar = bars[i];
        var prev = bars[i - 1];

        var (resistance, resistanceSnap) = FindWall(oi, atmStrike, step, oiScanSteps, oiChangeWeightPercent, isCall: true, aboveSpot: true);
        var (support, supportSnap) = FindWall(oi, atmStrike, step, oiScanSteps, oiChangeWeightPercent, isCall: false, aboveSpot: false);

        var beforeSignalStart = signalStartMinutes > 0 && IstClock.MinutesOfDay(bar.Time) < signalStartMinutes;

        void Emit(bool bearish, string detail)
        {
            var dir = bearish ? "Bearish" : "Bullish";
            if (beforeSignalStart)
                signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Rejected", dir, $"{detail} - skipped, before {IstClock.FormatMinutesOfDay(signalStartMinutes)} IST (pre-open)"));
            else if (bearish && !takeShorts)
                signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Rejected", dir, $"{detail} - skipped, bullish only"));
            else if (!bearish && !takeLongs)
                signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Rejected", dir, $"{detail} - skipped, bearish only"));
            else
            {
                signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Entry", dir, detail));
                entries.Add((bar.Time, dir));
            }
        }

        // ---- Resistance: CE writers covering as price presses up into the wall ------------------
        if (resistance is { } r && resistanceSnap is { } rSnap)
        {
            var justReached = bar.Close >= r - levelZonePoints && prev.Close < r - levelZonePoints;
            var sustaining = bar.Close >= prev.Close;

            if (justReached && sustaining)
            {
                oi.Baseline.TryGetValue(r, out var rBaseline);
                var unwinding = OiUnwinding(rBaseline?.CeOpenInterest, rSnap.CeOpenInterest, oiUnwindThresholdPercent);
                var sellersInProfit = SellersInProfit(isCall: true, bar.Close, r, rBaseline?.CePremium, rSnap.CePremium, premiumDecayThresholdPercent);

                if (unwinding && sellersInProfit)
                {
                    Emit(bearish: false, $"Spot {bar.Close:0.##} reached resistance {r:0.##} (OI-based wall) - CE writers there covering (OI {rBaseline?.CeOpenInterest:0} to {rSnap.CeOpenInterest:0} since this morning, premium decayed) while price holds - buying through");
                }
                else
                {
                    signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Rejected", "Bullish",
                        $"Spot reached resistance {r:0.##} (OI-based wall) but CE writers there are not clearly covering yet (unwinding={unwinding}, sellers in profit={sellersInProfit}) - skipped"));
                }
            }
        }

        // ---- Support: PE writers covering as price presses down into the wall -------------------
        if (support is { } s && supportSnap is { } sSnap)
        {
            var justReached = bar.Close <= s + levelZonePoints && prev.Close > s + levelZonePoints;
            var sustaining = bar.Close <= prev.Close;

            if (justReached && sustaining)
            {
                oi.Baseline.TryGetValue(s, out var sBaseline);
                var unwinding = OiUnwinding(sBaseline?.PeOpenInterest, sSnap.PeOpenInterest, oiUnwindThresholdPercent);
                var sellersInProfit = SellersInProfit(isCall: false, bar.Close, s, sBaseline?.PePremium, sSnap.PePremium, premiumDecayThresholdPercent);

                if (unwinding && sellersInProfit)
                {
                    Emit(bearish: true, $"Spot {bar.Close:0.##} reached support {s:0.##} (OI-based wall) - PE writers there covering (OI {sBaseline?.PeOpenInterest:0} to {sSnap.PeOpenInterest:0} since this morning, premium decayed) while price holds - buying through");
                }
                else
                {
                    signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Rejected", "Bearish",
                        $"Spot reached support {s:0.##} (OI-based wall) but PE writers there are not clearly covering yet (unwinding={unwinding}, sellers in profit={sellersInProfit}) - skipped"));
                }
            }
        }

        return (entries, signals.OrderByDescending(sig => sig.TimeUtc).ToList());
    }

    /// <summary>The strongest CE/PE strike within oiScanSteps of ATM on the requested side, by a
    /// blend of two ranks (rank 1 = strongest) - current absolute OI, and OI buildup since this
    /// morning's baseline (current - baseline; a strike missing from Baseline is treated as zero
    /// buildup, e.g. a contract that only started trading meaningfully today). Blending RANKS rather
    /// than raw numbers avoids one series' scale (a strike with millions of OI vs. thousands of
    /// buildup) dominating the other outright regardless of oiChangeWeightPercent.</summary>
    private static (decimal? Strike, OiStrikeSnapshot? Snapshot) FindWall(
        OiChainSnapshot oi, int atmStrike, int step, int scanSteps, decimal oiChangeWeightPercent, bool isCall, bool aboveSpot)
    {
        var weight = Math.Clamp(oiChangeWeightPercent, 0, 100) / 100m;

        var candidates = new List<(decimal Strike, OiStrikeSnapshot Snapshot, long CurrentOi, long Buildup)>();
        var from = aboveSpot ? 0 : -scanSteps;
        var to = aboveSpot ? scanSteps : 0;
        for (var n = from; n <= to; n++)
        {
            var strike = atmStrike + n * step;
            if (!oi.Current.TryGetValue(strike, out var cur)) continue;

            var currentOi = isCall ? cur.CeOpenInterest : cur.PeOpenInterest;
            if (currentOi is not { } curOi || curOi <= 0) continue;

            oi.Baseline.TryGetValue(strike, out var baseSnap);
            var baseOi = (isCall ? baseSnap?.CeOpenInterest : baseSnap?.PeOpenInterest) ?? curOi;
            candidates.Add((strike, cur, curOi, curOi - baseOi));
        }

        if (candidates.Count == 0) return (null, null);

        var oiRank = candidates.OrderByDescending(c => c.CurrentOi)
            .Select((c, idx) => (c.Strike, Rank: idx + 1)).ToDictionary(x => x.Strike, x => x.Rank);
        var buildupRank = candidates.OrderByDescending(c => c.Buildup)
            .Select((c, idx) => (c.Strike, Rank: idx + 1)).ToDictionary(x => x.Strike, x => x.Rank);

        var best = candidates
            .Select(c => (c.Strike, c.Snapshot, Score: (1 - weight) / oiRank[c.Strike] + weight / buildupRank[c.Strike]))
            .OrderByDescending(c => c.Score)
            .First();

        return (best.Strike, best.Snapshot);
    }

    /// <summary>OI dropped at least thresholdPercent from baseline - "writers there covering," the
    /// user's own words. False (never a wall worth trading) when either number is missing or the
    /// baseline was already zero/negative.</summary>
    private static bool OiUnwinding(long? baselineOi, long? currentOi, decimal thresholdPercent)
    {
        if (baselineOi is not { } b || b <= 0 || currentOi is not { } c) return false;
        var dropPercent = (decimal)(b - c) / b * 100m;
        return dropPercent >= thresholdPercent;
    }

    /// <summary>The user's own two-part check for "is the writer at this strike in profit": spot is
    /// still on their winning side of the strike (at/below it for a CE writer, at/above for a PE
    /// one) AND that leg's own premium has decayed at least thresholdPercent from its morning
    /// baseline - price-vs-strike alone can't tell a strike that has barely moved from one that has
    /// genuinely decayed.</summary>
    private static bool SellersInProfit(bool isCall, decimal spot, decimal strike, decimal? baselinePremium, decimal? currentPremium, decimal thresholdPercent)
    {
        var priceCondition = isCall ? spot <= strike : spot >= strike;
        if (!priceCondition) return false;
        if (baselinePremium is not { } b || b <= 0 || currentPremium is not { } c) return false;

        var decayPercent = (b - c) / b * 100m;
        return decayPercent >= thresholdPercent;
    }
}
