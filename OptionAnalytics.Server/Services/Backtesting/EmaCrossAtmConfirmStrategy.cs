using OptionAnalytics.Server.Models;

namespace OptionAnalytics.Server.Services.Backtesting;

/// <summary>
/// EmaCrossAtmFlowStrategy's own spot+ATM-cross idea, minus the order-flow gate, built on
/// GetOptionBars(strike, isCall) for one SPECIFIC absolute strike's own candles instead of the
/// live-only AtmCeBars/AtmPeBars/ObvCeSeries/CdvCeSeries fields - the two things that strategy
/// depends on that Expired Backtest has no way to supply (see its own SupportedStrategyKeys doc
/// comment: it would need ~17 separate rolling-option calls per side per run just for the flow
/// series, quite apart from AtmCeBars/AtmPeBars themselves being a live-only snapshot). This one
/// only ever reads SpotBars plus GetOptionBars(strike, isCall) - the same narrow contract the
/// five-ema family already relies on - so it runs on BOTH the live Backtrack page and Expired
/// Backtest, at the user's own explicit request.
///
/// Two (or three, when RequireOppositeLegConfirm is on - the default) things have to agree before a
/// trade is taken:
///
///   1. SPOT's fast EMA crosses its slow EMA - the direction call.
///   2. The PURE ATM option on the side implied by that call (CE for bullish, PE for bearish) makes
///      the SAME fast/slow EMA cross UP on its own premium, within a short backward-looking window
///      (see EmaCrossAtmFlowStrategy's own doc comment for why "up" for both sides - being bought
///      means that leg's own premium turning up, whichever side it is. CE for a bullish call, PE
///      for a bearish one).
///   3. (Optional, ON by default - the extra confirmation the user asked for) The OPPOSITE leg (PE
///      for bullish, CE for bearish) crosses the OTHER way - DOWN - in the same window. CE and PE
///      premiums normally move against each other, so a real directional move should show up as one
///      leg rising while the other falls, not just one leg moving in isolation - requiring both is a
///      stricter, cleaner signal than the same-leg check alone.
///
/// "ATM" here always means the strike nearest spot AT THE SIGNAL BAR'S OWN TIME
/// (Math.Round(spot / step) * step) - independent of otmSteps, which only decides which strike the
/// TRADE itself is actually taken at (same convention every other strategy here uses for its entry
/// strike; 0, the default, trades the very same ATM strike the confirmations already checked).
///
/// On Expired Backtest specifically: GetOptionBars only ever has data for a strike within the
/// fetched band (otmSteps +/- StrikeBandSteps - see ExpiredOptionBacktestService), so if the
/// underlying's ATM has drifted further than that many steps away from otmSteps by the time a
/// candidate crossover happens, the ATM confirmation simply finds no data and the signal is
/// rejected rather than silently confirmed - the same fail-closed behavior every other strike-band
/// consumer already has, not a new failure mode this strategy introduces.
/// </summary>
public sealed class EmaCrossAtmConfirmStrategy : IBacktestStrategy
{
    public string Key => "ema-cross-atm-confirm";
    public string Name => "EMA Crossover + ATM Confirmation";
    public string Description => "Enters when spot's fast EMA crosses its slow EMA AND the pure ATM option on that side (CE for bullish, PE for bearish) makes the same upward cross on its own premium within a short window - optionally also requiring the OPPOSITE leg to cross the other way in the same window, since CE/PE normally move against each other on a real directional move. Unlike the flow-confirmed EMA crossover strategy, this one runs on Expired Backtest too.";

    private const decimal DirectionBoth = 0;
    private const decimal DirectionLongOnly = 1;
    private const decimal DirectionShortOnly = 2;

    private const decimal FlagOff = 0;
    private const decimal FlagOn = 1;

    public IReadOnlyList<BacktestParameterSpec> Parameters { get; } = new[]
    {
        OptionTradeSimulator.SideParameter(),
        new BacktestParameterSpec("otmSteps", "Strike to TRADE, steps from ATM (confirmation always checks pure ATM)", Default: 0, Min: -8, Max: 8, Step: 1),
        OptionTradeSimulator.StopLossParameter(),
        OptionTradeSimulator.TakeProfitParameter(),
        OptionTradeSimulator.SquareOffTimeParameter(),
        OptionTradeSimulator.SignalStartTimeParameter(),
        OptionTradeSimulator.ExcludeLastDaysParameter(),
        new BacktestParameterSpec("fastEmaPeriod", "Fast EMA (bars)", Default: 9, Min: 1, Max: 200, Step: 1),
        new BacktestParameterSpec("slowEmaPeriod", "Slow EMA (bars)", Default: 21, Min: 2, Max: 400, Step: 1),
        new BacktestParameterSpec("atmConfirmWithinBars", "ATM cross must land within (bars, 0 = same bar)", Default: 3, Min: 0, Max: 50, Step: 1),
        new BacktestParameterSpec("requireOppositeLegConfirm", "Also require the opposite leg to cross the other way", Default: FlagOn, Min: FlagOff, Max: FlagOn, Step: 1, Options: new[]
        {
            new BacktestParameterOption(FlagOn, "Yes - stricter (both legs must agree)"),
            new BacktestParameterOption(FlagOff, "No - same-leg confirmation only"),
        }),
        new BacktestParameterSpec("direction", "Take", Default: DirectionBoth, Min: DirectionBoth, Max: DirectionShortOnly, Step: 1, Options: new[]
        {
            new BacktestParameterOption(DirectionBoth, "Both sides"),
            new BacktestParameterOption(DirectionLongOnly, "Longs only"),
            new BacktestParameterOption(DirectionShortOnly, "Shorts only"),
        }),
    };

    public IReadOnlyList<BacktestTrade> Simulate(BacktestStrategyContext context, IReadOnlyDictionary<string, decimal> parameters) =>
        OptionTradeSimulator.Run(context, Evaluate(context, parameters).Entries, parameters);

    public IReadOnlyList<BacktestSignal> EntrySignals(BacktestStrategyContext context, IReadOnlyDictionary<string, decimal> parameters) =>
        Evaluate(context, parameters).Signals;

    private (List<(DateTimeOffset Time, string Direction)> Entries, List<BacktestSignal> Signals) Evaluate(
        BacktestStrategyContext context, IReadOnlyDictionary<string, decimal> parameters)
    {
        var fastPeriod = (int)parameters["fastEmaPeriod"];
        var slowPeriod = (int)parameters["slowEmaPeriod"];
        var confirmWithin = (int)parameters["atmConfirmWithinBars"];
        var requireOppositeLeg = parameters["requireOppositeLegConfirm"] >= (FlagOff + FlagOn) / 2;
        var direction = parameters["direction"];
        var signalStartMinutes = (int)parameters.GetValueOrDefault("signalStartMinutes", 555);
        var step = context.Step;

        var entries = new List<(DateTimeOffset Time, string Direction)>();
        var signals = new List<BacktestSignal>();

        // A fast EMA that is not actually faster makes every "cross" meaningless, and a zero/
        // negative step makes "the nearest strike" undefined - reject outright rather than produce
        // nonsense trades either way.
        if (fastPeriod >= slowPeriod || step <= 0) return (entries, signals);

        var takeLongs = direction != DirectionShortOnly;
        var takeShorts = direction != DirectionLongOnly;

        var bars = context.SpotBars;
        var spotFast = EmaCrossoverDetector.EmaSeries(bars, fastPeriod);
        var spotSlow = EmaCrossoverDetector.EmaSeries(bars, slowPeriod);

        var window = TimeSpan.FromMinutes((double)Math.Max(0, confirmWithin) * Math.Max(1, context.TimeframeMinutes));

        // One specific absolute strike's own up/down cross times, computed once per strike
        // encountered and reused - ATM only actually changes every so often, not every bar, so most
        // candidate crossovers reuse an already-computed entry rather than re-walking that leg's
        // whole series again.
        var ceCrossCache = new Dictionary<decimal, (List<DateTimeOffset> Up, List<DateTimeOffset> Down)>();
        var peCrossCache = new Dictionary<decimal, (List<DateTimeOffset> Up, List<DateTimeOffset> Down)>();

        (List<DateTimeOffset> Up, List<DateTimeOffset> Down) CrossTimesFor(decimal strike, bool isCall)
        {
            var cache = isCall ? ceCrossCache : peCrossCache;
            if (cache.TryGetValue(strike, out var cached)) return cached;

            var optionBars = context.GetOptionBars(strike, isCall);
            var result = (CrossTimes(optionBars, fastPeriod, slowPeriod, wantBullish: true), CrossTimes(optionBars, fastPeriod, slowPeriod, wantBullish: false));
            cache[strike] = result;
            return result;
        }

        DateOnly? currentDay = null;

        for (var i = 1; i < bars.Count; i++)
        {
            var bar = bars[i];

            // Nothing carries overnight - an opening gap can flip the EMA relationship between the
            // last bar of one session and the first of the next with no trade in between.
            var day = BacktestUtil.IstDate(bar.Time);
            var isFirstBarOfDay = currentDay != day;
            currentDay = day;
            if (isFirstBarOfDay) continue;

            if (!EmaCrossAtmFlowStrategy.CrossedUp(spotFast, spotSlow, i, out var bullish)) continue;
            if (bullish ? !takeLongs : !takeShorts)
            {
                signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Rejected", bullish ? "Bullish" : "Bearish",
                    $"Spot {fastPeriod}/{slowPeriod} EMA crossed {(bullish ? "up" : "down")} - skipped, {(bullish ? "shorts" : "longs")} only"));
                continue;
            }

            var summary = $"Spot {fastPeriod}/{slowPeriod} EMA crossed {(bullish ? "up" : "down")}";

            if (signalStartMinutes > 0 && IstClock.MinutesOfDay(bar.Time) < signalStartMinutes)
            {
                signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Rejected", bullish ? "Bullish" : "Bearish",
                    $"{summary} - skipped, before {IstClock.FormatMinutesOfDay(signalStartMinutes)} IST (pre-open)"));
                continue;
            }

            // Pure ATM as of THIS bar - independent of otmSteps, which only decides the strike the
            // trade itself is taken at (see this class's own doc comment).
            var atmStrike = Math.Round(bar.Close / step) * step;
            var sameLegName = bullish ? "CE" : "PE";
            var oppositeLegName = bullish ? "PE" : "CE";

            // Confirmation 2: the leg matching the call (CE for bullish, PE for bearish) made the
            // SAME upward cross recently enough to count.
            var (sameUp, _) = CrossTimesFor(atmStrike, bullish);
            if (!EmaCrossAtmFlowStrategy.CrossedWithin(sameUp, bar.Time, window))
            {
                signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Rejected", bullish ? "Bullish" : "Bearish",
                    $"{summary} - but ATM {sameLegName} ({atmStrike:0.##}) made no {fastPeriod}/{slowPeriod} cross of its own within {confirmWithin} bar(s)"));
                continue;
            }

            // Confirmation 3 (optional): the OPPOSITE leg crossed DOWN in the same window.
            if (requireOppositeLeg)
            {
                var (_, oppositeDown) = CrossTimesFor(atmStrike, !bullish);
                if (!EmaCrossAtmFlowStrategy.CrossedWithin(oppositeDown, bar.Time, window))
                {
                    signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Rejected", bullish ? "Bullish" : "Bearish",
                        $"{summary}, ATM {sameLegName} confirmed - but ATM {oppositeLegName} made no opposite {fastPeriod}/{slowPeriod} cross within {confirmWithin} bar(s)"));
                    continue;
                }
            }

            var full = requireOppositeLeg
                ? $"{summary}, ATM {sameLegName} crossed up with it, and ATM {oppositeLegName} crossed down - both legs agree"
                : $"{summary}, ATM {sameLegName} crossed up with it";
            signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Entry", bullish ? "Bullish" : "Bearish", full));
            entries.Add((bar.Time, bullish ? "Bullish" : "Bearish"));
        }

        return (entries, signals);
    }

    /// <summary>Every time bars' own fast EMA crossed its slow EMA in the WANTED direction (up when
    /// wantBullish, down otherwise) - the same per-bar rule EmaCrossAtmFlowStrategy.CrossedUp
    /// already implements, generalized to either direction instead of only up, since this strategy
    /// needs both (the same leg's own up-cross, the opposite leg's own down-cross).</summary>
    internal static List<DateTimeOffset> CrossTimes(IReadOnlyList<Candle> bars, int fastPeriod, int slowPeriod, bool wantBullish)
    {
        var times = new List<DateTimeOffset>();
        if (bars.Count == 0) return times;

        var fast = EmaCrossoverDetector.EmaSeries(bars, fastPeriod);
        var slow = EmaCrossoverDetector.EmaSeries(bars, slowPeriod);

        DateOnly? currentDay = null;
        for (var i = 1; i < bars.Count; i++)
        {
            var day = BacktestUtil.IstDate(bars[i].Time);
            var isFirstBarOfDay = currentDay != day;
            currentDay = day;
            if (isFirstBarOfDay) continue; // same overnight-gap rule spot uses

            if (EmaCrossAtmFlowStrategy.CrossedUp(fast, slow, i, out var bullish) && bullish == wantBullish) times.Add(bars[i].Time);
        }

        return times;
    }
}
