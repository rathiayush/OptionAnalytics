using OptionAnalytics.Server.Models;
using OptionAnalytics.Server.Services;
using Skender.Stock.Indicators;

namespace OptionAnalytics.Server.Services.Backtesting;

/// <summary>
/// A second, DELIBERATELY PLAINER "adaptive option selling" strategy, built alongside
/// RegimeAdaptiveStrategy (not replacing it) per the user's own explicit request for a second,
/// simpler version of the "NIFTY &amp; BANKNIFTY - Adaptive Option Selling Strategy" flowchart - the
/// same one that originally seeded RegimeAdaptiveStrategy before that class grew into the later,
/// more detailed ADAPTIVE OPTIONS SELLING spec (fixed 15-minute regime, Bollinger Bands, DI+/-,
/// per-regime multiplier tables). This class has NONE of that: everything - regime AND entry/exit -
/// runs on ONE timeframe, the page's own selected one, so there is no cross-timeframe alignment
/// anywhere in this file at all.
///
/// REGIME SCORE (0-5), computed fresh on EVERY bar of the page's own timeframe (this flowchart never
/// says "only recompute every 15 minutes" the way the other spec did):
///   1. EMA ALIGNMENT (mandatory): EMA7 &gt; EMA20 &gt; EMA50 (bullish) or EMA7 &lt; EMA20 &lt; EMA50
///      (bearish) - without this there is no candidate direction, so nothing else can score either.
///   2. EMA7 SLOPE: at least +/-<c>slopeMinPercent</c> in the aligned direction.
///   3. ADX &gt;= <c>adxTrendMin</c>.
///   4. VWAP POSITION: close on the aligned side of session VWAP.
///   5. NOT CHOPPY: EMA7/EMA20 crossed each other at most <c>crossCountChopThreshold</c> times in
///      the trailing <c>crossCountWindowMinutes</c> - the flowchart's own "EMA Cross Count... chop if
///      &gt;3 crosses in last 30 mins," folded into the score as its 5th point rather than a separate
///      override, since the flowchart's own regime-score table already tops out at exactly 5 and
///      lists exactly these five checks - a documented reading choice where the source image did not
///      spell out a precise formula.
/// Score &gt;= 4 is "Trending" (points 2 above); score == 3 is "Weak/Uncertain"; score 0-2 is
/// "Sideways/Chop" - the flowchart's own three labels, but "Weak/Uncertain" and "Sideways/Chop" both
/// route to the SAME Range/Sideways execution below (the flowchart's own strategy section only ever
/// draws two boxes - Trending and Range/Sideways - so these two score bands share the one box that
/// isn't Trending).
///
/// HIGH VOLATILITY/EXTREME overrides the score entirely, checked first: page-timeframe ATR% &gt;
/// <c>atrExtremePercent</c> (this app has no VIX feed, so "or VIX high" is dropped, same choice
/// RegimeAdaptiveStrategy already made and documents). No new trades at all while this holds - the
/// flowchart's own "reduce size / hedged only / stay out" collapses to "stay out," the only one of
/// those three this app can do without a capital or defined-risk-spread model (see below).
///
/// STRATEGY PER REGIME:
///   - TRENDING: single-leg directional selling (Bullish -&gt; sell PE, Bearish -&gt; sell CE - this
///     app's standard Sell convention, same note as every other Sell-capable strategy here; the
///     flowchart's own literal "Uptrend -&gt; Sell CE" reads backwards from it).
///   - RANGE/SIDEWAYS: BOTH legs at once - sell CE AND sell PE as two independent concurrent
///     positions (a Short Strangle), triggered on a VWAP+/-ATR band rejection (price closes back
///     inside the band after having been outside it) with RSI inside the flowchart's own 30-70
///     neutral window - achieved the same way as RegimeAdaptiveStrategy's own Strangle: two
///     independent OptionTradeSimulator.Run calls, no changes to its own single-position walk.
///
/// PER-TIMEFRAME DEFAULTS (<see cref="DefaultsForTimeframe"/>): the SAME "one parameter box, default
/// changes with the page's own selected timeframe" mechanism this app already uses everywhere -
/// switching the page timeframe does not add or remove a box, it updates the numbers already in the
/// existing ones (otmSteps/slPercentOfPremium/tpPercentOfPremium/atrNormalHighPercent/
/// atrExtremePercent). Deliberately PLAIN compared to RegimeAdaptiveStrategy: no separate multiplier
/// table per regime - the flowchart gives strike/target/stop guidance once, not once per regime.
///
/// STOP-LOSS/TARGET ARE PERCENT OF PREMIUM (the same additive OptionTradeSimulator.Run extension
/// RegimeAdaptiveStrategy uses) - the flowchart's own "2-3x premium" stop and "1.5-2x risk" target.
/// The target figure does not translate cleanly to a %-of-premium SELL model (a seller's stop can
/// rise unbounded but a target can only ever fall to 0%, so "1.5-2x the stop's own % distance" is
/// not a coherent number for the profit side) - this class uses a plain, independent
/// tpPercentOfPremium instead, a standard theta-seller take-profit level, and documents the
/// substitution here rather than computing a number that would not mean what it claims to.
///
/// WHAT THIS DOES NOT DO - same limitations as RegimeAdaptiveStrategy, for the same reasons (see its
/// own doc comment for the full explanation): no option greeks/delta (OTM distance is a strike-step
/// proxy), no protective long legs (a true Iron Condor), no capital-based position sizing/daily-loss/
/// consecutive-SL state, no OI/Volume-ranked strikes, no economic-calendar filter, no India VIX.
/// </summary>
public sealed class AdaptiveOptionSellingV2Strategy : IBacktestStrategy
{
    public string Key => "adaptive-option-selling-v2";
    public string Name => "Adaptive Option Selling V2 (Plain EMA 7/20/50 Regime Score)";
    public string Description => "A plainer, single-timeframe sibling of Regime-Adaptive: scores Trending/Weak/Sideways (0-5) every bar from EMA 7/20/50 alignment+slope, ADX, VWAP side, and EMA cross count, all on the page's own selected timeframe (no fixed higher timeframe). Trend sells one directional leg; Range/Sideways sells a two-leg short strangle off a VWAP+-ATR band rejection. High volatility takes no new trades. Sells options only, no VIX, no option greeks.";

    private const decimal DirectionBoth = 0;
    private const decimal DirectionLongOnly = 1;
    private const decimal DirectionShortOnly = 2;

    public IReadOnlyList<BacktestParameterSpec> Parameters { get; } = new[]
    {
        new BacktestParameterSpec("signalStartMinutes", "No entries before (IST time)", Default: 570, Min: 0, Max: 1439, Step: 1), // 09:30
        new BacktestParameterSpec("noNewEntriesAfterMinutes", "No new entries from (IST time, 0 = off)", Default: 0, Min: 0, Max: 1439, Step: 1),
        new BacktestParameterSpec("squareOffMinutes", "Force-close any open position at (IST time, 0 = off)", Default: 0, Min: 0, Max: 1439, Step: 1),
        OptionTradeSimulator.ExcludeLastDaysParameter(),
        new BacktestParameterSpec("direction", "Trend-regime direction (Range/Sideways always trades both sides)", Default: DirectionBoth, Min: DirectionBoth, Max: DirectionShortOnly, Step: 1, Options: new[]
        {
            new BacktestParameterOption(DirectionBoth, "Both sides"),
            new BacktestParameterOption(DirectionLongOnly, "Bullish only"),
            new BacktestParameterOption(DirectionShortOnly, "Bearish only"),
        }),

        // ---- Indicators (ONE timeframe - the page's own) ----
        new BacktestParameterSpec("ema7Period", "Fast EMA (bars)", Default: 7, Min: 2, Max: 50, Step: 1),
        new BacktestParameterSpec("ema20Period", "Mid EMA (bars)", Default: 20, Min: 3, Max: 100, Step: 1),
        new BacktestParameterSpec("ema50Period", "Slow EMA (bars)", Default: 50, Min: 5, Max: 300, Step: 1),
        new BacktestParameterSpec("adxPeriod", "ADX (bars)", Default: 14, Min: 2, Max: 100, Step: 1),
        new BacktestParameterSpec("atrPeriod", "ATR (bars)", Default: 14, Min: 2, Max: 100, Step: 1),
        new BacktestParameterSpec("rsiPeriod", "RSI (bars)", Default: 14, Min: 2, Max: 100, Step: 1),
        new BacktestParameterSpec("slopeLookbackBars", "Fast-EMA slope measured over (bars)", Default: 3, Min: 1, Max: 50, Step: 1),

        // ---- Regime-score thresholds (the flowchart's own literal numbers) ----
        new BacktestParameterSpec("slopeMinPercent", "Fast-EMA slope must be at least (%)", Default: 0.05m, Min: 0, Max: 5, Step: 0.01m),
        new BacktestParameterSpec("adxTrendMin", "ADX must be at least, to score the Trend point", Default: 25, Min: 0, Max: 80, Step: 1),
        new BacktestParameterSpec("crossCountWindowMinutes", "EMA7/EMA20 cross-count window (minutes)", Default: 30, Min: 5, Max: 240, Step: 5),
        new BacktestParameterSpec("crossCountChopThreshold", "More crosses than this in that window scores as choppy", Default: 3, Min: 0, Max: 20, Step: 1),
        new BacktestParameterSpec("trendScoreMin", "Score needed (out of 5) to trade Trending", Default: 4, Min: 1, Max: 5, Step: 1),

        // ---- Range/Sideways entry (VWAP+-ATR band rejection) ----
        new BacktestParameterSpec("rangeAtrMultiple", "Range band = VWAP +- this x ATR", Default: 1.5m, Min: 0.2m, Max: 5, Step: 0.1m),
        new BacktestParameterSpec("rsiNeutralLow", "Range entries need RSI above", Default: 30, Min: 0, Max: 50, Step: 1),
        new BacktestParameterSpec("rsiNeutralHigh", "Range entries need RSI below", Default: 70, Min: 50, Max: 100, Step: 1),

        // ---- Volatility gate (page timeframe, % of price) ----
        new BacktestParameterSpec("atrNormalHighPercent", "ATR %% of price - High volatility band starts at", Default: 1.5m, Min: 0, Max: 10, Step: 0.05m),
        new BacktestParameterSpec("atrExtremePercent", "ATR %% of price - Extreme (no new trades) starts at", Default: 2.5m, Min: 0, Max: 15, Step: 0.05m),

        // ---- Strike + risk (plain - one set of values, not one per regime) ----
        new BacktestParameterSpec("otmSteps", "OTM distance (strike steps - ATM or 1 step OTM per the flowchart)", Default: 1, Min: 0, Max: 20, Step: 1),
        new BacktestParameterSpec("slPercentOfPremium", "Stop-loss (%% of premium collected - the flowchart's own \"2-3x premium\")", Default: 250, Min: 1, Max: 1000, Step: 5),
        new BacktestParameterSpec("tpPercentOfPremium", "Profit target (%% of premium collected - see class doc comment on why this isn't literally \"1.5-2x risk\")", Default: 50, Min: 1, Max: 100, Step: 1),
    };

    /// <summary>Only the price-distance parameters scale here - ATR%-of-price bands and the
    /// %-of-premium SL/TP, for the same reason RegimeAdaptiveStrategy's own DefaultsForTimeframe
    /// scales its equivalents (a coarser bar covers more price distance even in ordinary noise).
    /// EMA/ADX/RSI/slope-lookback bar counts and the ADX/RSI thresholds themselves do not scale -
    /// see RegimeAdaptiveStrategy's own doc comment for why (bar counts already mean the same
    /// relative thing, and ADX/RSI are unitless 0-100 oscillators by construction).</summary>
    public IReadOnlyDictionary<string, decimal> DefaultsForTimeframe(int timeframeMinutes)
    {
        var scale = (decimal)Math.Sqrt(Math.Max(1, timeframeMinutes));
        return new Dictionary<string, decimal>
        {
            ["atrNormalHighPercent"] = Math.Round(1.5m * scale, 2),
            ["atrExtremePercent"] = Math.Round(2.5m * scale, 2),
            ["slPercentOfPremium"] = Math.Round(250m * scale, 0),
            ["tpPercentOfPremium"] = Math.Round(Math.Min(95m, 50m * scale), 0),
        };
    }

    public IReadOnlyList<BacktestTrade> Simulate(BacktestStrategyContext context, IReadOnlyDictionary<string, decimal> parameters) =>
        Evaluate(context, parameters).Trades;

    public IReadOnlyList<BacktestSignal> EntrySignals(BacktestStrategyContext context, IReadOnlyDictionary<string, decimal> parameters) =>
        Evaluate(context, parameters).Signals;

    private sealed record LegStream(bool IsCall)
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
        var signalStartMinutes = (int)parameters.GetValueOrDefault("signalStartMinutes", 570m);
        var noNewEntriesAfterMinutes = (int)parameters.GetValueOrDefault("noNewEntriesAfterMinutes", 0m);
        var squareOffMinutes = (int)parameters.GetValueOrDefault("squareOffMinutes", 0m);
        var excludeLastDays = (int)parameters.GetValueOrDefault("excludeLastDays", 0m);

        var ema7Period = Math.Max(2, (int)parameters.GetValueOrDefault("ema7Period", 7m));
        var ema20Period = Math.Max(2, (int)parameters.GetValueOrDefault("ema20Period", 20m));
        var ema50Period = Math.Max(2, (int)parameters.GetValueOrDefault("ema50Period", 50m));
        var adxPeriod = Math.Max(2, (int)parameters.GetValueOrDefault("adxPeriod", 14m));
        var atrPeriod = Math.Max(2, (int)parameters.GetValueOrDefault("atrPeriod", 14m));
        var rsiPeriod = Math.Max(2, (int)parameters.GetValueOrDefault("rsiPeriod", 14m));
        var slopeLookback = Math.Max(1, (int)parameters.GetValueOrDefault("slopeLookbackBars", 3m));

        var slopeMinPercent = parameters.GetValueOrDefault("slopeMinPercent", 0.05m);
        var adxTrendMin = parameters.GetValueOrDefault("adxTrendMin", 25m);
        var crossCountWindowMinutes = (int)parameters.GetValueOrDefault("crossCountWindowMinutes", 30m);
        var crossCountChopThreshold = (int)parameters.GetValueOrDefault("crossCountChopThreshold", 3m);
        var trendScoreMin = Math.Max(1, (int)parameters.GetValueOrDefault("trendScoreMin", 4m));

        var rangeAtrMultiple = parameters.GetValueOrDefault("rangeAtrMultiple", 1.5m);
        var rsiNeutralLow = parameters.GetValueOrDefault("rsiNeutralLow", 30m);
        var rsiNeutralHigh = parameters.GetValueOrDefault("rsiNeutralHigh", 70m);

        var atrExtremePercent = parameters.GetValueOrDefault("atrExtremePercent", 2.5m);

        var otmSteps = Math.Max(0, (int)parameters.GetValueOrDefault("otmSteps", 1m));
        var slPercentOfPremium = parameters.GetValueOrDefault("slPercentOfPremium", 250m);
        var tpPercentOfPremium = parameters.GetValueOrDefault("tpPercentOfPremium", 50m);

        var noTrades = (Array.Empty<BacktestTrade>() as IReadOnlyList<BacktestTrade>, Array.Empty<BacktestSignal>() as IReadOnlyList<BacktestSignal>);

        var pageBars = context.SpotBars;
        if (pageBars.Count < ema50Period + slopeLookback + 5) return noTrades;

        var quotes = ToQuotes(pageBars);
        var ema7 = EmaCrossoverDetector.EmaSeries(pageBars, ema7Period);
        var ema20 = EmaCrossoverDetector.EmaSeries(pageBars, ema20Period);
        var ema50 = EmaCrossoverDetector.EmaSeries(pageBars, ema50Period);
        var adx = quotes.GetAdx(adxPeriod).Select(r => (decimal?)r.Adx).ToList();
        var rsi = quotes.GetRsi(rsiPeriod).Select(r => (decimal?)r.Rsi).ToList();
        var atr = quotes.GetAtr(atrPeriod).Select(r => (decimal?)r.Atr).ToList();
        var atrPercent = pageBars.Select((b, i) => atr[i] is { } a && b.Close != 0 ? (decimal?)(a / b.Close * 100m) : null).ToList();

        var vwapSeries1m = VwapCalculator.ComputeSeries(context.SpotVolumeBarsOneMinute);
        var vwapOnPage = AlignToTime(vwapSeries1m, pageBars, context.TimeframeMinutes);

        var crossCountWindowBars = Math.Max(1, crossCountWindowMinutes / Math.Max(1, context.TimeframeMinutes));
        var crossedUp = pageBars.Select((_, i) => i > 0 && ema7[i - 1] is { } pf && ema20[i - 1] is { } ps && ema7[i] is { } cf && ema20[i] is { } cs && pf <= ps && cf > cs).ToList();
        var crossedDown = pageBars.Select((_, i) => i > 0 && ema7[i - 1] is { } pf && ema20[i - 1] is { } ps && ema7[i] is { } cf && ema20[i] is { } cs && pf >= ps && cf < cs).ToList();

        var regimeType = new string?[pageBars.Count];
        var regimeDirection = new string?[pageBars.Count];

        for (var i = Math.Max(1, slopeLookback); i < pageBars.Count; i++)
        {
            if (atrPercent[i] is { } atrPctNow && atrPctNow > atrExtremePercent) { regimeType[i] = "HighVol"; continue; }
            if (ema7[i] is not { } f7 || ema20[i] is not { } f20 || ema50[i] is not { } f50) continue;
            if (adx[i] is not { } adxNow) continue;
            if (vwapOnPage[i] is not { } vwapNow) continue;

            var bullishAlign = f7 > f20 && f20 > f50;
            var bearishAlign = f7 < f20 && f20 < f50;
            var candidate = bullishAlign ? "Bullish" : bearishAlign ? "Bearish" : null;

            var score = 0;
            if (candidate is { } dir)
            {
                score = 1;
                var bullish = dir == "Bullish";
                var slope = Slope(ema7, i, slopeLookback);
                if (slope is { } slv && (bullish ? slv >= slopeMinPercent : slv <= -slopeMinPercent)) score++;
                if (adxNow >= adxTrendMin) score++;
                if (bullish ? pageBars[i].Close > vwapNow : pageBars[i].Close < vwapNow) score++;

                var windowStart = Math.Max(0, i - crossCountWindowBars + 1);
                var crosses = 0;
                for (var k = windowStart; k <= i; k++) if (crossedUp[k] || crossedDown[k]) crosses++;
                if (crosses <= crossCountChopThreshold) score++;
            }

            if (candidate is not null && score >= trendScoreMin)
            {
                regimeType[i] = "Trending";
                regimeDirection[i] = candidate;
            }
            else
            {
                regimeType[i] = "RangeSideways";
            }
        }

        var step = context.Step;
        // Keyed by (regime type, leg) - NOT leg alone - so a Trend CE sell (single leg, its own
        // sequential bets from different downtrend windows) never shares a signal stream with a
        // Range/Sideways CE sell (one half of a paired Strangle) just because both happen to sell
        // the same option type. Pairing for synchronized square-off below only ever looks within one
        // regime type's own two leg-streams.
        var streams = new Dictionary<(string RegimeType, bool IsCall), LegStream>();
        LegStream StreamFor(string regimeTypeNow, bool isCall)
        {
            var key = (regimeTypeNow, isCall);
            return streams.TryGetValue(key, out var s) ? s : streams[key] = new LegStream(isCall);
        }

        var signals = new List<BacktestSignal>();

        (DateTimeOffset Time, string Reason) ComputeExit(int entryIndex, bool isCall, decimal strike, string regimeTypeAtEntry)
        {
            DateTimeOffset? regimeChangeTime = null;
            DateTimeOffset? breachTime = null;
            for (var j = entryIndex + 1; j < pageBars.Count; j++)
            {
                var bar = pageBars[j];
                if (regimeChangeTime is null && regimeType[j] != regimeTypeAtEntry) regimeChangeTime = bar.Time;
                if (breachTime is null && atr[j] is { } atrNow)
                {
                    var breached = isCall ? bar.Close >= strike + 0.5m * atrNow : bar.Close <= strike - 0.5m * atrNow;
                    if (breached) breachTime = bar.Time;
                }
                if (regimeChangeTime is not null && breachTime is not null) break;
            }
            var candidates = new List<(DateTimeOffset Time, string Reason)>();
            if (regimeChangeTime is { } rc) candidates.Add((rc, "RegimeChange"));
            if (breachTime is { } bt) candidates.Add((bt, "StrikeBreach"));
            // No time-stop here (the flowchart gives no explicit max-holding-time table the way the
            // other spec did) - squareOffMinutes and the ordinary SL/TP already bound how long a
            // position can run.
            return candidates.Count > 0 ? candidates.OrderBy(c => c.Time).First() : (pageBars[^1].Time, "EndOfData");
        }

        void TryEnter(int i, bool bullish, string regimeTypeNow, string reasonSummary)
        {
            var time = pageBars[i].Time;
            var minutesOfDay = IstClock.MinutesOfDay(time);
            var beforeStart = signalStartMinutes > 0 && minutesOfDay < signalStartMinutes;
            var afterCutoff = noNewEntriesAfterMinutes > 0 && minutesOfDay >= noNewEntriesAfterMinutes;
            var directionBlocked = regimeTypeNow == "Trending" && ((bullish && !takeLongs) || (!bullish && !takeShorts));

            if (beforeStart)
                signals.Add(new BacktestSignal(context.Underlying, time, "Rejected", bullish ? "Bullish" : "Bearish", $"{reasonSummary} - skipped, before {IstClock.FormatMinutesOfDay(signalStartMinutes)} IST"));
            else if (afterCutoff)
                signals.Add(new BacktestSignal(context.Underlying, time, "Rejected", bullish ? "Bullish" : "Bearish", $"{reasonSummary} - skipped, at/after {IstClock.FormatMinutesOfDay(noNewEntriesAfterMinutes)} IST (no new entries)"));
            else if (directionBlocked)
                signals.Add(new BacktestSignal(context.Underlying, time, "Rejected", bullish ? "Bullish" : "Bearish", $"{reasonSummary} - skipped, direction filter"));
            else
            {
                var isCall = !bullish; // sells only - Bullish->sell PE, Bearish->sell CE
                var stream = StreamFor(regimeTypeNow, isCall);
                var atmAtSignal = step > 0 ? Math.Round(pageBars[i].Close / step) * step : pageBars[i].Close;
                var strike = isCall ? atmAtSignal + otmSteps * step : atmAtSignal - otmSteps * step;

                stream.Signals.Add((time, bullish ? "Bullish" : "Bearish"));
                stream.Exits[time] = ComputeExit(i, isCall, strike, regimeTypeNow);
                signals.Add(new BacktestSignal(context.Underlying, time, "Entry", bullish ? "Bullish" : "Bearish", $"{reasonSummary} -> sell {(isCall ? "CE" : "PE")} {otmSteps} OTM"));
            }
        }

        for (var i = 1; i < pageBars.Count; i++)
        {
            if (regimeType[i] is not { } regime || regime == "HighVol") continue;

            if (regime == "Trending")
            {
                if (regimeDirection[i] is not { } dir) continue;
                TryEnter(i, dir == "Bullish", "Trending", $"Trending (score>={trendScoreMin}/5) {dir} - EMA7/20/50 aligned, ADX/slope/VWAP confirmed");
                continue;
            }

            // Range/Sideways - VWAP+-ATR band rejection, RSI neutral, both legs at once.
            if (vwapOnPage[i] is not { } vwapNow || vwapOnPage[i - 1] is not { } prevVwap) continue;
            if (atr[i] is not { } atrNow || atr[i - 1] is not { } prevAtr) continue;
            if (rsi[i] is not { } rsiNow) continue;
            var rsiOk = rsiNow > rsiNeutralLow && rsiNow < rsiNeutralHigh;
            if (!rsiOk) continue;

            var lower = vwapNow - atrNow * rangeAtrMultiple;
            var prevLower = prevVwap - prevAtr * rangeAtrMultiple;
            var upper = vwapNow + atrNow * rangeAtrMultiple;
            var prevUpper = prevVwap + prevAtr * rangeAtrMultiple;
            var rejectedLower = pageBars[i - 1].Close <= prevLower && pageBars[i].Close > lower;
            var rejectedUpper = pageBars[i - 1].Close >= prevUpper && pageBars[i].Close < upper;
            if (!rejectedLower && !rejectedUpper) continue;

            var summary = $"Range/Sideways, VWAP+-{rangeAtrMultiple:0.#}xATR band rejection, RSI {rsiNow:0.#} - Short Strangle";
            TryEnter(i, true, "RangeSideways", summary); // Bullish leg -> sell PE
            TryEnter(i, false, "RangeSideways", summary); // Bearish leg -> sell CE
        }

        Dictionary<string, decimal> BuildStreamParameters() => new(parameters)
        {
            ["side"] = OptionTradeSimulator.SideSell,
            ["otmSteps"] = otmSteps,
            ["slPoints"] = 0m,
            ["tpPoints"] = 0m,
            ["slPercentOfPremium"] = slPercentOfPremium,
            ["tpPercentOfPremium"] = tpPercentOfPremium,
            ["squareOffMinutes"] = squareOffMinutes,
            ["excludeLastDays"] = excludeLastDays,
        };

        // Range/Sideways' two legs were entered TOGETHER (a Short Strangle) and, per explicit
        // instruction, must square off together too - see OptionTradeSimulator.RunPairedLegs' own
        // doc comment. Trending's own two possible leg-streams are NEVER paired - sequential
        // single-leg bets from different, non-overlapping regime windows, not one two-leg position.
        var trades = new List<BacktestTrade>();
        foreach (var regimeTypeKey in streams.Keys.Select(k => k.RegimeType).Distinct())
        {
            var hasCall = streams.TryGetValue((regimeTypeKey, true), out var callStream) && callStream.Signals.Count > 0;
            var hasPut = streams.TryGetValue((regimeTypeKey, false), out var putStream) && putStream.Signals.Count > 0;

            if (regimeTypeKey == "RangeSideways" && hasCall && hasPut)
            {
                trades.AddRange(OptionTradeSimulator.RunPairedLegs(
                    context,
                    putStream!.Signals, putStream.Exits, BuildStreamParameters(),
                    callStream!.Signals, callStream.Exits, BuildStreamParameters()));
            }
            else
            {
                if (hasCall) trades.AddRange(OptionTradeSimulator.Run(context, callStream!.Signals, BuildStreamParameters(), signalExits: callStream.Exits));
                if (hasPut) trades.AddRange(OptionTradeSimulator.Run(context, putStream!.Signals, BuildStreamParameters(), signalExits: putStream.Exits));
            }
        }

        return (trades.OrderByDescending(t => t.SignalTimeUtc).ToList(), signals.OrderByDescending(s => s.TimeUtc).ToList());
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

    /// <summary>Aligns the 1-minute VWAP series onto the page's own timeframe bars, using each side's
    /// own CLOSE time - the same non-look-ahead rule RegimeAdaptiveStrategy's own alignment helpers
    /// use, simplified here since there is only ever ONE target timeframe (the page's) in this
    /// class, not several.</summary>
    private static List<decimal?> AlignToTime(IReadOnlyList<ObvPoint> series, IReadOnlyList<Candle> targetBars, int targetBucketMinutes)
    {
        var targetSpan = TimeSpan.FromMinutes(targetBucketMinutes);
        var result = new List<decimal?>(targetBars.Count);
        var pointer = 0;
        decimal? current = null;
        foreach (var bar in targetBars)
        {
            var targetKnownAt = bar.Time + targetSpan;
            while (pointer < series.Count && series[pointer].Time + TimeSpan.FromMinutes(1) <= targetKnownAt)
            {
                current = series[pointer].Obv;
                pointer++;
            }
            result.Add(current);
        }
        return result;
    }
}
