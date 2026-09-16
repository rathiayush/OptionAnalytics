using OptionAnalytics.Server.Models;
using OptionAnalytics.Server.Services;
using Skender.Stock.Indicators;

namespace OptionAnalytics.Server.Services.Backtesting;

/// <summary>
/// A full rewrite, per the user's own detailed "ADAPTIVE OPTIONS SELLING STRATEGY" specification
/// (superseding every earlier version of this class, including the 15x/5x/3x/1x cascade design)
/// - REGIME is detected fresh on every 15-minute close, ALWAYS at real 15-minute bars regardless of
/// the page's own selected timeframe (the spec is explicit: "Regime detection runs only on 15-min
/// close"). ENTRY/EXIT logic runs on the page's own selected timeframe (<c>context.SpotBars</c>,
/// <c>context.TimeframeMinutes</c>) - the spec's own "chosen trading timeframe" - so switching the
/// page between 1/3/5/15-minute bars changes how often entries are evaluated and how far out
/// stops/targets/holding-time reach (via <see cref="DefaultsForTimeframe"/>), without changing what
/// counts as trending, ranging, or volatile.
///
/// REGIME (0 indicators, priority order - first match wins), computed on 15-minute bars:
///   1. HIGH_VOL: (ATR% &gt; <c>highVolAtrPctRatio</c> x its own 20-bar average OR Bollinger Band
///      Width% &gt; <c>highVolBbWidthRatio</c> x its own 20-bar average) AND ADX &gt;
///      <c>highVolAdxMin</c> - the ADX co-condition is this class's own reading of the spec's plain-
///      text rule (volatility expanding ALONGSIDE real directional movement, not just one quiet-chop
///      outlier bar).
///   2. TREND: ADX &gt; <c>trendAdxMin</c> AND |+DI - -DI| &gt; <c>trendDiSpreadMin</c> AND the
///      EMA(<c>emaPeriod</c>)'s own slope has held the SAME sign for <c>trendSlopeConsistentBars</c>
///      consecutive bars.
///   3. RANGE: ATR% &lt; <c>rangeAtrPctRatio</c> x its 20-bar average AND ADX &lt;
///      <c>rangeAdxMax</c> AND BB Width% &lt; <c>rangeBbWidthRatio</c> x its 20-bar average.
///   4. NEUTRAL: everything else.
///
/// STRATEGY PER REGIME:
///   - TREND: single-leg directional selling (Bullish -&gt; sell PE, Bearish -&gt; sell CE - this
///     app's standard credit convention, same note as every other Sell-capable strategy here) -
///     the spec's own "directional credit spread" without the protective long leg (see "WHAT THIS
///     DOES NOT DO" below).
///   - RANGE / NEUTRAL: BOTH legs at once - sell CE AND sell PE from the same bar, as two
///     INDEPENDENT concurrent positions (this class's own "Short Strangle" approximation of the
///     spec's Short Strangle/Iron Condor choice - see below). This is the ONLY case that needs more
///     than one open position at a time, per explicit instruction, and it is achieved WITHOUT
///     touching OptionTradeSimulator's own single-position walk: each leg is its own independent
///     <see cref="OptionTradeSimulator.Run"/> call over its own signal stream, so the two legs can
///     each hit their own stop/target/exit on their own schedule, exactly like two real option
///     legs would.
///   - HIGH_VOL: no new trades at all, always - the spec's own fallback for this regime ("...or stay
///     out") is the only one this app can honour faithfully; "reduce size" and "hedged/defined-risk
///     only" both need infrastructure this app does not have (see below), so this class does not
///     pretend to.
///
/// PER-TIMEFRAME DEFAULTS (<see cref="DefaultsForTimeframe"/>) supply ONE set of base values -
/// <c>baseOtmSteps</c>/<c>baseProfitTargetPercent</c>/<c>baseStopLossPercent</c>/
/// <c>baseMaxHoldingMinutes</c> - per the spec's own 1/3/5/15-minute table (picking each range's own
/// midpoint), the same "one box, default changes with the page timeframe" mechanism every other
/// strategy here already uses - switching the page timeframe does NOT add or remove a single
/// parameter box, only the pre-filled numbers in the existing ones change. REGIME MULTIPLIERS
/// (Range/Neutral/Trend, fixed per the spec's own table) then scale those four base values up or
/// down depending which regime a given signal fired in - RANGE trades tighter and closer, TREND
/// trades wider and further, exactly per the spec.
///
/// STOP-LOSS/TARGET ARE PERCENT OF THAT TRADE'S OWN ENTRY PREMIUM, not fixed points - a new,
/// additive OptionTradeSimulator.Run parameter pair (slPercentOfPremium/tpPercentOfPremium, OFF by
/// default and untouched for every other strategy) computes each trade's own stop/target from its
/// own entry price, per the spec's own "% premium" model.
///
/// EXIT (checked as the earliest of three, precomputed per signal into OptionTradeSimulator's own
/// signalExits mechanism - the same "forward-scan once, hand the simulator a single exit deadline"
/// pattern FiveEmaAsTaughtStrategy already established here):
///   1. TIME STOP - entry + that regime's own <c>baseMaxHoldingMinutes</c>.
///   2. REGIME CHANGE - the first later bar whose (now current) regime no longer matches the one
///      this trade entered on.
///   3. STRIKE BREACH - the underlying closing beyond the sold strike +/- 0.5x ATR (spec's own rule).
/// Plus the ordinary stop-loss/target (checked bar by bar by OptionTradeSimulator itself, as
/// always) and a hard <c>squareOffMinutes</c> force-close (default 15:20 IST, the spec's own final
/// rule), which OptionTradeSimulator already supports directly.
///
/// WHAT THIS DOES NOT DO - flagged explicitly rather than silently approximated, since real money is
/// involved (see this app's own established practice on this):
///   - NO option greeks/delta - there is no IV/Black-Scholes engine anywhere in this app, so the
///     spec's own delta-based OTM distance is approximated with a fixed strike-STEP count
///     (<c>baseOtmSteps</c>) instead - clearly labelled as an approximation, not a real delta.
///   - NO protective long legs - the Short Strangle above is genuinely TWO short legs, not an Iron
///     Condor's four; OptionTradeSimulator has no concept of a spread's own defined-risk long leg.
///   - NO capital-based position sizing, daily-loss-as-%-of-capital, or loss-streak size throttling -
///     this app's backtest engine has no capital/equity model at all (every other strategy here is
///     the same); "max concurrent positions = 2" is naturally satisfied by construction (Strangle =
///     exactly 2 legs, Trend = exactly 1), but capital-based sizing itself is not modelled.
///   - NO OI/Volume-ranked strike selection - open interest exists in the LIVE feed but was never
///     plumbed into what a backtest strategy can see historically.
///   - NO economic-calendar / "next 45 minutes" event filter - this app has no calendar feed; the
///     spec's own Section 1 pre-trade checklist (VIX, news, gaps) stays a human, pre-trade step, same
///     as every earlier version of this class.
/// </summary>
public sealed class RegimeAdaptiveStrategy : IBacktestStrategy
{
    public string Key => "regime-adaptive";
    public string Name => "Regime-Adaptive Option Selling (Trend / Range / High-Vol, single-timeframe regime)";
    public string Description => "Detects HIGH_VOL / TREND / RANGE / NEUTRAL every 15-minute close (ATR%, ADX+DI, RSI, Bollinger Band width, EMA slope) and adapts strike distance, profit target, stop-loss (all % of premium) and holding time to it. Trend sells one directional leg; Range/Neutral sells a two-leg short strangle (CE+PE, tracked as two independent positions); High-Vol takes no new trades. Sells options only. No VIX, no option greeks, no OI/Volume screening.";

    private const decimal DirectionBoth = 0;
    private const decimal DirectionLongOnly = 1;
    private const decimal DirectionShortOnly = 2;

    public IReadOnlyList<BacktestParameterSpec> Parameters { get; } = new[]
    {
        // ---- Time filter + shared risk cutoffs ----
        new BacktestParameterSpec("signalStartMinutes", "No entries before (IST time)", Default: 565, Min: 0, Max: 1439, Step: 1), // 09:25
        new BacktestParameterSpec("noNewEntriesAfterMinutes", "No new entries from (IST time)", Default: 885, Min: 0, Max: 1439, Step: 1), // 14:45
        new BacktestParameterSpec("squareOffMinutes", "Force-close any open position at (IST time, 0 = off)", Default: 920, Min: 0, Max: 1439, Step: 1), // 15:20
        OptionTradeSimulator.ExcludeLastDaysParameter(),
        new BacktestParameterSpec("direction", "Trend-regime direction (Range/Neutral always trade both sides)", Default: DirectionBoth, Min: DirectionBoth, Max: DirectionShortOnly, Step: 1, Options: new[]
        {
            new BacktestParameterOption(DirectionBoth, "Both sides"),
            new BacktestParameterOption(DirectionLongOnly, "Bullish only"),
            new BacktestParameterOption(DirectionShortOnly, "Bearish only"),
        }),

        // ---- Indicator periods (ONE timeframe now - 15-minute bars for regime, no per-layer pairs) ----
        new BacktestParameterSpec("atrPeriod", "ATR (bars)", Default: 14, Min: 2, Max: 100, Step: 1),
        new BacktestParameterSpec("adxPeriod", "ADX/DI (bars)", Default: 14, Min: 2, Max: 100, Step: 1),
        new BacktestParameterSpec("rsiPeriod", "RSI (bars)", Default: 14, Min: 2, Max: 100, Step: 1),
        new BacktestParameterSpec("emaPeriod", "EMA (bars)", Default: 20, Min: 2, Max: 200, Step: 1),
        new BacktestParameterSpec("bbPeriod", "Bollinger Bands (bars)", Default: 20, Min: 2, Max: 100, Step: 1),
        new BacktestParameterSpec("bbStdDev", "Bollinger Bands width (std deviations)", Default: 2, Min: 1, Max: 4, Step: 0.1m),
        new BacktestParameterSpec("rollingAverageLookback", "ATR%/BB-width own rolling average window (bars)", Default: 20, Min: 5, Max: 100, Step: 1),
        new BacktestParameterSpec("emaSlopeLookbackBars", "EMA slope measured over (bars)", Default: 5, Min: 1, Max: 50, Step: 1),
        new BacktestParameterSpec("trendSlopeConsistentBars", "EMA slope must hold the same direction for at least (bars)", Default: 4, Min: 1, Max: 20, Step: 1),

        // ---- Regime thresholds ----
        new BacktestParameterSpec("highVolAtrPctRatio", "High-Vol: ATR% vs its own average, at least", Default: 1.2m, Min: 1, Max: 5, Step: 0.05m),
        new BacktestParameterSpec("highVolBbWidthRatio", "High-Vol: BB width% vs its own average, at least", Default: 1.4m, Min: 1, Max: 5, Step: 0.05m),
        new BacktestParameterSpec("highVolAdxMin", "High-Vol: ADX must also be at least", Default: 22, Min: 0, Max: 80, Step: 1),
        new BacktestParameterSpec("trendAdxMin", "Trend: ADX must be at least", Default: 28, Min: 0, Max: 80, Step: 1),
        new BacktestParameterSpec("trendDiSpreadMin", "Trend: |+DI - -DI| must be at least", Default: 12, Min: 0, Max: 80, Step: 1),
        new BacktestParameterSpec("rangeAtrPctRatio", "Range: ATR% vs its own average, at most", Default: 0.85m, Min: 0.1m, Max: 1, Step: 0.05m),
        new BacktestParameterSpec("rangeAdxMax", "Range: ADX must be at most", Default: 20, Min: 0, Max: 80, Step: 1),
        new BacktestParameterSpec("rangeBbWidthRatio", "Range: BB width% vs its own average, at most", Default: 0.9m, Min: 0.1m, Max: 1, Step: 0.05m),

        // ---- Range/Neutral entry gates (price action, on the ENTRY/page timeframe) ----
        new BacktestParameterSpec("rsiRangeLow", "Range/Neutral entries need RSI above", Default: 35, Min: 0, Max: 50, Step: 1),
        new BacktestParameterSpec("rsiRangeHigh", "Range/Neutral entries need RSI below", Default: 65, Min: 50, Max: 100, Step: 1),

        // ---- Per-timeframe base values (see DefaultsForTimeframe - ONE box each, default changes
        // with the page's own selected timeframe) ----
        new BacktestParameterSpec("baseOtmSteps", "Base OTM distance (strike steps - a delta proxy, see class doc comment)", Default: 3, Min: 0, Max: 20, Step: 1),
        new BacktestParameterSpec("baseProfitTargetPercent", "Base profit target (% of premium collected)", Default: 38, Min: 1, Max: 100, Step: 1),
        new BacktestParameterSpec("baseStopLossPercent", "Base stop-loss (% of premium collected)", Default: 75, Min: 1, Max: 300, Step: 1),
        new BacktestParameterSpec("baseMaxHoldingMinutes", "Base max holding time (minutes from entry)", Default: 150, Min: 5, Max: 1000, Step: 5),

        // ---- Regime multipliers on the four base values above (spec's own table) ----
        new BacktestParameterSpec("rangePtMult", "Range: profit-target multiplier", Default: 0.80m, Min: 0.1m, Max: 3, Step: 0.05m),
        new BacktestParameterSpec("rangeSlMult", "Range: stop-loss multiplier", Default: 0.90m, Min: 0.1m, Max: 3, Step: 0.05m),
        new BacktestParameterSpec("rangeOtmMult", "Range: OTM-distance multiplier", Default: 0.85m, Min: 0.1m, Max: 3, Step: 0.05m),
        new BacktestParameterSpec("neutralPtMult", "Neutral: profit-target multiplier", Default: 1.00m, Min: 0.1m, Max: 3, Step: 0.05m),
        new BacktestParameterSpec("neutralSlMult", "Neutral: stop-loss multiplier", Default: 1.00m, Min: 0.1m, Max: 3, Step: 0.05m),
        new BacktestParameterSpec("neutralOtmMult", "Neutral: OTM-distance multiplier", Default: 1.00m, Min: 0.1m, Max: 3, Step: 0.05m),
        new BacktestParameterSpec("trendPtMult", "Trend: profit-target multiplier", Default: 1.20m, Min: 0.1m, Max: 3, Step: 0.05m),
        new BacktestParameterSpec("trendSlMult", "Trend: stop-loss multiplier", Default: 1.30m, Min: 0.1m, Max: 3, Step: 0.05m),
        new BacktestParameterSpec("trendOtmMult", "Trend: OTM-distance multiplier", Default: 1.25m, Min: 0.1m, Max: 3, Step: 0.05m),
    };

    /// <summary>The spec's own 1/3/5/15-minute table (each range's own midpoint) - the SAME "one
    /// parameter box, default changes with the page timeframe" mechanism every other strategy here
    /// uses, not a new one. Falls back to the 5-minute row for any timeframe outside the four this
    /// app's own TIMEFRAME_OPTIONS actually offers.</summary>
    public IReadOnlyDictionary<string, decimal> DefaultsForTimeframe(int timeframeMinutes)
    {
        var (otmSteps, ptPercent, slPercent, maxHoldMinutes) = timeframeMinutes switch
        {
            1 => (2m, 27.5m, 55m, 52m),
            3 => (3m, 32.5m, 62.5m, 105m),
            15 => (4m, 45m, 90m, 270m),
            _ => (3m, 38m, 75m, 150m), // 5-minute row, and the fallback for anything else
        };
        return new Dictionary<string, decimal>
        {
            ["baseOtmSteps"] = otmSteps,
            ["baseProfitTargetPercent"] = ptPercent,
            ["baseStopLossPercent"] = slPercent,
            ["baseMaxHoldingMinutes"] = maxHoldMinutes,
        };
    }

    public IReadOnlyList<BacktestTrade> Simulate(BacktestStrategyContext context, IReadOnlyDictionary<string, decimal> parameters) =>
        Evaluate(context, parameters).Trades;

    public IReadOnlyList<BacktestSignal> EntrySignals(BacktestStrategyContext context, IReadOnlyDictionary<string, decimal> parameters) =>
        Evaluate(context, parameters).Signals;

    private sealed record LegStream(string RegimeType, bool IsCall, int OtmSteps, decimal PtPercent, decimal SlPercent)
    {
        public List<(DateTimeOffset Time, string Direction)> Signals { get; } = new();
        public Dictionary<DateTimeOffset, (DateTimeOffset Time, string Reason)> Exits { get; } = new();
    }

    private (IReadOnlyList<BacktestTrade> Trades, IReadOnlyList<BacktestSignal> Signals) Evaluate(
        BacktestStrategyContext context, IReadOnlyDictionary<string, decimal> parameters)
    {
        var direction = parameters.GetValueOrDefault("direction", DirectionBoth);
        var takeLongs = direction != DirectionShortOnly;
        var takeShorts = direction != DirectionLongOnly;
        var signalStartMinutes = (int)parameters.GetValueOrDefault("signalStartMinutes", 565m);
        var noNewEntriesAfterMinutes = (int)parameters.GetValueOrDefault("noNewEntriesAfterMinutes", 885m);
        var squareOffMinutes = (int)parameters.GetValueOrDefault("squareOffMinutes", 920m);
        var excludeLastDays = (int)parameters.GetValueOrDefault("excludeLastDays", 0m);

        var atrPeriod = Math.Max(2, (int)parameters.GetValueOrDefault("atrPeriod", 14m));
        var adxPeriod = Math.Max(2, (int)parameters.GetValueOrDefault("adxPeriod", 14m));
        var rsiPeriod = Math.Max(2, (int)parameters.GetValueOrDefault("rsiPeriod", 14m));
        var emaPeriod = Math.Max(2, (int)parameters.GetValueOrDefault("emaPeriod", 20m));
        var bbPeriod = Math.Max(2, (int)parameters.GetValueOrDefault("bbPeriod", 20m));
        var bbStdDev = (double)parameters.GetValueOrDefault("bbStdDev", 2m);
        var rollingAverageLookback = Math.Max(2, (int)parameters.GetValueOrDefault("rollingAverageLookback", 20m));
        var emaSlopeLookback = Math.Max(1, (int)parameters.GetValueOrDefault("emaSlopeLookbackBars", 5m));
        var trendSlopeConsistentBars = Math.Max(1, (int)parameters.GetValueOrDefault("trendSlopeConsistentBars", 4m));

        var highVolAtrPctRatio = parameters.GetValueOrDefault("highVolAtrPctRatio", 1.2m);
        var highVolBbWidthRatio = parameters.GetValueOrDefault("highVolBbWidthRatio", 1.4m);
        var highVolAdxMin = parameters.GetValueOrDefault("highVolAdxMin", 22m);
        var trendAdxMin = parameters.GetValueOrDefault("trendAdxMin", 28m);
        var trendDiSpreadMin = parameters.GetValueOrDefault("trendDiSpreadMin", 12m);
        var rangeAtrPctRatio = parameters.GetValueOrDefault("rangeAtrPctRatio", 0.85m);
        var rangeAdxMax = parameters.GetValueOrDefault("rangeAdxMax", 20m);
        var rangeBbWidthRatio = parameters.GetValueOrDefault("rangeBbWidthRatio", 0.9m);

        var rsiRangeLow = parameters.GetValueOrDefault("rsiRangeLow", 35m);
        var rsiRangeHigh = parameters.GetValueOrDefault("rsiRangeHigh", 65m);

        var baseOtmSteps = Math.Max(0, (int)parameters.GetValueOrDefault("baseOtmSteps", 3m));
        var basePt = parameters.GetValueOrDefault("baseProfitTargetPercent", 38m);
        var baseSl = parameters.GetValueOrDefault("baseStopLossPercent", 75m);
        var baseMaxHold = parameters.GetValueOrDefault("baseMaxHoldingMinutes", 150m);

        var rangePtMult = parameters.GetValueOrDefault("rangePtMult", 0.80m);
        var rangeSlMult = parameters.GetValueOrDefault("rangeSlMult", 0.90m);
        var rangeOtmMult = parameters.GetValueOrDefault("rangeOtmMult", 0.85m);
        var neutralPtMult = parameters.GetValueOrDefault("neutralPtMult", 1.00m);
        var neutralSlMult = parameters.GetValueOrDefault("neutralSlMult", 1.00m);
        var neutralOtmMult = parameters.GetValueOrDefault("neutralOtmMult", 1.00m);
        var trendPtMult = parameters.GetValueOrDefault("trendPtMult", 1.20m);
        var trendSlMult = parameters.GetValueOrDefault("trendSlMult", 1.30m);
        var trendOtmMult = parameters.GetValueOrDefault("trendOtmMult", 1.25m);

        var noTrades = (Array.Empty<BacktestTrade>() as IReadOnlyList<BacktestTrade>, Array.Empty<BacktestSignal>() as IReadOnlyList<BacktestSignal>);

        var oneMin = context.SpotBarsOneMinute;
        var pageBars = context.SpotBars;
        if (oneMin.Count < 30 || pageBars.Count < 2) return noTrades;

        // REGIME is always on real 15-minute bars, independent of the page's own timeframe - see
        // this class's own doc comment for why.
        var bars15 = BacktestUtil.AggregateCandles(oneMin, 15);
        if (bars15.Count < rollingAverageLookback + emaPeriod + emaSlopeLookback + trendSlopeConsistentBars + 5) return noTrades;

        var quotes15 = ToQuotes(bars15);
        var atr15Raw = quotes15.GetAtr(atrPeriod).ToList();
        var atr15 = atr15Raw.Select(r => (decimal?)r.Atr).ToList();
        var atrPct15 = bars15.Select((b, i) => atr15[i] is { } a && b.Close != 0 ? (decimal?)(a / b.Close * 100m) : null).ToList();
        var adxRaw15 = quotes15.GetAdx(adxPeriod).ToList();
        var adxValue15 = adxRaw15.Select(r => (decimal?)r.Adx).ToList();
        var pdi15 = adxRaw15.Select(r => (decimal?)r.Pdi).ToList();
        var mdi15 = adxRaw15.Select(r => (decimal?)r.Mdi).ToList();
        var rsi15 = quotes15.GetRsi(rsiPeriod).Select(r => (decimal?)r.Rsi).ToList();
        var bb15 = quotes15.GetBollingerBands(bbPeriod, bbStdDev).ToList();
        var bbWidth15 = bb15.Select(r => (decimal?)r.Width).ToList();
        var bbUpper15 = bb15.Select(r => (decimal?)r.UpperBand).ToList();
        var bbLower15 = bb15.Select(r => (decimal?)r.LowerBand).ToList();
        var ema15 = EmaCrossoverDetector.EmaSeries(bars15, emaPeriod);

        var (regimeType15, regimeDirection15) = ClassifyRegime(
            atrPct15, bbWidth15, adxValue15, pdi15, mdi15, ema15,
            rollingAverageLookback, emaSlopeLookback, trendSlopeConsistentBars,
            highVolAtrPctRatio, highVolBbWidthRatio, highVolAdxMin,
            trendAdxMin, trendDiSpreadMin,
            rangeAtrPctRatio, rangeAdxMax, rangeBbWidthRatio);

        // ---- Align every regime-layer series onto the ENTRY/page timeframe (safe, non-look-ahead -
        // see AlignStepToTime's own doc comment) ----
        var regimeTypeOnPage = AlignStepToTime(bars15, regimeType15, 15, pageBars, context.TimeframeMinutes, (string?)null);
        var regimeDirectionOnPage = AlignStepToTime(bars15, regimeDirection15, 15, pageBars, context.TimeframeMinutes, (string?)null);
        var bbUpperOnPage = AlignStepToTime(bars15, bbUpper15, 15, pageBars, context.TimeframeMinutes, (decimal?)null);
        var bbLowerOnPage = AlignStepToTime(bars15, bbLower15, 15, pageBars, context.TimeframeMinutes, (decimal?)null);
        var rsiOnPage = AlignStepToTime(bars15, rsi15, 15, pageBars, context.TimeframeMinutes, (decimal?)null);
        var atrOnPage = AlignStepToTime(bars15, atr15, 15, pageBars, context.TimeframeMinutes, (decimal?)null);

        var step = context.Step;
        var streams = new Dictionary<(string RegimeType, bool IsCall), LegStream>();

        LegStream StreamFor(string regimeType, bool isCall)
        {
            var key = (regimeType, isCall);
            if (streams.TryGetValue(key, out var existing)) return existing;
            var (ptMult, slMult, otmMult) = regimeType switch
            {
                "Range" => (rangePtMult, rangeSlMult, rangeOtmMult),
                "Trend" => (trendPtMult, trendSlMult, trendOtmMult),
                _ => (neutralPtMult, neutralSlMult, neutralOtmMult),
            };
            var stream = new LegStream(regimeType, isCall, Math.Max(0, (int)Math.Round(baseOtmSteps * otmMult)), basePt * ptMult, baseSl * slMult);
            streams[key] = stream;
            return stream;
        }

        var signals = new List<BacktestSignal>();

        (DateTimeOffset Time, string Reason) ComputeExit(int entryIndex, bool isCall, decimal strike, decimal maxHoldMinutes, string regimeTypeAtEntry)
        {
            var entryTime = pageBars[entryIndex].Time;
            var deadline = entryTime.AddMinutes((double)maxHoldMinutes);
            DateTimeOffset? regimeChangeTime = null;
            DateTimeOffset? breachTime = null;

            for (var j = entryIndex + 1; j < pageBars.Count; j++)
            {
                var bar = pageBars[j];
                if (regimeChangeTime is null && regimeTypeOnPage[j] != regimeTypeAtEntry) regimeChangeTime = bar.Time;
                if (breachTime is null && atrOnPage[j] is { } atrNow)
                {
                    var breached = isCall ? bar.Close >= strike + 0.5m * atrNow : bar.Close <= strike - 0.5m * atrNow;
                    if (breached) breachTime = bar.Time;
                }
                if (bar.Time >= deadline || (regimeChangeTime is not null && breachTime is not null)) break;
            }

            var candidates = new List<(DateTimeOffset Time, string Reason)> { (deadline, "TimeStop") };
            if (regimeChangeTime is { } rc) candidates.Add((rc, "RegimeChange"));
            if (breachTime is { } bt) candidates.Add((bt, "StrikeBreach"));
            return candidates.OrderBy(c => c.Time).First();
        }

        void TryEnter(int i, bool bullish, string regimeType, string reasonSummary)
        {
            var time = pageBars[i].Time;
            var minutesOfDay = IstClock.MinutesOfDay(time);
            var beforeStart = signalStartMinutes > 0 && minutesOfDay < signalStartMinutes;
            var afterCutoff = noNewEntriesAfterMinutes > 0 && minutesOfDay >= noNewEntriesAfterMinutes;
            var directionBlocked = regimeType == "Trend" && ((bullish && !takeLongs) || (!bullish && !takeShorts));

            if (beforeStart)
                signals.Add(new BacktestSignal(context.Underlying, time, "Rejected", bullish ? "Bullish" : "Bearish", $"{reasonSummary} - skipped, before {IstClock.FormatMinutesOfDay(signalStartMinutes)} IST"));
            else if (afterCutoff)
                signals.Add(new BacktestSignal(context.Underlying, time, "Rejected", bullish ? "Bullish" : "Bearish", $"{reasonSummary} - skipped, at/after {IstClock.FormatMinutesOfDay(noNewEntriesAfterMinutes)} IST (no new entries)"));
            else if (directionBlocked)
                signals.Add(new BacktestSignal(context.Underlying, time, "Rejected", bullish ? "Bullish" : "Bearish", $"{reasonSummary} - skipped, direction filter"));
            else
            {
                var isCall = !bullish; // this strategy sells only - Bullish->sell PE, Bearish->sell CE
                var stream = StreamFor(regimeType, isCall);
                var atmAtSignal = step > 0 ? Math.Round(pageBars[i].Close / step) * step : pageBars[i].Close;
                var strike = isCall ? atmAtSignal + stream.OtmSteps * step : atmAtSignal - stream.OtmSteps * step;

                stream.Signals.Add((time, bullish ? "Bullish" : "Bearish"));
                // Max holding time varies by TIMEFRAME (baseMaxHold, via DefaultsForTimeframe), not
                // by regime - the spec gives no separate per-regime holding-time multiplier the way
                // it does for PT/SL/OTM.
                stream.Exits[time] = ComputeExit(i, isCall, strike, baseMaxHold, regimeType);
                signals.Add(new BacktestSignal(context.Underlying, time, "Entry", bullish ? "Bullish" : "Bearish", $"{reasonSummary} -> sell {(isCall ? "CE" : "PE")} {stream.OtmSteps} OTM (PT {stream.PtPercent:0.#}%, SL {stream.SlPercent:0.#}% of premium)"));
            }
        }

        for (var i = 1; i < pageBars.Count; i++)
        {
            if (regimeTypeOnPage[i] is not { } regimeType || regimeType == "HighVol") continue;

            if (regimeType == "Trend")
            {
                if (regimeDirectionOnPage[i] is not { } dir) continue;
                TryEnter(i, dir == "Bullish", "Trend", $"Trend regime {dir} (ADX/DI + EMA{emaPeriod} slope confirmed)");
                continue;
            }

            // Range / Neutral - the two-leg short strangle, per explicit instruction the only case
            // that needs more than one concurrent position.
            if (bbUpperOnPage[i] is not { } bbUpper || bbLowerOnPage[i] is not { } bbLower) continue;
            if (rsiOnPage[i] is not { } rsiNow) continue;
            var priceInsideBands = pageBars[i].Close > bbLower && pageBars[i].Close < bbUpper;
            var rsiOk = rsiNow > rsiRangeLow && rsiNow < rsiRangeHigh;
            if (!priceInsideBands || !rsiOk) continue;

            var summary = $"{regimeType} regime, price inside BB, RSI {rsiNow:0.#} - Short Strangle";
            TryEnter(i, true, regimeType, summary); // Bullish leg -> sell PE
            TryEnter(i, false, regimeType, summary); // Bearish leg -> sell CE
        }

        var trades = new List<BacktestTrade>();
        foreach (var stream in streams.Values)
        {
            if (stream.Signals.Count == 0) continue;
            var streamParameters = new Dictionary<string, decimal>(parameters)
            {
                ["side"] = OptionTradeSimulator.SideSell,
                ["otmSteps"] = stream.OtmSteps,
                ["slPoints"] = 0m,
                ["tpPoints"] = 0m,
                ["slPercentOfPremium"] = stream.SlPercent,
                ["tpPercentOfPremium"] = stream.PtPercent,
                ["squareOffMinutes"] = squareOffMinutes,
                ["excludeLastDays"] = excludeLastDays,
            };
            trades.AddRange(OptionTradeSimulator.Run(context, stream.Signals, streamParameters, signalExits: stream.Exits));
        }

        return (trades.OrderByDescending(t => t.SignalTimeUtc).ToList(), signals.OrderByDescending(s => s.TimeUtc).ToList());
    }

    /// <summary>The REGIME priority classification (see this class's own doc comment for the exact
    /// rules) - internal (not private) so RegimeAdaptiveStrategyTests can exercise each branch
    /// directly with small, hand-built indicator series, rather than needing a full multi-thousand-
    /// bar price fixture that happens to also trip the exact regime being tested. One entry per
    /// <paramref name="atrPct"/> index; <c>Type</c> is "HighVol"/"Trend"/"Range"/"Neutral" or null
    /// where there is not yet enough warmup data; <c>Direction</c> is "Bullish"/"Bearish" for
    /// "Trend" only, null otherwise.</summary>
    internal static (string?[] Type, string?[] Direction) ClassifyRegime(
        IReadOnlyList<decimal?> atrPct, IReadOnlyList<decimal?> bbWidth, IReadOnlyList<decimal?> adx,
        IReadOnlyList<decimal?> pdi, IReadOnlyList<decimal?> mdi, IReadOnlyList<decimal?> ema,
        int rollingAverageLookback, int emaSlopeLookback, int trendSlopeConsistentBars,
        decimal highVolAtrPctRatio, decimal highVolBbWidthRatio, decimal highVolAdxMin,
        decimal trendAdxMin, decimal trendDiSpreadMin,
        decimal rangeAtrPctRatio, decimal rangeAdxMax, decimal rangeBbWidthRatio)
    {
        var atrPctAvg = RollingAverage(atrPct, rollingAverageLookback);
        var bbWidthAvg = RollingAverage(bbWidth, rollingAverageLookback);

        var type = new string?[atrPct.Count];
        var direction = new string?[atrPct.Count];

        for (var i = 0; i < atrPct.Count; i++)
        {
            if (atrPct[i] is not { } atrPctNow) continue;
            if (atrPctAvg[i] is not { } atrPctAvgNow || atrPctAvgNow <= 0) continue;
            if (bbWidth[i] is not { } bbWidthNow) continue;
            if (bbWidthAvg[i] is not { } bbWidthAvgNow || bbWidthAvgNow <= 0) continue;
            if (adx[i] is not { } adxNow) continue;

            var highVol = (atrPctNow > highVolAtrPctRatio * atrPctAvgNow || bbWidthNow > highVolBbWidthRatio * bbWidthAvgNow) && adxNow > highVolAdxMin;

            string? trendDir = null;
            if (!highVol && pdi[i] is { } p && mdi[i] is { } m && Math.Abs(p - m) > trendDiSpreadMin && adxNow > trendAdxMin)
            {
                var signs = new List<int>();
                for (var k = 0; k < trendSlopeConsistentBars && signs is not null; k++)
                {
                    var idx = i - k;
                    var sl = idx >= 0 ? Slope(ema, idx, emaSlopeLookback) : null;
                    if (sl is not { } slv || slv == 0) { signs = null; break; }
                    signs.Add(Math.Sign(slv));
                }
                if (signs is { Count: > 0 } && signs.Distinct().Count() == 1)
                    trendDir = signs[0] > 0 ? "Bullish" : "Bearish";
            }

            var range = !highVol && trendDir is null && atrPctNow < rangeAtrPctRatio * atrPctAvgNow && adxNow < rangeAdxMax && bbWidthNow < rangeBbWidthRatio * bbWidthAvgNow;

            type[i] = highVol ? "HighVol" : trendDir is not null ? "Trend" : range ? "Range" : "Neutral";
            direction[i] = trendDir;
        }

        return (type, direction);
    }

    internal static List<decimal?> RollingAverage(IReadOnlyList<decimal?> series, int lookback)
    {
        var result = new List<decimal?>(series.Count);
        for (var i = 0; i < series.Count; i++)
        {
            if (i + 1 < lookback) { result.Add(null); continue; }
            decimal sum = 0;
            var ok = true;
            for (var k = i - lookback + 1; k <= i; k++)
            {
                if (series[k] is not { } v) { ok = false; break; }
                sum += v;
            }
            result.Add(ok ? sum / lookback : null);
        }
        return result;
    }

    private static decimal? Slope(IReadOnlyList<decimal?> series, int index, int lookback)
    {
        if (index - lookback < 0) return null;
        if (series[index] is not { } now || series[index - lookback] is not { } past || past == 0) return null;
        return (now - past) / Math.Abs(past) * 100m;
    }

    private static List<Quote> ToQuotes(IReadOnlyList<Candle> bars) => bars.Select(c => new Quote
    {
        Date = c.Time.UtcDateTime,
        Open = c.Open,
        High = c.High,
        Low = c.Low,
        Close = c.Close,
        Volume = 0,
    }).ToList();

    /// <summary>Aligns a coarser (regimeBucketMinutes-sized) step-series onto a finer target bar
    /// series, using each side's own CLOSE time (bucket start + its own span) rather than raw open
    /// time - never lets a target bar use a source bucket before that bucket has genuinely closed
    /// relative to the target's own close. See RegimeAdaptiveStrategy's git history for the
    /// look-ahead bug this fixed.</summary>
    private static List<T> AlignStepToTime<T>(
        IReadOnlyList<Candle> sourceBars, IReadOnlyList<T> sourceValues, int sourceBucketMinutes,
        IReadOnlyList<Candle> targetBars, int targetBucketMinutes, T defaultValue)
    {
        var sourceSpan = TimeSpan.FromMinutes(sourceBucketMinutes);
        var targetSpan = TimeSpan.FromMinutes(targetBucketMinutes);
        var result = new List<T>(targetBars.Count);
        var pointer = 0;
        var current = defaultValue;
        foreach (var bar in targetBars)
        {
            var targetKnownAt = bar.Time + targetSpan;
            while (pointer < sourceBars.Count && sourceBars[pointer].Time + sourceSpan <= targetKnownAt)
            {
                current = sourceValues[pointer];
                pointer++;
            }
            result.Add(current);
        }
        return result;
    }
}
