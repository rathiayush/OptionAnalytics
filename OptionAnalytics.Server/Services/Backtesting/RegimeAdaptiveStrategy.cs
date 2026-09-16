using OptionAnalytics.Server.Models;
using OptionAnalytics.Server.Services;
using Skender.Stock.Indicators;

namespace OptionAnalytics.Server.Services.Backtesting;

/// <summary>
/// A genuine multi-timeframe cascade, per the user's own follow-up refinement of the "NIFTY &amp;
/// BANKNIFTY - Adaptive Option Selling Strategy" flowchart: 15-minute REGIME -&gt; 5-minute SETUP -&gt;
/// 3-minute CONFIRM -&gt; 1-minute ENTRY, each stage gating the next, rather than one score computed
/// off a single timeframe. All four timeframes are built once per run straight from
/// <see cref="BacktestStrategyContext.SpotBarsOneMinute"/> (via BacktestUtil.AggregateCandles) and
/// used together on EVERY run, independent of whatever timeframe the Backtrack/Expired Backtest page
/// itself happens to be set to - the page's own timeframe only still matters for the Range-fade path
/// and the ATR volatility gate below, which is why DefaultsForTimeframe still scales those two and
/// nothing else here.
///
/// REGIME SCORE (0-5), computed fresh on every 15-minute bar:
///   1. 15M EMA ALIGNMENT: EMA-fast &gt; EMA-mid (Bearish is the mirror) - this point is MANDATORY;
///      without a directional stack there is no candidate direction to score the other four against.
///   2. 15M EMA SLOPE: that same fast EMA's slope (over <c>cascadeSlopeLookbackBars</c>) at least
///      +<c>regime15SlopeMinPercent</c> in the aligned direction.
///   3. 15M ADX &gt;= <c>regime15AdxMin</c>.
///   4. PRICE VS VWAP: the 15-minute bar's own close on the aligned side of session VWAP.
///   5. 5M EMA CONFIRMATION: the 5-minute EMA stack (its OWN pair, <c>setup5EmaFast</c>/
///      <c>setup5EmaSlow</c>) agrees with the same direction.
/// Score &gt;= <c>regimeScoreFull</c> (4) is full-confidence Trend; score &gt;= <c>regimeScoreMin</c>
/// (3) but below that is still attempted, just labelled "selective/reduced confidence" in the signal
/// text (this app has no lot-size/quantity model to actually reduce a real position by); anything
/// below <c>regimeScoreMin</c> never attempts a trend trade at all - the Range path picks it up
/// instead, per the flowchart's own "0-2 -&gt; don't use trend strategy."
///
/// THE CASCADE ITSELF, once a 15-minute bar's regime clears <c>regimeScoreMin</c>, at every
/// 1-minute bar for as long as that 15-minute regime holds:
///   - 5M SETUP: the 5-minute EMA stack + ADX(&gt;=<c>setup5AdxMin</c>) + price on the matching side
///     of VWAP, all on the 5-minute bar most recently closed at or before this 1-minute bar's time.
///   - 3M CONFIRM: the 3-minute EMA stack + ADX(&gt;=<c>confirm3AdxMin</c>) + slope
///     (&gt;=<c>confirm3SlopeMinPercent</c>) + that 3-minute bar's own candle closing in the trend's
///     direction (close vs open) - the flowchart's own "confirmation candle closes bullish."
///   - 1M ENTRY: the 1-minute EMA-fast/EMA-mid pair (<c>entry1EmaFast</c>/<c>entry1EmaSlow</c>)
///     crossing back in the trend's favor (a pullback that just got rejected), plus its own
///     ADX(&gt;=<c>entry1AdxMin</c>)/slope(&gt;=<c>entry1SlopeMinPercent</c>) gates and an RSI-neutral
///     check (<c>rsiNeutralLow</c>-<c>rsiNeutralHigh</c>) so the entry isn't sold into what might
///     already be a breakout.
/// All four stages have to agree on the SAME bar for an entry to fire - a real confluence
/// requirement, so entries are expected to be rare (this is intentional, not a bug: waiting for a
/// genuine multi-timeframe lineup is the whole point of a cascade over a single-timeframe score).
///
/// RANGE STRATEGY: unchanged in mechanism from the single-timeframe version - fades the extremes of
/// a VWAP+-ATR band on the PAGE's own timeframe (<c>rangeAtrMultiple</c> x ATR either side of VWAP),
/// RSI-neutral gated - but now only attempted when the 15-minute regime score reads below
/// <c>regimeScoreMin</c> (i.e., genuinely not trending), so this and the cascade above never both
/// fire into the same market condition.
///
/// OPTION SIDE, ORDER FLOW, and everything this class still deliberately does NOT do (true
/// simultaneous Iron Condor selling, India VIX, position sizing/daily-loss/consecutive-SL state,
/// regime-segmented performance reporting, OI/Volume strike screening) are UNCHANGED from the
/// single-timeframe version - see the CE/PE direction note below, still worth a second look given
/// real money is involved.
///
/// Bullish -&gt; sell PE, Bearish -&gt; sell CE is OptionTradeSimulator.Run's own existing Sell
/// convention (isCall = isSell ? !isBullish : isBullish), the standard defined-direction credit
/// convention - the flowchart's own Trade Direction text ("Uptrend -&gt; Sell CE") reads backwards
/// from that and from every other Sell-capable strategy already shipped here, so this class keeps the
/// standard/existing mapping rather than the literal text.
/// </summary>
public sealed class RegimeAdaptiveStrategy : IBacktestStrategy
{
    public string Key => "regime-adaptive";
    public string Name => "Regime-Adaptive Option Selling (15M->5M->3M->1M Cascade)";
    public string Description => "A genuine multi-timeframe cascade: 15-minute regime score (EMA stack+slope, ADX, VWAP side, 5-minute confirmation) gates a 5-minute setup, a 3-minute confirmation candle, and a 1-minute pullback-rejection entry, all built from the underlying's own 1-minute history regardless of the page's selected timeframe. Falls back to a VWAP+-ATR range fade (RSI-neutral gated) when the 15-minute regime isn't trending. Sells options by default; CDV/OBV order-flow confirmation is ON by default here.";

    private const decimal DirectionBoth = 0;
    private const decimal DirectionLongOnly = 1;
    private const decimal DirectionShortOnly = 2;

    private const decimal FlagOff = 0;
    private const decimal FlagOn = 1;

    public IReadOnlyList<BacktestParameterSpec> Parameters { get; } = new[]
    {
        // Sells by default (every other strategy here defaults to Buy) - see this class's own doc
        // comment on why, and on the CE/PE direction convention this relies on.
        new BacktestParameterSpec("side", "Position", Default: OptionTradeSimulator.SideSell, Min: OptionTradeSimulator.SideBuy, Max: OptionTradeSimulator.SideSell, Step: 1, Options: new[]
        {
            new BacktestParameterOption(OptionTradeSimulator.SideBuy, "Buy option"),
            new BacktestParameterOption(OptionTradeSimulator.SideSell, "Sell option (credit) - this strategy's own default"),
        }),
        OptionTradeSimulator.StrikeOffsetParameter(),
        OptionTradeSimulator.StopLossParameter(),
        OptionTradeSimulator.TakeProfitParameter(),
        OptionTradeSimulator.SquareOffTimeParameter(),
        // 09:30, not the shared 09:15 default - "observe only" 9:15-9:30 per the flowchart.
        new BacktestParameterSpec("signalStartMinutes", "No signals before (IST time, 0 = off)", Default: 570, Min: 0, Max: 1439, Step: 1),
        new BacktestParameterSpec("noNewEntriesAfterMinutes", "No new entries from (IST time, 0 = off)", Default: 0, Min: 0, Max: 1439, Step: 1),
        OptionTradeSimulator.ExcludeLastDaysParameter(),
        new BacktestParameterSpec("direction", "Take", Default: DirectionBoth, Min: DirectionBoth, Max: DirectionShortOnly, Step: 1, Options: new[]
        {
            new BacktestParameterOption(DirectionBoth, "Both sides"),
            new BacktestParameterOption(DirectionLongOnly, "Bullish only"),
            new BacktestParameterOption(DirectionShortOnly, "Bearish only"),
        }),

        // ---- 15-minute regime (fixed to real 15-minute bars, independent of the page timeframe) ----
        new BacktestParameterSpec("regime15EmaFast", "15-min regime EMA fast (bars)", Default: 20, Min: 3, Max: 100, Step: 1),
        new BacktestParameterSpec("regime15EmaSlow", "15-min regime EMA slow (bars)", Default: 50, Min: 5, Max: 300, Step: 1),
        new BacktestParameterSpec("regime15SlopeMinPercent", "15-min EMA slope must be at least (%)", Default: 0.050m, Min: 0, Max: 5, Step: 0.005m),
        new BacktestParameterSpec("regime15AdxMin", "15-min ADX must be at least", Default: 25, Min: 0, Max: 80, Step: 1),
        new BacktestParameterSpec("regimeScoreMin", "Regime score needed (out of 5) to even attempt a trend trade", Default: 3, Min: 1, Max: 5, Step: 1),
        new BacktestParameterSpec("regimeScoreFull", "Regime score needed (out of 5) for full confidence (below = selective)", Default: 4, Min: 1, Max: 5, Step: 1),

        // ---- 5-minute setup ----
        new BacktestParameterSpec("setup5EmaFast", "5-min setup EMA fast (bars)", Default: 9, Min: 2, Max: 100, Step: 1),
        new BacktestParameterSpec("setup5EmaSlow", "5-min setup EMA slow (bars)", Default: 21, Min: 3, Max: 200, Step: 1),
        new BacktestParameterSpec("setup5AdxMin", "5-min ADX must be at least", Default: 25, Min: 0, Max: 80, Step: 1),

        // ---- 3-minute confirmation ----
        new BacktestParameterSpec("confirm3EmaFast", "3-min confirm EMA fast (bars)", Default: 7, Min: 2, Max: 100, Step: 1),
        new BacktestParameterSpec("confirm3EmaSlow", "3-min confirm EMA slow (bars)", Default: 20, Min: 3, Max: 200, Step: 1),
        new BacktestParameterSpec("confirm3AdxMin", "3-min ADX must be at least", Default: 23, Min: 0, Max: 80, Step: 1),
        new BacktestParameterSpec("confirm3SlopeMinPercent", "3-min EMA slope must be at least (%)", Default: 0.025m, Min: 0, Max: 5, Step: 0.005m),

        // ---- 1-minute entry ----
        new BacktestParameterSpec("entry1EmaFast", "1-min entry EMA fast (bars)", Default: 5, Min: 2, Max: 100, Step: 1),
        new BacktestParameterSpec("entry1EmaSlow", "1-min entry EMA slow (bars)", Default: 13, Min: 3, Max: 200, Step: 1),
        new BacktestParameterSpec("entry1AdxMin", "1-min ADX must be at least", Default: 22, Min: 0, Max: 80, Step: 1),
        new BacktestParameterSpec("entry1SlopeMinPercent", "1-min EMA slope must be at least (%)", Default: 0.015m, Min: 0, Max: 5, Step: 0.005m),

        // ---- shared across every cascade stage ----
        new BacktestParameterSpec("cascadeSlopeLookbackBars", "EMA slope measured over (bars, at each stage's own timeframe)", Default: 3, Min: 1, Max: 50, Step: 1),
        new BacktestParameterSpec("cascadeAdxPeriod", "ADX (bars, every cascade stage)", Default: 14, Min: 2, Max: 100, Step: 1),

        // ---- Range fade (page timeframe) + shared RSI/ATR - unchanged mechanism from before ----
        new BacktestParameterSpec("atrPeriod", "ATR (bars, page timeframe)", Default: 14, Min: 2, Max: 100, Step: 1),
        new BacktestParameterSpec("atrNormalHighPercent", "ATR %% of price - High volatility band starts at", Default: 1.5m, Min: 0, Max: 10, Step: 0.05m),
        new BacktestParameterSpec("atrExtremePercent", "ATR %% of price - Extreme (no new trades) starts at", Default: 2.5m, Min: 0, Max: 15, Step: 0.05m),
        new BacktestParameterSpec("rangeAtrMultiple", "Range fade band = VWAP +- this x ATR", Default: 1.5m, Min: 0.2m, Max: 5, Step: 0.1m),
        new BacktestParameterSpec("rsiPeriod", "RSI (bars)", Default: 14, Min: 2, Max: 100, Step: 1),
        new BacktestParameterSpec("rsiNeutralLow", "Entries need RSI above", Default: 40, Min: 0, Max: 50, Step: 1),
        new BacktestParameterSpec("rsiNeutralHigh", "Entries need RSI below", Default: 60, Min: 50, Max: 100, Step: 1),

        // ON by default (every other strategy here defaults this off) - explicit instruction for
        // this strategy specifically.
        new BacktestParameterSpec("requireFlowConfirmation", "Require order flow (OBV/CDV) to confirm", Default: FlagOn, Min: FlagOff, Max: FlagOn, Step: 1, Options: new[]
        {
            new BacktestParameterOption(FlagOff, "No - price action only (turn off only if flow data isn't available)"),
            new BacktestParameterOption(FlagOn, "Yes - flow must favor + rise toward the entry"),
        }),
        FlowConfirmation.LookbackParameter(),
        FlowConfirmation.MinRisePercentParameter(),
        FlowConfirmation.ModeParameter(),
    };

    /// <summary>Only slPoints/tpPoints and the two page-timeframe ATR bands scale with the page's
    /// own selected timeframe - every cascade parameter above is already pinned to a REAL timeframe
    /// (15/5/3/1 minutes) regardless of what the page happens to be set to, so scaling those by the
    /// page timeframe would be actively wrong (a "15-minute EMA slope" doesn't mean anything different
    /// because the Backtrack page's OWN dropdown reads "5 min").</summary>
    public IReadOnlyDictionary<string, decimal> DefaultsForTimeframe(int timeframeMinutes)
    {
        var scale = OptionTradeSimulator.TimeframeScale(timeframeMinutes);
        return new Dictionary<string, decimal>
        {
            ["slPoints"] = 10m * scale,
            ["tpPoints"] = 20m * scale,
            ["atrNormalHighPercent"] = 1.5m * scale,
            ["atrExtremePercent"] = 2.5m * scale,
        };
    }

    public IReadOnlyList<BacktestTrade> Simulate(BacktestStrategyContext context, IReadOnlyDictionary<string, decimal> parameters) =>
        OptionTradeSimulator.Run(context, Evaluate(context, parameters).Entries, parameters);

    public IReadOnlyList<BacktestSignal> EntrySignals(BacktestStrategyContext context, IReadOnlyDictionary<string, decimal> parameters) =>
        Evaluate(context, parameters).Signals;

    private (List<(DateTimeOffset Time, string Direction)> Entries, List<BacktestSignal> Signals) Evaluate(
        BacktestStrategyContext context, IReadOnlyDictionary<string, decimal> parameters)
    {
        var direction = parameters["direction"];
        var takeLongs = direction != DirectionShortOnly;
        var takeShorts = direction != DirectionLongOnly;
        var signalStartMinutes = (int)parameters.GetValueOrDefault("signalStartMinutes", 570);
        var noNewEntriesAfterMinutes = (int)parameters.GetValueOrDefault("noNewEntriesAfterMinutes", 0);

        var regime15EmaFast = Math.Max(2, (int)parameters.GetValueOrDefault("regime15EmaFast", 20));
        var regime15EmaSlow = Math.Max(3, (int)parameters.GetValueOrDefault("regime15EmaSlow", 50));
        var regime15SlopeMin = parameters.GetValueOrDefault("regime15SlopeMinPercent", 0.050m);
        var regime15AdxMin = parameters.GetValueOrDefault("regime15AdxMin", 25m);
        var regimeScoreMin = Math.Max(1, (int)parameters.GetValueOrDefault("regimeScoreMin", 3));
        var regimeScoreFull = Math.Max(regimeScoreMin, (int)parameters.GetValueOrDefault("regimeScoreFull", 4));

        var setup5EmaFast = Math.Max(2, (int)parameters.GetValueOrDefault("setup5EmaFast", 9));
        var setup5EmaSlow = Math.Max(3, (int)parameters.GetValueOrDefault("setup5EmaSlow", 21));
        var setup5AdxMin = parameters.GetValueOrDefault("setup5AdxMin", 25m);

        var confirm3EmaFast = Math.Max(2, (int)parameters.GetValueOrDefault("confirm3EmaFast", 7));
        var confirm3EmaSlow = Math.Max(3, (int)parameters.GetValueOrDefault("confirm3EmaSlow", 20));
        var confirm3AdxMin = parameters.GetValueOrDefault("confirm3AdxMin", 23m);
        var confirm3SlopeMin = parameters.GetValueOrDefault("confirm3SlopeMinPercent", 0.025m);

        var entry1EmaFast = Math.Max(2, (int)parameters.GetValueOrDefault("entry1EmaFast", 5));
        var entry1EmaSlow = Math.Max(3, (int)parameters.GetValueOrDefault("entry1EmaSlow", 13));
        var entry1AdxMin = parameters.GetValueOrDefault("entry1AdxMin", 22m);
        var entry1SlopeMin = parameters.GetValueOrDefault("entry1SlopeMinPercent", 0.015m);

        var slopeLookback = Math.Max(1, (int)parameters.GetValueOrDefault("cascadeSlopeLookbackBars", 3));
        var adxPeriod = Math.Max(2, (int)parameters.GetValueOrDefault("cascadeAdxPeriod", 14));

        var atrPeriod = Math.Max(2, (int)parameters.GetValueOrDefault("atrPeriod", 14));
        var atrNormalHighPercent = parameters.GetValueOrDefault("atrNormalHighPercent", 1.5m);
        var atrExtremePercent = parameters.GetValueOrDefault("atrExtremePercent", 2.5m);
        var rangeAtrMultiple = parameters.GetValueOrDefault("rangeAtrMultiple", 1.5m);
        var rsiPeriod = Math.Max(2, (int)parameters.GetValueOrDefault("rsiPeriod", 14));
        var rsiNeutralLow = parameters.GetValueOrDefault("rsiNeutralLow", 40m);
        var rsiNeutralHigh = parameters.GetValueOrDefault("rsiNeutralHigh", 60m);

        var requireFlowConfirmation = parameters.GetValueOrDefault("requireFlowConfirmation", FlagOn) >= (FlagOff + FlagOn) / 2;
        var flowLookback = (int)parameters.GetValueOrDefault("flowLookbackBars", 5);
        var minFlowRisePercent = parameters.GetValueOrDefault("minFlowRisePercent", 0m);
        var flowMode = parameters.GetValueOrDefault("flowMode", FlowConfirmation.ModeEither);
        var flowWindow = TimeSpan.FromMinutes((double)Math.Max(1, flowLookback) * Math.Max(1, context.TimeframeMinutes));

        var entries = new List<(DateTimeOffset Time, string Direction)>();
        var signals = new List<BacktestSignal>();

        var oneMin = context.SpotBarsOneMinute;
        var pageBars = context.SpotBars;
        if (oneMin.Count < 30 || pageBars.Count < 2) return (entries, signals);

        var bars3 = BacktestUtil.AggregateCandles(oneMin, 3);
        var bars5 = BacktestUtil.AggregateCandles(oneMin, 5);
        var bars15 = BacktestUtil.AggregateCandles(oneMin, 15);
        if (bars15.Count < regime15EmaSlow + slopeLookback + 2) return (entries, signals);

        (bool Ok, string Reason) FlowCheck(bool bullish, DateTimeOffset at)
        {
            if (!requireFlowConfirmation) return (true, "");
            var obvFavors = FlowConfirmation.Favors(context.ObvCeSeries, context.ObvPeSeries, at, bullish, flowWindow, minFlowRisePercent);
            var cdvFavors = FlowConfirmation.Favors(context.CdvCeSeries, context.CdvPeSeries, at, bullish, flowWindow, minFlowRisePercent);
            var confirmed = FlowConfirmation.Confirms(flowMode, obvFavors, cdvFavors);
            var riseRequirement = minFlowRisePercent > 0 ? $"risen at least {minFlowRisePercent:0.##}%" : "risen at all";
            var reason = confirmed
                ? $"flow favors {(bullish ? "CE over PE" : "PE over CE")} and has {riseRequirement} over the last {flowLookback} bar(s) ({FlowConfirmation.ModeLabel(flowMode)})"
                : $"flow does not favor {(bullish ? "CE over PE" : "PE over CE")} and {riseRequirement} over the last {flowLookback} bar(s) as required ({FlowConfirmation.ModeLabel(flowMode)}; OBV {(obvFavors ? "confirms it" : "does not")}, CDV {(cdvFavors ? "confirms it" : "does not")})";
            return (confirmed, reason);
        }

        void EmitAt(DateTimeOffset time, bool bullish, string summary, decimal? atrPercentHere)
        {
            var dir = bullish ? "Bullish" : "Bearish";
            var volatilityExtreme = atrPercentHere is { } ap1 && ap1 >= atrExtremePercent;
            var volatilityHigh = !volatilityExtreme && atrPercentHere is { } ap2 && ap2 >= atrNormalHighPercent;
            var beforeSignalStart = signalStartMinutes > 0 && IstClock.MinutesOfDay(time) < signalStartMinutes;
            var afterEntryCutoff = noNewEntriesAfterMinutes > 0 && IstClock.MinutesOfDay(time) >= noNewEntriesAfterMinutes;
            var sizingNote = volatilityHigh ? " (ATR reads High volatility - consider reduced size; not enforced by this backtest)" : "";

            if (beforeSignalStart)
                signals.Add(new BacktestSignal(context.Underlying, time, "Rejected", dir, $"{summary} - skipped, before {IstClock.FormatMinutesOfDay(signalStartMinutes)} IST (pre-open)"));
            else if (afterEntryCutoff)
                signals.Add(new BacktestSignal(context.Underlying, time, "Rejected", dir, $"{summary} - skipped, at/after {IstClock.FormatMinutesOfDay(noNewEntriesAfterMinutes)} IST (no new entries)"));
            else if (volatilityExtreme)
                signals.Add(new BacktestSignal(context.Underlying, time, "Rejected", dir, $"{summary} - skipped, ATR {atrPercentHere:0.##}% of price is Extreme volatility (no new trades)"));
            else if (bullish && !takeLongs)
                signals.Add(new BacktestSignal(context.Underlying, time, "Rejected", dir, $"{summary} - skipped, shorts only"));
            else if (!bullish && !takeShorts)
                signals.Add(new BacktestSignal(context.Underlying, time, "Rejected", dir, $"{summary} - skipped, longs only"));
            else if (FlowCheck(bullish, time) is (false, var rejectReason))
                signals.Add(new BacktestSignal(context.Underlying, time, "Rejected", dir, $"{summary} - but {rejectReason}"));
            else
            {
                var flowReason = requireFlowConfirmation ? FlowCheck(bullish, time).Reason : null;
                var extras = string.Join("", new[] { flowReason is { Length: > 0 } ? $", and {flowReason}" : null, sizingNote }.Where(e => !string.IsNullOrEmpty(e)));
                signals.Add(new BacktestSignal(context.Underlying, time, "Entry", dir, $"{summary}{extras}"));
                entries.Add((time, dir));
            }
        }

        var vwap1m = AlignToTime(VwapCalculator.ComputeSeries(context.SpotVolumeBarsOneMinute), oneMin);
        var vwap15 = AlignToTime(VwapCalculator.ComputeSeries(context.SpotVolumeBarsOneMinute), bars15);
        var vwap5 = AlignToTime(VwapCalculator.ComputeSeries(context.SpotVolumeBarsOneMinute), bars5);
        var vwapPage = AlignToTime(VwapCalculator.ComputeSeries(context.SpotVolumeBarsOneMinute), pageBars);

        // ---- 15-minute regime ----
        var ema15Fast = EmaCrossoverDetector.EmaSeries(bars15, regime15EmaFast);
        var ema15Slow = EmaCrossoverDetector.EmaSeries(bars15, regime15EmaSlow);
        var adx15 = ToQuotes(bars15).GetAdx(adxPeriod).Select(r => (decimal?)r.Adx).ToList();

        // ---- 5-minute EMA stack (reused for the 15M score's 5th point AND the 5M setup gate) ----
        var ema5Fast = EmaCrossoverDetector.EmaSeries(bars5, setup5EmaFast);
        var ema5Slow = EmaCrossoverDetector.EmaSeries(bars5, setup5EmaSlow);
        var adx5 = ToQuotes(bars5).GetAdx(adxPeriod).Select(r => (decimal?)r.Adx).ToList();
        var stack5Bullish = bars5.Select((_, i) => ema5Fast[i] is { } f && ema5Slow[i] is { } s && f > s).ToList();
        var stack5Bearish = bars5.Select((_, i) => ema5Fast[i] is { } f && ema5Slow[i] is { } s && f < s).ToList();
        var setup5OkBullish = bars5.Select((b, i) => stack5Bullish[i] && adx5[i] is { } a && a >= setup5AdxMin && vwap5[i] is { } v && b.Close > v).ToList();
        var setup5OkBearish = bars5.Select((b, i) => stack5Bearish[i] && adx5[i] is { } a && a >= setup5AdxMin && vwap5[i] is { } v && b.Close < v).ToList();

        // ---- 3-minute confirmation ----
        var ema3Fast = EmaCrossoverDetector.EmaSeries(bars3, confirm3EmaFast);
        var ema3Slow = EmaCrossoverDetector.EmaSeries(bars3, confirm3EmaSlow);
        var adx3 = ToQuotes(bars3).GetAdx(adxPeriod).Select(r => (decimal?)r.Adx).ToList();
        var confirm3OkBullish = bars3.Select((b, i) => ema3Fast[i] is { } f && ema3Slow[i] is { } s && f > s && adx3[i] is { } a && a >= confirm3AdxMin
            && Slope(ema3Fast, i, slopeLookback) is { } sl && sl >= confirm3SlopeMin && b.Close > b.Open).ToList();
        var confirm3OkBearish = bars3.Select((b, i) => ema3Fast[i] is { } f && ema3Slow[i] is { } s && f < s && adx3[i] is { } a && a >= confirm3AdxMin
            && Slope(ema3Fast, i, slopeLookback) is { } sl && sl <= -confirm3SlopeMin && b.Close < b.Open).ToList();

        // ---- 1-minute entry inputs ----
        var ema1Fast = EmaCrossoverDetector.EmaSeries(oneMin, entry1EmaFast);
        var ema1Slow = EmaCrossoverDetector.EmaSeries(oneMin, entry1EmaSlow);
        var adx1 = ToQuotes(oneMin).GetAdx(adxPeriod).Select(r => (decimal?)r.Adx).ToList();
        var rsi1 = ToQuotes(oneMin).GetRsi(rsiPeriod).Select(r => (decimal?)r.Rsi).ToList();

        // ---- 15-minute regime direction + score ----
        var stack5OnBars15Bullish = AlignStepToTime(bars5, stack5Bullish, bars15, false);
        var stack5OnBars15Bearish = AlignStepToTime(bars5, stack5Bearish, bars15, false);
        var regime15Direction = new string?[bars15.Count];
        var regime15Score = new int[bars15.Count];
        for (var i = slopeLookback; i < bars15.Count; i++)
        {
            if (ema15Fast[i] is not { } f || ema15Slow[i] is not { } s) continue;
            if (adx15[i] is not { } a || vwap15[i] is not { } v) continue;

            var candidate = f > s ? "Bullish" : f < s ? "Bearish" : null;
            if (candidate is null) continue;

            var bullish = candidate == "Bullish";
            var slopeOk = Slope(ema15Fast, i, slopeLookback) is { } sl && (bullish ? sl >= regime15SlopeMin : sl <= -regime15SlopeMin);
            var adxOk = a >= regime15AdxMin;
            var vwapOk = bullish ? bars15[i].Close > v : bars15[i].Close < v;
            var fiveMOk = bullish ? stack5OnBars15Bullish[i] : stack5OnBars15Bearish[i];

            var score = 1 + (slopeOk ? 1 : 0) + (adxOk ? 1 : 0) + (vwapOk ? 1 : 0) + (fiveMOk ? 1 : 0);
            regime15Score[i] = score;
            regime15Direction[i] = score >= regimeScoreMin ? candidate : null;
        }

        // ---- page-timeframe ATR/RSI for the Range path + the volatility gate ----
        var atrPage = ToQuotes(pageBars).GetAtr(atrPeriod).Select(r => (decimal?)r.Atr).ToList();
        var rsiPage = ToQuotes(pageBars).GetRsi(rsiPeriod).Select(r => (decimal?)r.Rsi).ToList();
        var atrPercentPage = pageBars.Select((b, i) => atrPage[i] is { } a && b.Close != 0 ? (decimal?)(a / b.Close * 100m) : null).ToList();

        // ==== TREND CASCADE - native 1-minute entries, gated by every stage above agreeing ====
        var regime15OnOneMin = AlignStepToTime(bars15, regime15Direction, oneMin, (string?)null);
        var regime15ScoreOnOneMin = AlignStepToTime(bars15, regime15Score, oneMin, 0);
        var setup5OkOnOneMinBullish = AlignStepToTime(bars5, setup5OkBullish, oneMin, false);
        var setup5OkOnOneMinBearish = AlignStepToTime(bars5, setup5OkBearish, oneMin, false);
        var confirm3OkOnOneMinBullish = AlignStepToTime(bars3, confirm3OkBullish, oneMin, false);
        var confirm3OkOnOneMinBearish = AlignStepToTime(bars3, confirm3OkBearish, oneMin, false);
        var atrPercentOnOneMin = AlignStepToTime(pageBars, atrPercentPage, oneMin, (decimal?)null);

        for (var i = Math.Max(1, slopeLookback); i < oneMin.Count; i++)
        {
            if (regime15OnOneMin[i] is not { } dir) continue;
            if (ema1Fast[i] is not { } f1 || ema1Fast[i - 1] is not { } prevF1) continue;
            if (ema1Slow[i] is not { } s1 || ema1Slow[i - 1] is not { } prevS1) continue;
            if (adx1[i] is not { } a1 || rsi1[i] is not { } r1) continue;
            if (Slope(ema1Fast, i, slopeLookback) is not { } sl1) continue;

            var bullish = dir == "Bullish";
            var setupOk = bullish ? setup5OkOnOneMinBullish[i] : setup5OkOnOneMinBearish[i];
            var confirmOk = bullish ? confirm3OkOnOneMinBullish[i] : confirm3OkOnOneMinBearish[i];
            var pullback = bullish ? prevF1 <= prevS1 && f1 > s1 : prevF1 >= prevS1 && f1 < s1;
            var adxOk = a1 >= entry1AdxMin;
            var slopeOk = bullish ? sl1 >= entry1SlopeMin : sl1 <= -entry1SlopeMin;
            var rsiOk = r1 > rsiNeutralLow && r1 < rsiNeutralHigh;

            if (!(setupOk && confirmOk && pullback && adxOk && slopeOk && rsiOk)) continue;

            var score = regime15ScoreOnOneMin[i];
            var confidence = score >= regimeScoreFull ? "full confidence" : "selective/reduced confidence";
            var summary = $"15M regime {dir} (score {score}/5, {confidence}) -> 5M setup ok -> 3M confirmed -> 1M pullback rejection (EMA{entry1EmaFast}/{entry1EmaSlow})";
            EmitAt(oneMin[i].Time, bullish, summary, atrPercentOnOneMin[i]);
        }

        // ==== RANGE FADE - page-timeframe VWAP+-ATR band, only when the 15M regime is NOT trending ====
        var regime15ScoreOnPage = AlignStepToTime(bars15, regime15Score, pageBars, 0);
        for (var i = 1; i < pageBars.Count; i++)
        {
            if (regime15ScoreOnPage[i] >= regimeScoreMin) continue; // 15M cascade already has a candidate - don't fade into it
            if (vwapPage[i] is not { } vwapNow || vwapPage[i - 1] is not { } prevVwap) continue;
            if (atrPage[i] is not { } atrNow || atrPage[i - 1] is not { } prevAtr) continue;
            if (rsiPage[i] is not { } rsiNow || atrPercentPage[i] is not { } atrPctNow) continue;

            var bar = pageBars[i];
            var prevBar = pageBars[i - 1];
            var lower = vwapNow - atrNow * rangeAtrMultiple;
            var prevLower = prevVwap - prevAtr * rangeAtrMultiple;
            var upper = vwapNow + atrNow * rangeAtrMultiple;
            var prevUpper = prevVwap + prevAtr * rangeAtrMultiple;
            var rsiNeutral = rsiNow > rsiNeutralLow && rsiNow < rsiNeutralHigh;

            if (prevBar.Close <= prevLower && bar.Close > lower)
            {
                var summary = $"15M regime Range (score {regime15ScoreOnPage[i]}/5) - close rejected back above the VWAP-{rangeAtrMultiple:0.#}xATR lower band ({lower:0.##}), RSI {rsiNow:0.#}";
                if (!rsiNeutral)
                    signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Rejected", "Bullish", $"{summary} - skipped, RSI outside the {rsiNeutralLow:0.#}-{rsiNeutralHigh:0.#} neutral band (momentum may be accelerating away, not just testing the range)"));
                else
                    EmitAt(bar.Time, true, summary, atrPctNow);
            }
            else if (prevBar.Close >= prevUpper && bar.Close < upper)
            {
                var summary = $"15M regime Range (score {regime15ScoreOnPage[i]}/5) - close rejected back below the VWAP+{rangeAtrMultiple:0.#}xATR upper band ({upper:0.##}), RSI {rsiNow:0.#}";
                if (!rsiNeutral)
                    signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Rejected", "Bearish", $"{summary} - skipped, RSI outside the {rsiNeutralLow:0.#}-{rsiNeutralHigh:0.#} neutral band (momentum may be accelerating away, not just testing the range)"));
                else
                    EmitAt(bar.Time, false, summary, atrPctNow);
            }
        }

        return (entries, signals.OrderByDescending(s => s.TimeUtc).ToList());
    }

    /// <summary>% change of <paramref name="series"/> over <paramref name="lookback"/> bars ending at
    /// <paramref name="index"/> - null if either end is missing or the base is exactly zero (a
    /// meaningless divisor, not a real "infinite slope").</summary>
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

    /// <summary>Aligns a time-keyed running series (VWAP, shaped like ObvCeSeries/CdvCeSeries) to
    /// <paramref name="bars"/> by index - "the last value at or before this bar's time" for every
    /// bar in one forward merge pass, rather than BacktestUtil.LastValueAtOrBefore's own per-call
    /// O(series length) scan repeated once per bar (this strategy needs a VWAP reading on EVERY bar
    /// of FOUR separate timeframes, not just at a handful of candidate entries).</summary>
    private static List<decimal?> AlignToTime(IReadOnlyList<ObvPoint> series, IReadOnlyList<Candle> bars)
    {
        var result = new List<decimal?>(bars.Count);
        var pointer = 0;
        decimal? current = null;
        foreach (var bar in bars)
        {
            while (pointer < series.Count && series[pointer].Time <= bar.Time)
            {
                current = series[pointer].Obv;
                pointer++;
            }
            result.Add(current);
        }
        return result;
    }

    /// <summary>Generic counterpart to AlignToTime - projects any coarser timeframe's own per-bar
    /// series (<paramref name="sourceBars"/>/<paramref name="sourceValues"/>, e.g. the 15-minute
    /// regime direction) onto a finer timeframe's own bar times (<paramref name="targetBars"/>, e.g.
    /// the native 1-minute series), so "what did the 15-minute regime say as of this 1-minute bar"
    /// is a plain array lookup rather than a per-bar binary search. <paramref name="defaultValue"/>
    /// covers every target bar before the source series' own first value.</summary>
    private static List<T> AlignStepToTime<T>(IReadOnlyList<Candle> sourceBars, IReadOnlyList<T> sourceValues, IReadOnlyList<Candle> targetBars, T defaultValue)
    {
        var result = new List<T>(targetBars.Count);
        var pointer = 0;
        var current = defaultValue;
        foreach (var bar in targetBars)
        {
            while (pointer < sourceBars.Count && sourceBars[pointer].Time <= bar.Time)
            {
                current = sourceValues[pointer];
                pointer++;
            }
            result.Add(current);
        }
        return result;
    }
}
