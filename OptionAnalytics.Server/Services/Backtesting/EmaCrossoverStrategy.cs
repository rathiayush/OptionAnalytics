using OptionAnalytics.Server.Models;
using OptionAnalytics.Server.Services;

namespace OptionAnalytics.Server.Services.Backtesting;

/// <summary>
/// A classic fast/slow EMA crossover (9/21 by default, both tunable), applied to the underlying's
/// spot bars - distinct from FiveEmaStrategy, which trades a single EMA's alert-candle exhaustion
/// pattern rather than two EMAs crossing.
///
/// Signal: the instant the fast EMA crosses the slow EMA (EmaCrossoverDetector.DirectionSeries,
/// the same fast-vs-slow relationship EmaCrossoverAlertService/ConfluenceAlertService use for their
/// own live alerts, just with tunable periods here instead of the fixed 9/21 those use) - fast
/// above slow is Bullish, fast below slow is Bearish, and a signal fires only the instant that
/// relationship actually CHANGES from the previous bar, not on every bar it continues to hold.
///
/// The slope (trend angle) filter: a bare crossover fires just as readily in a flat, choppy market
/// as a genuine trend - the two EMAs drifting across each other with barely any separation is a
/// classic whipsaw setup. minSlopePercent requires the FAST EMA to actually be moving at the
/// crossover: its percentage change over slopeLookbackBars bars must be at least minSlopePercent in
/// the signal's own direction (rising for a Bullish cross, falling for a Bearish one). Percentage,
/// not raw points or a geometric angle, because a fixed points threshold means something completely
/// different on NIFTY (~24,000) than BANKNIFTY (~52,000), and a true geometric angle needs an
/// arbitrary chart aspect ratio to mean anything at all - percentage slope is the one measure that
/// is directly comparable across instruments and price levels. 0 (the default) disables the filter
/// entirely, taking every crossover regardless of slope.
///
/// Reuses OptionTradeSimulator.Run unchanged (points-based stop-loss/take-profit, one position at a
/// time, EOD exit) - unlike TwoCandleBreakoutStrategy, this strategy's risk is genuinely fixed
/// option-premium points, so it needs no special-cased execution loop and no
/// ILiveOrderPricingStrategy implementation; the existing live-order pipeline already prices it
/// correctly exactly like FiveEmaStrategy.
/// </summary>
public sealed class EmaCrossoverStrategy : IBacktestStrategy
{
    public string Key => "ema-9-21-crossover";
    public string Name => "9/21 EMA Crossover";
    public string Description => "Enters the instant the fast EMA crosses the slow EMA (9/21 by default, both tunable) - fast above slow is Bullish, fast below slow is Bearish. An optional slope filter requires the fast EMA to actually be trending at the crossover (a minimum percentage move over the last few bars) rather than firing on a flat, choppy drift.";

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
        new BacktestParameterSpec("fastPeriod", "Fast EMA (bars)", Default: EmaCrossoverDetector.FastPeriod, Min: 1, Max: 100, Step: 1),
        new BacktestParameterSpec("slowPeriod", "Slow EMA (bars)", Default: EmaCrossoverDetector.SlowPeriod, Min: 2, Max: 200, Step: 1),
        new BacktestParameterSpec("minSlopePercent", "Min fast-EMA slope at crossover, % (0 = off)", Default: 0, Min: 0, Max: 10, Step: 0.05m),
        new BacktestParameterSpec("slopeLookbackBars", "Slope measured over (bars)", Default: 3, Min: 1, Max: 50, Step: 1),
        new BacktestParameterSpec("direction", "Take", Default: DirectionBoth, Min: DirectionBoth, Max: DirectionShortOnly, Step: 1, Options: new[]
        {
            new BacktestParameterOption(DirectionBoth, "Both sides"),
            new BacktestParameterOption(DirectionLongOnly, "Bullish crossovers only (buy CE)"),
            new BacktestParameterOption(DirectionShortOnly, "Bearish crossovers only (buy PE)"),
        }),
    };

    public IReadOnlyList<BacktestTrade> Simulate(BacktestStrategyContext context, IReadOnlyDictionary<string, decimal> parameters) =>
        OptionTradeSimulator.Run(context, Evaluate(context, parameters).Entries, parameters);

    public IReadOnlyList<BacktestSignal> EntrySignals(BacktestStrategyContext context, IReadOnlyDictionary<string, decimal> parameters) =>
        Evaluate(context, parameters).Signals;

    private (List<(DateTimeOffset Time, string Direction)> Entries, List<BacktestSignal> Signals) Evaluate(
        BacktestStrategyContext context, IReadOnlyDictionary<string, decimal> parameters)
    {
        var fastPeriod = (int)parameters["fastPeriod"];
        var slowPeriod = (int)parameters["slowPeriod"];
        var minSlopePercent = parameters["minSlopePercent"];
        var slopeLookback = Math.Max(1, (int)parameters["slopeLookbackBars"]);
        var direction = parameters["direction"];

        var takeLongs = direction != DirectionShortOnly;
        var takeShorts = direction != DirectionLongOnly;

        var entries = new List<(DateTimeOffset Time, string Direction)>();
        var signals = new List<BacktestSignal>();

        var bars = context.SpotBars;
        if (fastPeriod < 1 || slowPeriod < 1 || fastPeriod >= slowPeriod)
            return (entries, signals); // same guard EmaCrossoverDetector itself applies - nothing to detect

        var directionSeries = EmaCrossoverDetector.DirectionSeries(bars, fastPeriod, slowPeriod);
        var fastEma = EmaCrossoverDetector.EmaSeries(bars, fastPeriod);

        string? previousDirection = null;

        for (var i = 0; i < bars.Count; i++)
        {
            var current = directionSeries[i].Direction;
            // A null here means "not enough bars yet" or "an exact tie" - not a real direction, so
            // it neither counts as a crossover nor overwrites what the last real direction was,
            // same tolerance BacktestService.TryUpdateLeg gives its own leg-tracking.
            if (current is null) continue;
            if (current == previousDirection) continue; // holding, not crossing

            var bar = bars[i];
            var isBullish = current == "Bullish";
            var crossLabel = isBullish ? $"fast EMA({fastPeriod}) crossed above slow EMA({slowPeriod})" : $"fast EMA({fastPeriod}) crossed below slow EMA({slowPeriod})";

            var passesSlope = true;
            decimal? slopePercent = null;
            if (minSlopePercent > 0)
            {
                var lookbackIndex = i - slopeLookback;
                if (lookbackIndex < 0 || fastEma[i] is not { } emaNow || fastEma[lookbackIndex] is not { } emaThen || emaThen == 0)
                {
                    passesSlope = false; // not enough history to measure a slope yet - treat as filtered out, never as an unconditional pass
                }
                else
                {
                    slopePercent = (emaNow - emaThen) / Math.Abs(emaThen) * 100;
                    passesSlope = isBullish ? slopePercent >= minSlopePercent : slopePercent <= -minSlopePercent;
                }
            }

            if (!passesSlope)
            {
                var slopeText = slopePercent is { } sp ? $"{sp:0.###}%" : "not enough history yet";
                signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Rejected", current,
                    $"{crossLabel}, but fast-EMA slope ({slopeText}) is under the {minSlopePercent:0.###}% minimum - skipped"));
            }
            else if (isBullish && !takeLongs)
            {
                signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Rejected", current, $"{crossLabel} - skipped, bearish only"));
            }
            else if (!isBullish && !takeShorts)
            {
                signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Rejected", current, $"{crossLabel} - skipped, bullish only"));
            }
            else
            {
                signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Entry", current, crossLabel));
                entries.Add((bar.Time, current));
            }

            previousDirection = current;
        }

        return (entries, signals.OrderByDescending(s => s.TimeUtc).ToList());
    }
}
