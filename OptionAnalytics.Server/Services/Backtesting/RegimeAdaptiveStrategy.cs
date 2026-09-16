using OptionAnalytics.Server.Models;
using OptionAnalytics.Server.Services;
using Skender.Stock.Indicators;

namespace OptionAnalytics.Server.Services.Backtesting;

/// <summary>
/// A "classify the regime first, then pick a strategy for it" approach - the answer to a real,
/// specific complaint (a single fixed strategy working some months and not others) rather than
/// another fixed rule set: a market that is genuinely trending and a market that is genuinely
/// chopping sideways call for opposite tactics (ride the trend vs. fade an extreme), and running
/// the same one regardless of which regime is actually in effect is exactly why a strategy tuned on
/// a trending month can bleed through a sideways one. This is a direct implementation of the user's
/// own "NIFTY &amp; BANKNIFTY - Adaptive Option Selling Strategy" flowchart (5-filter 0-5 regime
/// score, ADX/VWAP/EMA-slope/chop-count/ATR-volatility, RSI-neutral range entries, etc.) - see each
/// section below for exactly which parts map to which box in it, and which parts this app's engine
/// genuinely cannot do yet.
///
/// REGIME SCORE (0-5, recomputed fresh every bar), one point each for:
///   1. EMA STACK+SLOPE: EMA-fast &gt; EMA-mid &gt; EMA-slow with the fast EMA's own slope at least
///      +<c>slopeThresholdPercent</c> (Bearish is the exact mirror) - this point is MANDATORY for
///      calling the regime Trending at all (see below), the other four only refine confidence once a
///      real directional stack already exists.
///   2. ADX(<c>adxPeriod</c>) &gt;= <c>adxTrendMin</c> (the flowchart's own 25) - below
///      <c>adxRangeMax</c> (20) is explicitly non-trending; the 20-25 gap earns neither a point nor a
///      strike against.
///   3. VWAP SIDE: close crossed VWAP fewer than <c>minChopCrosses</c> times in the last
///      <c>chopWindowMinutes</c> - "price consistently on one side," the flowchart's own phrase.
///   4. VOLATILITY NOT DEAD: ATR as a % of price is at least <c>atrNormalLowPercent</c> - a market
///      too quiet to move is not "trending," it is asleep.
///   5. LOW EMA CROSS COUNT: EMA-fast/EMA-mid crossed fewer than <c>minChopCrosses</c> times in the
///      same window (the flowchart's own explicit "chop if &gt;3 crosses in 30 minutes").
/// Regime = Trending (in whichever direction filter 1 found) only when the STACK point (1) is present
/// AND the total score reaches <c>trendScoreThreshold</c> (4 of 5, the flowchart's own "Score 4-5" band)
/// - everything else, including its own "Score 3 / Weak-Uncertain" middle band, is treated as Range,
/// matching the flowchart's own routing (only two strategy boxes exist below the three-way score
/// legend).
///
/// TREND STRATEGY: enters once, at the bar the regime first flips Trending in a direction (not on
/// every bar it remains true) - "7/20 EMA alignment, price vs VWAP, EMA slope, confirmed on a closed
/// candle," exactly the regime conditions themselves per the flowchart's own Entry Rules panel.
///
/// RANGE STRATEGY: fades the extremes of a VWAP+-ATR band (<c>rangeAtrMultiple</c> x ATR either side
/// of VWAP - "price near range edge" + "VWAP touch/rejection"), gated by RSI(<c>rsiPeriod</c>)
/// sitting inside [<c>rsiNeutralLow</c>,<c>rsiNeutralHigh</c>] - the flowchart's own "RSI not extreme
/// (30-70)" check, which here means "momentum isn't already accelerating away" (a reason NOT to sell
/// into what might be a breakout), not a mean-reversion trigger by itself.
///
/// OPTION SIDE - SELLING, not buying, is this strategy's own default (<c>side</c> defaults to Sell,
/// every other strategy here defaults to Buy) - the flowchart is titled an "option SELLING" system.
/// Bullish -&gt; sell PE, Bearish -&gt; sell CE is OptionTradeSimulator.Run's own existing Sell
/// convention (isCall = isSell ? !isBullish : isBullish) and is the standard defined-direction credit
/// convention (profit if price does NOT go the wrong way) - the flowchart's own Trade Direction box
/// ("Uptrend -&gt; Sell CE, Downtrend -&gt; Sell PE") reads backwards from that, and backwards from
/// every other Sell-capable strategy already shipped in this app, so this class follows the
/// standard/existing convention rather than the flowchart's literal text. Worth a second look on your
/// end given real money is involved; happy to flip it if that reading was actually intended.
///
/// ORDER FLOW: CDV/OBV confirmation (FlowConfirmation, same as FiveEmaStrategy/LuxAlgoSrBreakStrategy/
/// SrChannelStrategy/etc.) defaults ON here specifically, per explicit instruction - every other
/// strategy in this app defaults it off. Still a real parameter, so it can be turned off where flow
/// data is not available.
///
/// WHAT THIS DOES NOT DO, on purpose - the flowchart asks for several things outside what a single
/// IBacktestStrategy/OptionTradeSimulator run can honestly provide, and faking any of them would be
/// worse than leaving them out:
///   - "Sell both CE and PE" (Iron Condor / short strangle) needs a genuine concurrent TWO-LEG
///     position with combined P&amp;L - OptionTradeSimulator.Run holds exactly one position at a time
///     (see its own busyUntil gating). This strategy instead sells ONE defined-direction leg per
///     range-edge rejection (PE at the lower edge, CE at the upper), a real and honest approximation,
///     not the flowchart's true simultaneous structure. A real Iron Condor engine is a separate,
///     larger project.
///   - India VIX has no data source anywhere in this app (see TechnicalIndicators' own doc comment on
///     why ATR is this app's volatility proxy throughout) - the Normal/High/Extreme bands below are
///     ATR-percent-of-price only.
///   - Position sizing (100%/50%/0% by volatility band), daily loss limits, and "pause after 2
///     consecutive stop-losses" are portfolio/session-level risk rules that need state ACROSS trades
///     and days - this class (like every strategy here) only ever answers "what would this one trade
///     have been," so Extreme volatility instead means "reject every new entry outright" (the
///     closest a single-trade decision can get to "no new trades"), and High volatility is reported
///     in the signal text as a sizing hint only, not enforced.
///   - "Performance tracking by regime" is a reporting/analytics feature over a whole backtest run's
///     results, not a per-trade entry rule - out of scope for this class entirely.
///   - OI/Volume-based strike liquidity screening isn't modelled anywhere in this app's strike
///     selection (ATM +/- N steps only, via the shared otmSteps parameter) - unchanged here.
///
/// A NOTE ON THE NUMBERS: every threshold below (ADX 25/20, ATR bands 0.8/1.5/2.5% of price, slope
/// 0.05%, RSI 30/70, chop count 3 in 30 minutes) is taken directly from the flowchart's own stated
/// settings, not independently back-tested against this app's own NIFTY/BANKNIFTY history - each one
/// is still a tunable BacktestParameterSpec so it can be adjusted against real results.
/// </summary>
public sealed class RegimeAdaptiveStrategy : IBacktestStrategy
{
    public string Key => "regime-adaptive";
    public string Name => "Regime-Adaptive Option Selling (Trend/Range)";
    public string Description => "Scores every bar 0-5 (EMA7/20/50 stack+slope, ADX, VWAP side, ATR volatility, EMA/VWAP chop count) to classify it Trending or Range, then sells the defined-direction leg that regime calls for - the trend's own direction, or the VWAP+-ATR band edge being rejected (RSI-neutral gated). Sells options by default; CDV/OBV order-flow confirmation is ON by default here.";

    private const decimal DirectionBoth = 0;
    private const decimal DirectionLongOnly = 1;
    private const decimal DirectionShortOnly = 2;

    private const decimal FlagOff = 0;
    private const decimal FlagOn = 1;

    private enum Regime { Range, TrendingBullish, TrendingBearish }

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
        // 09:30, not the shared 09:15 default - the flowchart's own "avoid 9:15-9:30, trade after
        // 9:30" entry-time rule.
        new BacktestParameterSpec("signalStartMinutes", "No signals before (IST time, 0 = off)", Default: 570, Min: 0, Max: 1439, Step: 1),
        // Optional (0 = off) - the flowchart's own "avoid last 30 minutes" is marked optional there too.
        new BacktestParameterSpec("noNewEntriesAfterMinutes", "No new entries from (IST time, 0 = off)", Default: 0, Min: 0, Max: 1439, Step: 1),
        OptionTradeSimulator.ExcludeLastDaysParameter(),
        new BacktestParameterSpec("direction", "Take", Default: DirectionBoth, Min: DirectionBoth, Max: DirectionShortOnly, Step: 1, Options: new[]
        {
            new BacktestParameterOption(DirectionBoth, "Both sides"),
            new BacktestParameterOption(DirectionLongOnly, "Bullish only"),
            new BacktestParameterOption(DirectionShortOnly, "Bearish only"),
        }),
        new BacktestParameterSpec("emaFastPeriod", "EMA fast (bars)", Default: 7, Min: 2, Max: 50, Step: 1),
        new BacktestParameterSpec("emaMidPeriod", "EMA mid (bars)", Default: 20, Min: 3, Max: 100, Step: 1),
        new BacktestParameterSpec("emaSlowPeriod", "EMA slow (bars)", Default: 50, Min: 5, Max: 300, Step: 1),
        new BacktestParameterSpec("slopeLookbackBars", "EMA slope measured over (bars)", Default: 5, Min: 1, Max: 50, Step: 1),
        new BacktestParameterSpec("slopeThresholdPercent", "EMA slope must be at least (%, over that lookback)", Default: 0.05m, Min: 0, Max: 5, Step: 0.01m),
        new BacktestParameterSpec("adxPeriod", "ADX (bars)", Default: 14, Min: 2, Max: 100, Step: 1),
        new BacktestParameterSpec("adxTrendMin", "ADX at/above this earns a trend point", Default: 25, Min: 0, Max: 80, Step: 1),
        new BacktestParameterSpec("adxRangeMax", "ADX below this is explicitly non-trending", Default: 20, Min: 0, Max: 80, Step: 1),
        new BacktestParameterSpec("atrPeriod", "ATR (bars)", Default: 14, Min: 2, Max: 100, Step: 1),
        new BacktestParameterSpec("atrNormalLowPercent", "ATR %% of price - Normal band starts at", Default: 0.8m, Min: 0, Max: 5, Step: 0.05m),
        new BacktestParameterSpec("atrNormalHighPercent", "ATR %% of price - High band starts at", Default: 1.5m, Min: 0, Max: 10, Step: 0.05m),
        new BacktestParameterSpec("atrExtremePercent", "ATR %% of price - Extreme (no new trades) starts at", Default: 2.5m, Min: 0, Max: 15, Step: 0.05m),
        new BacktestParameterSpec("chopWindowMinutes", "Chop count window (minutes)", Default: 30, Min: 5, Max: 240, Step: 5),
        new BacktestParameterSpec("minChopCrosses", "EMA/VWAP crosses in that window needed to count toward chop", Default: 3, Min: 1, Max: 20, Step: 1),
        new BacktestParameterSpec("trendScoreThreshold", "Regime score needed (out of 5) to call the bar Trending", Default: 4, Min: 1, Max: 5, Step: 1),
        new BacktestParameterSpec("rangeAtrMultiple", "Range fade band = VWAP +- this x ATR", Default: 1.5m, Min: 0.2m, Max: 5, Step: 0.1m),
        new BacktestParameterSpec("rsiPeriod", "RSI (bars, for the Range entry's neutral gate)", Default: 14, Min: 2, Max: 100, Step: 1),
        new BacktestParameterSpec("rsiNeutralLow", "Range entries need RSI above", Default: 30, Min: 0, Max: 50, Step: 1),
        new BacktestParameterSpec("rsiNeutralHigh", "Range entries need RSI below", Default: 70, Min: 50, Max: 100, Step: 1),
        // ON by default (every other strategy here defaults this off) - the user's own explicit
        // instruction for this strategy specifically. See this class's own doc comment.
        new BacktestParameterSpec("requireFlowConfirmation", "Require order flow (OBV/CDV) to confirm", Default: FlagOn, Min: FlagOff, Max: FlagOn, Step: 1, Options: new[]
        {
            new BacktestParameterOption(FlagOff, "No - price action only (turn off only if flow data isn't available)"),
            new BacktestParameterOption(FlagOn, "Yes - flow must favor + rise toward the entry"),
        }),
        FlowConfirmation.LookbackParameter(),
        FlowConfirmation.MinRisePercentParameter(),
        FlowConfirmation.ModeParameter(),
    };

    /// <summary>Overrides the default interface's slPoints/tpPoints-only scaling (see
    /// IBacktestStrategy.DefaultsForTimeframe's own doc comment) to also scale every OTHER
    /// timeframe-sensitive default this strategy has, by the same 1x/2x/3x
    /// OptionTradeSimulator.TimeframeScale bucket - so switching the page's timeframe from 1 to 3
    /// minutes re-fills the whole parameter form with values suited to 3-minute bars (via GET
    /// .../strategies?timeframe=3, which BacktestUtil.ApplyTimeframeDefaults already calls this for),
    /// and any further tweak is then made against sensible starting numbers rather than the 1-minute
    /// ones left untouched underneath.
    ///
    /// SCALED - a coarser bar covers more real time, so these are all "expect a bigger raw number at
    /// a coarser timeframe" values:
    ///   - slopeThresholdPercent: the same NUMBER of slopeLookbackBars covers 3x the real time at a
    ///     3-minute timeframe as at 1-minute, so the EMA is expected to have moved further in % terms
    ///     over that same bar count.
    ///   - atrNormalLowPercent/atrNormalHighPercent/atrExtremePercent: a coarser candle's own
    ///     High-Low range is naturally wider as a % of price than a finer one's, so the same
    ///     Normal/High/Extreme bands would misfire (everything reading "Extreme") if left at their
    ///     1-minute numbers.
    ///   - chopWindowMinutes: scaled UP (not left as a fixed 30) so the window still covers enough
    ///     BARS to meaningfully count crosses against minChopCrosses once each bar itself spans more
    ///     time - 30 minutes is just 6 bars at a 5-minute timeframe otherwise.
    ///
    /// DELIBERATELY NOT SCALED - the same reasoning IBacktestStrategy's own default implementation
    /// documents for bar-count parameters generally: EMA/ADX/ATR/RSI PERIODS (a "20-bar EMA" is a
    /// conventional, timeframe-independent notion traders already reason in bar counts for, not real
    /// minutes - rescaling it on every timeframe switch would be surprising, not helpful), ADX/RSI's
    /// own thresholds (already-normalized 0-100 oscillators, not raw price), rangeAtrMultiple (a
    /// ratio of ATR to itself, already scale-invariant since ATR itself scales), and
    /// minChopCrosses/trendScoreThreshold (plain counts/scores, not a real-time or price quantity).</summary>
    public IReadOnlyDictionary<string, decimal> DefaultsForTimeframe(int timeframeMinutes)
    {
        var scale = OptionTradeSimulator.TimeframeScale(timeframeMinutes);
        return new Dictionary<string, decimal>
        {
            ["slPoints"] = 10m * scale,
            ["tpPoints"] = 20m * scale,
            ["slopeThresholdPercent"] = 0.05m * scale,
            ["atrNormalLowPercent"] = 0.8m * scale,
            ["atrNormalHighPercent"] = 1.5m * scale,
            ["atrExtremePercent"] = 2.5m * scale,
            ["chopWindowMinutes"] = 30m * scale,
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

        var emaFastPeriod = Math.Max(2, (int)parameters.GetValueOrDefault("emaFastPeriod", 7));
        var emaMidPeriod = Math.Max(3, (int)parameters.GetValueOrDefault("emaMidPeriod", 20));
        var emaSlowPeriod = Math.Max(5, (int)parameters.GetValueOrDefault("emaSlowPeriod", 50));
        var slopeLookback = Math.Max(1, (int)parameters.GetValueOrDefault("slopeLookbackBars", 5));
        var slopeThreshold = parameters.GetValueOrDefault("slopeThresholdPercent", 0.05m);
        var adxPeriod = Math.Max(2, (int)parameters.GetValueOrDefault("adxPeriod", 14));
        var adxTrendMin = parameters.GetValueOrDefault("adxTrendMin", 25m);
        var atrPeriod = Math.Max(2, (int)parameters.GetValueOrDefault("atrPeriod", 14));
        var atrNormalLowPercent = parameters.GetValueOrDefault("atrNormalLowPercent", 0.8m);
        var atrNormalHighPercent = parameters.GetValueOrDefault("atrNormalHighPercent", 1.5m);
        var atrExtremePercent = parameters.GetValueOrDefault("atrExtremePercent", 2.5m);
        var chopWindowMinutes = Math.Max(1, (int)parameters.GetValueOrDefault("chopWindowMinutes", 30));
        var minChopCrosses = Math.Max(1, (int)parameters.GetValueOrDefault("minChopCrosses", 3));
        var trendScoreThreshold = Math.Max(1, (int)parameters.GetValueOrDefault("trendScoreThreshold", 4));
        var rangeAtrMultiple = parameters.GetValueOrDefault("rangeAtrMultiple", 1.5m);
        var rsiPeriod = Math.Max(2, (int)parameters.GetValueOrDefault("rsiPeriod", 14));
        var rsiNeutralLow = parameters.GetValueOrDefault("rsiNeutralLow", 30m);
        var rsiNeutralHigh = parameters.GetValueOrDefault("rsiNeutralHigh", 70m);

        var requireFlowConfirmation = parameters.GetValueOrDefault("requireFlowConfirmation", FlagOn) >= (FlagOff + FlagOn) / 2;
        var flowLookback = (int)parameters.GetValueOrDefault("flowLookbackBars", 5);
        var minFlowRisePercent = parameters.GetValueOrDefault("minFlowRisePercent", 0m);
        var flowMode = parameters.GetValueOrDefault("flowMode", FlowConfirmation.ModeEither);
        var flowWindow = TimeSpan.FromMinutes((double)Math.Max(1, flowLookback) * Math.Max(1, context.TimeframeMinutes));

        var entries = new List<(DateTimeOffset Time, string Direction)>();
        var signals = new List<BacktestSignal>();

        var bars = context.SpotBars;
        if (bars.Count < emaSlowPeriod + slopeLookback + 2) return (entries, signals);

        var chopWindowBars = Math.Max(2, chopWindowMinutes / Math.Max(1, context.TimeframeMinutes));

        var ema7 = EmaCrossoverDetector.EmaSeries(bars, emaFastPeriod);
        var ema20 = EmaCrossoverDetector.EmaSeries(bars, emaMidPeriod);
        var ema50 = EmaCrossoverDetector.EmaSeries(bars, emaSlowPeriod);
        var adx = ToQuotes(bars).GetAdx(adxPeriod).Select(r => (decimal?)r.Adx).ToList();
        var atr = ToQuotes(bars).GetAtr(atrPeriod).Select(r => (decimal?)r.Atr).ToList();
        var rsi = ToQuotes(bars).GetRsi(rsiPeriod).Select(r => (decimal?)r.Rsi).ToList();
        var vwap = AlignToTime(VwapCalculator.ComputeSeries(context.SpotVolumeBarsOneMinute), bars);

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

        var regimes = new Regime?[bars.Count];
        var scores = new int[bars.Count];
        for (var i = slopeLookback; i < bars.Count; i++)
        {
            if (ema7[i] is not { } f || ema20[i] is not { } m || ema50[i] is not { } s) continue;
            if (ema7[i - slopeLookback] is not { } fPast || fPast == 0) continue;
            if (adx[i] is not { } adxNow || vwap[i] is not { } vwapNow || atr[i] is not { } atrNow) continue;

            var slopePercent = (f - fPast) / Math.Abs(fPast) * 100m;
            var atrPercent = bars[i].Close != 0 ? atrNow / bars[i].Close * 100m : 0m;
            var (emaCrosses, vwapCrosses) = CrossCounts(bars, ema7, ema20, vwap, i, chopWindowBars);

            var stackBullish = f > m && m > s && slopePercent >= slopeThreshold;
            var stackBearish = f < m && m < s && slopePercent <= -slopeThreshold;

            var score = 0;
            if (stackBullish || stackBearish) score++;
            if (adxNow >= adxTrendMin) score++;
            if (vwapCrosses < minChopCrosses) score++;
            if (atrPercent >= atrNormalLowPercent) score++;
            if (emaCrosses < minChopCrosses) score++;
            scores[i] = score;

            regimes[i] = score >= trendScoreThreshold && stackBullish ? Regime.TrendingBullish
                : score >= trendScoreThreshold && stackBearish ? Regime.TrendingBearish
                : Regime.Range;
        }

        for (var i = Math.Max(1, slopeLookback); i < bars.Count; i++)
        {
            if (regimes[i] is not { } regime || regimes[i - 1] is null) continue;
            if (atr[i] is not { } atrNow) continue;

            var bar = bars[i];
            var prevBar = bars[i - 1];
            var atrPercentNow = bar.Close != 0 ? atrNow / bar.Close * 100m : 0m;
            var volatilityExtreme = atrPercentNow >= atrExtremePercent;
            var volatilityHigh = !volatilityExtreme && atrPercentNow >= atrNormalHighPercent;
            var beforeSignalStart = signalStartMinutes > 0 && IstClock.MinutesOfDay(bar.Time) < signalStartMinutes;
            var afterEntryCutoff = noNewEntriesAfterMinutes > 0 && IstClock.MinutesOfDay(bar.Time) >= noNewEntriesAfterMinutes;

            void Emit(bool bullish, string summary)
            {
                var dir = bullish ? "Bullish" : "Bearish";
                var sizingNote = volatilityHigh ? " (ATR reads High volatility - consider reduced size; not enforced by this backtest)" : "";
                if (beforeSignalStart)
                    signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Rejected", dir, $"{summary} - skipped, before {IstClock.FormatMinutesOfDay(signalStartMinutes)} IST (pre-open)"));
                else if (afterEntryCutoff)
                    signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Rejected", dir, $"{summary} - skipped, at/after {IstClock.FormatMinutesOfDay(noNewEntriesAfterMinutes)} IST (no new entries)"));
                else if (volatilityExtreme)
                    signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Rejected", dir, $"{summary} - skipped, ATR {atrPercentNow:0.##}% of price is Extreme volatility (no new trades)"));
                else if (bullish && !takeLongs)
                    signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Rejected", dir, $"{summary} - skipped, shorts only"));
                else if (!bullish && !takeShorts)
                    signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Rejected", dir, $"{summary} - skipped, longs only"));
                else if (FlowCheck(bullish, bar.Time) is (false, var rejectReason))
                    signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Rejected", dir, $"{summary} - but {rejectReason}"));
                else
                {
                    var flowReason = requireFlowConfirmation ? FlowCheck(bullish, bar.Time).Reason : null;
                    var extras = string.Join("", new[] { flowReason is { Length: > 0 } ? $", and {flowReason}" : null, sizingNote }.Where(e => !string.IsNullOrEmpty(e)));
                    signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Entry", dir, $"{summary}{extras}"));
                    entries.Add((bar.Time, dir));
                }
            }

            if (regime == Regime.TrendingBullish && regimes[i - 1] != Regime.TrendingBullish)
            {
                Emit(true, $"Regime turned Trending Bullish (score {scores[i]}/5 - EMA{emaFastPeriod}/{emaMidPeriod}/{emaSlowPeriod} stacked up, sloping up, above VWAP)");
            }
            else if (regime == Regime.TrendingBearish && regimes[i - 1] != Regime.TrendingBearish)
            {
                Emit(false, $"Regime turned Trending Bearish (score {scores[i]}/5 - EMA{emaFastPeriod}/{emaMidPeriod}/{emaSlowPeriod} stacked down, sloping down, below VWAP)");
            }
            else if (regime == Regime.Range && vwap[i] is { } vwapNow && vwap[i - 1] is { } prevVwap && atr[i - 1] is { } prevAtr && rsi[i] is { } rsiNow)
            {
                var lower = vwapNow - atrNow * rangeAtrMultiple;
                var prevLower = prevVwap - prevAtr * rangeAtrMultiple;
                var upper = vwapNow + atrNow * rangeAtrMultiple;
                var prevUpper = prevVwap + prevAtr * rangeAtrMultiple;
                var rsiNeutral = rsiNow > rsiNeutralLow && rsiNow < rsiNeutralHigh;

                if (prevBar.Close <= prevLower && bar.Close > lower)
                {
                    var summary = $"Regime Range - close rejected back above the VWAP-{rangeAtrMultiple:0.#}xATR lower band ({lower:0.##}), RSI {rsiNow:0.#}";
                    if (!rsiNeutral)
                        signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Rejected", "Bullish", $"{summary} - skipped, RSI outside the {rsiNeutralLow:0.#}-{rsiNeutralHigh:0.#} neutral band (momentum may be accelerating away, not just testing the range)"));
                    else
                        Emit(true, summary);
                }
                else if (prevBar.Close >= prevUpper && bar.Close < upper)
                {
                    var summary = $"Regime Range - close rejected back below the VWAP+{rangeAtrMultiple:0.#}xATR upper band ({upper:0.##}), RSI {rsiNow:0.#}";
                    if (!rsiNeutral)
                        signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Rejected", "Bearish", $"{summary} - skipped, RSI outside the {rsiNeutralLow:0.#}-{rsiNeutralHigh:0.#} neutral band (momentum may be accelerating away, not just testing the range)"));
                    else
                        Emit(false, summary);
                }
            }
        }

        return (entries, signals.OrderByDescending(s => s.TimeUtc).ToList());
    }

    /// <summary>How many times EMA-fast/EMA-mid crossed, and how many times close crossed VWAP, in
    /// the <paramref name="windowBars"/> bars ending at <paramref name="index"/> - the flowchart's
    /// own "EMA Cross Count" and "VWAP Position" chop inputs.</summary>
    private static (int EmaCrosses, int VwapCrosses) CrossCounts(
        IReadOnlyList<Candle> bars, IReadOnlyList<decimal?> ema7, IReadOnlyList<decimal?> ema20, IReadOnlyList<decimal?> vwap,
        int index, int windowBars)
    {
        var windowStart = Math.Max(1, index - windowBars + 1);
        var emaCrosses = 0;
        var vwapCrosses = 0;
        for (var j = windowStart; j <= index; j++)
        {
            if (ema7[j] is { } f && ema20[j] is { } m && ema7[j - 1] is { } prevF && ema20[j - 1] is { } prevM)
            {
                var now = Math.Sign(f - m);
                var prev = Math.Sign(prevF - prevM);
                if (now != prev && now != 0 && prev != 0) emaCrosses++;
            }

            if (vwap[j] is { } v && vwap[j - 1] is { } prevV)
            {
                var now = Math.Sign(bars[j].Close - v);
                var prev = Math.Sign(bars[j - 1].Close - prevV);
                if (now != prev && now != 0 && prev != 0) vwapCrosses++;
            }
        }

        return (emaCrosses, vwapCrosses);
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
    /// for its own chop-count/regime scan, not just at a handful of candidate entries the way
    /// FlowConfirmation.Favors is normally called, so the repeated-scan cost would actually add up
    /// here).</summary>
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
}
