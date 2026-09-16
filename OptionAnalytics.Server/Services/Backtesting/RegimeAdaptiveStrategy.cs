using OptionAnalytics.Server.Models;
using OptionAnalytics.Server.Services;
using Skender.Stock.Indicators;

namespace OptionAnalytics.Server.Services.Backtesting;

/// <summary>
/// A "classify the regime first, then pick a strategy for it" approach - the answer to a real,
/// specific complaint (a single fixed strategy working some months and not others) rather than
/// another fixed rule set: a market that is genuinely trending and a market that is genuinely
/// chopping sideways call for opposite tactics (ride a pullback vs. fade an extreme), and running
/// the same one regardless of which regime is actually in effect is exactly why a strategy tuned on
/// a trending month can bleed through a sideways one.
///
/// REGIME, recomputed fresh at every bar from five independently-checkable inputs (EMA7/20/50
/// stack + slope, VWAP side, ADX strength, and a rolling EMA/VWAP "chop count"):
///
///   1. CHOP SCORE (0-5, each true adds one) over the last <c>chopLookbackBars</c> bars:
///      - EMA7/EMA20 crossed at least <c>minChopCrosses</c> times
///      - close crossed VWAP at least <c>minChopCrosses</c> times
///      - ADX(<c>adxPeriod</c>) is below <c>adxThreshold</c> (not trending strongly enough to trust)
///      - the EMA7 slope over <c>slopeLookbackBars</c> bars is within +-<c>slopeThresholdPercent</c>
///        of flat
///      - ATR(<c>atrPeriod</c>) has contracted below <c>atrContractionRatio</c> of its own
///        <c>chopLookbackBars</c>-bar average (volatility drying up, the ATR/India-VIX role - this
///        app has no VIX feed, so ATR is the volatility proxy throughout)
///      Reaching <c>choppyScoreThreshold</c> or more of these five calls the bar RANGE outright,
///      regardless of how the EMA stack happens to be ordered at that instant - the whole point of a
///      chop score is to catch a market whose EMAs are technically stacked one way this instant but
///      are actually just churning, not actually trending.
///   2. Otherwise, TRENDING BULLISH needs ALL of: EMA7 &gt; EMA20 &gt; EMA50, the EMA7 slope at least
///      +<c>slopeThresholdPercent</c>, and close above VWAP - the "stack + slope + VWAP side" checks
///      from the user's own brief, ANDed together rather than any one alone (a stacked-but-flat EMA,
///      or a stacked EMA with price still under VWAP, is exactly the kind of half-trend this filter
///      exists to reject). TRENDING BEARISH is the exact mirror.
///   3. Anything left over (an ambiguous EMA order, or a stack without the slope/VWAP to back it up,
///      but not choppy enough to positively flag) defaults to RANGE - the safe fallback, since taking
///      the trend-continuation entry needs a genuinely confirmed trend, not merely "not obviously
///      chopping".
///
/// TREND STRATEGY (regime TrendingBullish/Bearish): buy the shallow pullback back through EMA20 in
/// the trend's own direction - EMA7 crossing back above EMA20 while regime reads TrendingBullish
/// (below for Bearish). Because the regime itself already requires EMA7&gt;EMA20&gt;EMA50, this fires
/// either the moment the stack first re-forms after a dip, or after a brief EMA7 wobble through EMA20
/// inside an already-established bigger trend - a real continuation entry, not a fresh-trend-start
/// guess.
///
/// RANGE STRATEGY (regime Range): fade the extremes of a VWAP+-ATR band (<c>rangeAtrMultiple</c> x
/// ATR either side of VWAP) - close rejecting back up through the lower band (Bullish) or back down
/// through the upper band (Bearish). A VWAP/ATR band is the natural range-trading counterpart to the
/// same two inputs the regime filter already computes for chop detection, needing no third
/// indicator.
///
/// ORDER FLOW: unlike every other strategy here, CDV/OBV confirmation (the same FlowConfirmation
/// filter FiveEmaStrategy/LuxAlgoSrBreakStrategy/SrChannelStrategy use) defaults ON, not off - the
/// user's own explicit instruction ("always add CDV and OBV filter") for this one. Still a real
/// parameter (not hardcoded) so it can be turned off for an underlying/window whose Dhan plan does
/// not carry the flow data this needs, the same escape hatch every other flow-gated strategy already
/// has.
///
/// A NOTE ON THE NUMBERS: minChopCrosses/adxThreshold/slopeThresholdPercent/atrContractionRatio/
/// choppyScoreThreshold/rangeAtrMultiple are this class's own reasonable starting points (20/25-style
/// conventional ADX reading, a standard volatility-contraction ratio, etc.), not values verified
/// against this app's own historical NIFTY/BANKNIFTY data - the user asked for a regime-adaptive
/// strategy built from first principles, not for a specific back-tested parameter set, and every one
/// of these is a tunable BacktestParameterSpec precisely so it can be adjusted against real results
/// rather than trusted blindly.
/// </summary>
public sealed class RegimeAdaptiveStrategy : IBacktestStrategy
{
    public string Key => "regime-adaptive";
    public string Name => "Regime-Adaptive (Trend/Range)";
    public string Description => "Classifies every bar as Trending or Range first (EMA7/20/50 stack + slope, VWAP side, ADX strength, and an EMA/VWAP chop count), then runs a pullback-continuation entry in a confirmed trend or a VWAP+-ATR band fade in a range - built for the common complaint that one fixed strategy works some months and not others. CDV/OBV order-flow confirmation is ON by default here.";

    private const decimal DirectionBoth = 0;
    private const decimal DirectionLongOnly = 1;
    private const decimal DirectionShortOnly = 2;

    private const decimal FlagOff = 0;
    private const decimal FlagOn = 1;

    private enum Regime { Range, TrendingBullish, TrendingBearish }

    public IReadOnlyList<BacktestParameterSpec> Parameters { get; } = new[]
    {
        OptionTradeSimulator.SideParameter(),
        OptionTradeSimulator.StrikeOffsetParameter(),
        OptionTradeSimulator.StopLossParameter(),
        OptionTradeSimulator.TakeProfitParameter(),
        OptionTradeSimulator.SquareOffTimeParameter(),
        OptionTradeSimulator.SignalStartTimeParameter(),
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
        new BacktestParameterSpec("adxThreshold", "ADX below this counts toward chop", Default: 20, Min: 0, Max: 60, Step: 1),
        new BacktestParameterSpec("atrPeriod", "ATR (bars)", Default: 14, Min: 2, Max: 100, Step: 1),
        new BacktestParameterSpec("atrContractionRatio", "ATR below this x its own average counts toward chop", Default: 0.8m, Min: 0.1m, Max: 1, Step: 0.05m),
        new BacktestParameterSpec("chopLookbackBars", "Chop count window (bars)", Default: 20, Min: 5, Max: 100, Step: 1),
        new BacktestParameterSpec("minChopCrosses", "EMA/VWAP crosses in that window needed to count toward chop", Default: 3, Min: 1, Max: 20, Step: 1),
        new BacktestParameterSpec("choppyScoreThreshold", "Chop signals needed (out of 5) to call the bar Range", Default: 3, Min: 1, Max: 5, Step: 1),
        new BacktestParameterSpec("rangeAtrMultiple", "Range fade band = VWAP +- this x ATR", Default: 1.5m, Min: 0.2m, Max: 5, Step: 0.1m),
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
        var signalStartMinutes = (int)parameters.GetValueOrDefault("signalStartMinutes", 555);

        var emaFastPeriod = Math.Max(2, (int)parameters.GetValueOrDefault("emaFastPeriod", 7));
        var emaMidPeriod = Math.Max(3, (int)parameters.GetValueOrDefault("emaMidPeriod", 20));
        var emaSlowPeriod = Math.Max(5, (int)parameters.GetValueOrDefault("emaSlowPeriod", 50));
        var slopeLookback = Math.Max(1, (int)parameters.GetValueOrDefault("slopeLookbackBars", 5));
        var slopeThreshold = parameters.GetValueOrDefault("slopeThresholdPercent", 0.05m);
        var adxPeriod = Math.Max(2, (int)parameters.GetValueOrDefault("adxPeriod", 14));
        var adxThreshold = parameters.GetValueOrDefault("adxThreshold", 20m);
        var atrPeriod = Math.Max(2, (int)parameters.GetValueOrDefault("atrPeriod", 14));
        var atrContractionRatio = parameters.GetValueOrDefault("atrContractionRatio", 0.8m);
        var chopLookback = Math.Max(2, (int)parameters.GetValueOrDefault("chopLookbackBars", 20));
        var minChopCrosses = Math.Max(1, (int)parameters.GetValueOrDefault("minChopCrosses", 3));
        var choppyScoreThreshold = Math.Max(1, (int)parameters.GetValueOrDefault("choppyScoreThreshold", 3));
        var rangeAtrMultiple = parameters.GetValueOrDefault("rangeAtrMultiple", 1.5m);

        var requireFlowConfirmation = parameters.GetValueOrDefault("requireFlowConfirmation", FlagOn) >= (FlagOff + FlagOn) / 2;
        var flowLookback = (int)parameters.GetValueOrDefault("flowLookbackBars", 5);
        var minFlowRisePercent = parameters.GetValueOrDefault("minFlowRisePercent", 0m);
        var flowMode = parameters.GetValueOrDefault("flowMode", FlowConfirmation.ModeEither);
        var flowWindow = TimeSpan.FromMinutes((double)Math.Max(1, flowLookback) * Math.Max(1, context.TimeframeMinutes));

        var entries = new List<(DateTimeOffset Time, string Direction)>();
        var signals = new List<BacktestSignal>();

        var bars = context.SpotBars;
        if (bars.Count < emaSlowPeriod + slopeLookback + 2) return (entries, signals);

        var ema7 = EmaCrossoverDetector.EmaSeries(bars, emaFastPeriod);
        var ema20 = EmaCrossoverDetector.EmaSeries(bars, emaMidPeriod);
        var ema50 = EmaCrossoverDetector.EmaSeries(bars, emaSlowPeriod);
        var adx = ToQuotes(bars).GetAdx(adxPeriod).Select(r => (decimal?)r.Adx).ToList();
        var atr = ToQuotes(bars).GetAtr(atrPeriod).Select(r => (decimal?)r.Atr).ToList();
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
        for (var i = slopeLookback; i < bars.Count; i++)
        {
            if (ema7[i] is not { } f || ema20[i] is not { } m || ema50[i] is not { } s) continue;
            if (ema7[i - slopeLookback] is not { } fPast || fPast == 0) continue;
            if (adx[i] is not { } adxNow || vwap[i] is not { } vwapNow) continue;

            var slopePercent = (f - fPast) / Math.Abs(fPast) * 100m;
            var chopScore = ChopScore(bars, ema7, ema20, vwap, adx, atr, i, chopLookback, minChopCrosses, adxThreshold, slopeLookback, slopeThreshold, atrContractionRatio);

            if (chopScore >= choppyScoreThreshold)
                regimes[i] = Regime.Range;
            else if (f > m && m > s && slopePercent >= slopeThreshold && bars[i].Close > vwapNow)
                regimes[i] = Regime.TrendingBullish;
            else if (f < m && m < s && slopePercent <= -slopeThreshold && bars[i].Close < vwapNow)
                regimes[i] = Regime.TrendingBearish;
            else
                regimes[i] = Regime.Range;
        }

        for (var i = Math.Max(1, slopeLookback); i < bars.Count; i++)
        {
            if (regimes[i] is not { } regime || regimes[i - 1] is null) continue;
            if (ema7[i] is not { } f || ema7[i - 1] is not { } prevF) continue;
            if (ema20[i] is not { } m || ema20[i - 1] is not { } prevM) continue;

            var bar = bars[i];
            var prevBar = bars[i - 1];
            var beforeSignalStart = signalStartMinutes > 0 && IstClock.MinutesOfDay(bar.Time) < signalStartMinutes;

            void Emit(bool bullish, string summary)
            {
                var dir = bullish ? "Bullish" : "Bearish";
                if (beforeSignalStart)
                    signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Rejected", dir, $"{summary} - skipped, before {IstClock.FormatMinutesOfDay(signalStartMinutes)} IST (pre-open)"));
                else if (bullish && !takeLongs)
                    signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Rejected", dir, $"{summary} - skipped, shorts only"));
                else if (!bullish && !takeShorts)
                    signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Rejected", dir, $"{summary} - skipped, longs only"));
                else if (FlowCheck(bullish, bar.Time) is (false, var rejectReason))
                    signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Rejected", dir, $"{summary} - but {rejectReason}"));
                else
                {
                    var flowReason = requireFlowConfirmation ? FlowCheck(bullish, bar.Time).Reason : null;
                    signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Entry", dir, flowReason is { Length: > 0 } ? $"{summary}, and {flowReason}" : summary));
                    entries.Add((bar.Time, dir));
                }
            }

            if (regime == Regime.TrendingBullish && prevF <= prevM && f > m)
            {
                Emit(true, $"Regime Trending Bullish (EMA{emaFastPeriod}/{emaMidPeriod}/{emaSlowPeriod} stacked up, sloping up, above VWAP) - EMA{emaFastPeriod} crossed back over EMA{emaMidPeriod}");
            }
            else if (regime == Regime.TrendingBearish && prevF >= prevM && f < m)
            {
                Emit(false, $"Regime Trending Bearish (EMA{emaFastPeriod}/{emaMidPeriod}/{emaSlowPeriod} stacked down, sloping down, below VWAP) - EMA{emaFastPeriod} crossed back under EMA{emaMidPeriod}");
            }
            else if (regime == Regime.Range && vwap[i] is { } vwapNow && vwap[i - 1] is { } prevVwap && atr[i] is { } atrNow && atr[i - 1] is { } prevAtr)
            {
                var lower = vwapNow - atrNow * rangeAtrMultiple;
                var prevLower = prevVwap - prevAtr * rangeAtrMultiple;
                var upper = vwapNow + atrNow * rangeAtrMultiple;
                var prevUpper = prevVwap + prevAtr * rangeAtrMultiple;

                if (prevBar.Close <= prevLower && bar.Close > lower)
                    Emit(true, $"Regime Range - close rejected back above the VWAP-{rangeAtrMultiple:0.#}xATR lower band ({lower:0.##})");
                else if (prevBar.Close >= prevUpper && bar.Close < upper)
                    Emit(false, $"Regime Range - close rejected back below the VWAP+{rangeAtrMultiple:0.#}xATR upper band ({upper:0.##})");
            }
        }

        return (entries, signals.OrderByDescending(s => s.TimeUtc).ToList());
    }

    /// <summary>0-5 - see this class's own doc comment for what each of the five checks means. A
    /// missing ATR average (fewer than <paramref name="chopLookback"/> prior bars with a reading)
    /// simply does not contribute that one point, rather than blocking the whole score.</summary>
    private static int ChopScore(
        IReadOnlyList<Candle> bars, IReadOnlyList<decimal?> ema7, IReadOnlyList<decimal?> ema20, IReadOnlyList<decimal?> vwap,
        IReadOnlyList<decimal?> adx, IReadOnlyList<decimal?> atr, int index, int chopLookback, int minChopCrosses,
        decimal adxThreshold, int slopeLookback, decimal slopeThreshold, decimal atrContractionRatio)
    {
        var score = 0;
        var windowStart = Math.Max(1, index - chopLookback + 1);

        var emaCrosses = 0;
        var vwapCrosses = 0;
        for (var j = windowStart; j <= index; j++)
        {
            if (ema7[j] is { } f && ema20[j] is { } m && ema7[j - 1] is { } prevF && ema20[j - 1] is { } prevM)
                if (Math.Sign(f - m) != Math.Sign(prevF - prevM) && Math.Sign(f - m) != 0 && Math.Sign(prevF - prevM) != 0) emaCrosses++;

            if (vwap[j] is { } v && vwap[j - 1] is { } prevV)
            {
                var now = Math.Sign(bars[j].Close - v);
                var prev = Math.Sign(bars[j - 1].Close - prevV);
                if (now != prev && now != 0 && prev != 0) vwapCrosses++;
            }
        }

        if (emaCrosses >= minChopCrosses) score++;
        if (vwapCrosses >= minChopCrosses) score++;
        if (adx[index] is { } adxNow && adxNow < adxThreshold) score++;

        if (ema7[index] is { } fNow && index - slopeLookback >= 0 && ema7[index - slopeLookback] is { } fPast && fPast != 0)
        {
            var slopePercent = Math.Abs((fNow - fPast) / Math.Abs(fPast) * 100m);
            if (slopePercent < slopeThreshold) score++;
        }

        if (atr[index] is { } atrNow)
        {
            var atrWindowStart = Math.Max(0, index - chopLookback + 1);
            var atrValues = new List<decimal>();
            for (var j = atrWindowStart; j <= index; j++) if (atr[j] is { } a) atrValues.Add(a);
            if (atrValues.Count > 0)
            {
                var average = atrValues.Average();
                if (average > 0 && atrNow < average * atrContractionRatio) score++;
            }
        }

        return score;
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
