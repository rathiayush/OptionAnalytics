using OptionAnalytics.Server.Models;
using Skender.Stock.Indicators;

namespace OptionAnalytics.Server.Services.Backtesting;

/// <summary>
/// Wilder's own recommended ADX/DMI trading rule (from the same 1978 book that introduced the
/// indicator): trade the DI+/DI- crossover itself - DI+ crossing above DI- is Bullish, DI- crossing
/// above DI+ is Bearish - with ADX required to be above a minimum, confirming a real trend actually
/// exists to trade rather than acting on a directional cross inside a flat, directionless chop.
/// Distinct from EmaBandRsiAdxStrategy already in this app: that strategy enters on an EMA BAND
/// BREAKOUT and uses ADX/DMI only as a confirming filter alongside RSI; this one's own entry signal
/// IS the DI crossover, Wilder's own rule taken on its own rather than bolted onto something else.
///
/// Small default stop-loss + wide default take-profit (SmallStopLossParameter/
/// LongRangeTakeProfitParameter): a DI crossover with real ADX strength behind it is exactly the
/// kind of higher-conviction trend-start signal worth risking a small, fixed amount to find out
/// about, while a genuinely extended trend day is bounded by the session's own EOD exit rather than
/// a target set too close to let it pay off.
///
/// Only the crossING (not every bar the same DI stays on top) fires, and nothing carries overnight.
/// </summary>
public sealed class AdxDirectionalCrossoverStrategy : IBacktestStrategy
{
    public string Key => "adx-directional-crossover";
    public string Name => "ADX/DMI Directional Crossover (Wilder)";
    public string Description => "Wilder's own ADX/DMI trading rule: DI+ crossing above DI- is Bullish, DI- crossing above DI+ is Bearish, confirmed by ADX being above a minimum (a real trend, not flat chop). Small stop-loss, wide take-profit by default - cut a false cross loose quickly, give a real trend room to run.";

    private const decimal DirectionBoth = 0;
    private const decimal DirectionLongOnly = 1;
    private const decimal DirectionShortOnly = 2;

    public IReadOnlyList<BacktestParameterSpec> Parameters { get; } = new[]
    {
        OptionTradeSimulator.SideParameter(),
        OptionTradeSimulator.StrikeOffsetParameter(),
        OptionTradeSimulator.SmallStopLossParameter(),
        OptionTradeSimulator.LongRangeTakeProfitParameter(),
        OptionTradeSimulator.SquareOffTimeParameter(),
        OptionTradeSimulator.SignalStartTimeParameter(),
        new BacktestParameterSpec("adxPeriod", "ADX/DMI (bars)", Default: 14, Min: 2, Max: 100, Step: 1),
        new BacktestParameterSpec("adxMinimum", "Minimum ADX - trend strength (0 = off)", Default: 20, Min: 0, Max: 100, Step: 1),
        new BacktestParameterSpec("direction", "Take", Default: DirectionBoth, Min: DirectionBoth, Max: DirectionShortOnly, Step: 1, Options: new[]
        {
            new BacktestParameterOption(DirectionBoth, "Both sides"),
            new BacktestParameterOption(DirectionLongOnly, "DI+ crosses only (buy CE)"),
            new BacktestParameterOption(DirectionShortOnly, "DI- crosses only (buy PE)"),
        }),
    };

    public IReadOnlyList<BacktestTrade> Simulate(BacktestStrategyContext context, IReadOnlyDictionary<string, decimal> parameters) =>
        OptionTradeSimulator.Run(context, Evaluate(context, parameters).Entries, parameters);

    public IReadOnlyList<BacktestSignal> EntrySignals(BacktestStrategyContext context, IReadOnlyDictionary<string, decimal> parameters) =>
        Evaluate(context, parameters).Signals;

    private (List<(DateTimeOffset Time, string Direction)> Entries, List<BacktestSignal> Signals) Evaluate(
        BacktestStrategyContext context, IReadOnlyDictionary<string, decimal> parameters)
    {
        var adxPeriod = (int)parameters["adxPeriod"];
        var adxMinimum = parameters["adxMinimum"];
        var direction = parameters["direction"];
        var signalStartMinutes = (int)parameters.GetValueOrDefault("signalStartMinutes", 555);

        var takeLongs = direction != DirectionShortOnly;
        var takeShorts = direction != DirectionLongOnly;

        var entries = new List<(DateTimeOffset Time, string Direction)>();
        var signals = new List<BacktestSignal>();

        var bars = context.SpotBars;
        if (adxPeriod < 1 || bars.Count == 0) return (entries, signals);

        var quotes = bars.Select(c => new Quote
        {
            Date = c.Time.UtcDateTime,
            Open = c.Open,
            High = c.High,
            Low = c.Low,
            Close = c.Close,
            Volume = 0,
        }).ToList();

        var adx = quotes.GetAdx(adxPeriod).ToList();

        string? previousDirection = null;

        for (var i = 0; i < bars.Count; i++)
        {
            if (adx[i].Pdi is not { } pdi || adx[i].Mdi is not { } mdi) continue;

            var current = pdi > mdi ? "Bullish" : pdi < mdi ? "Bearish" : null;
            if (current is null) continue;
            if (current == previousDirection) { previousDirection = current; continue; } // holding, not crossing

            var bar = bars[i];
            var isBullish = current == "Bullish";
            var adxValue = (decimal?)adx[i].Adx;
            var crossLabel = isBullish
                ? $"DI+ ({pdi:0.##}) crossed above DI- ({mdi:0.##})"
                : $"DI- ({mdi:0.##}) crossed above DI+ ({pdi:0.##})";

            if (signalStartMinutes > 0 && IstClock.MinutesOfDay(bar.Time) < signalStartMinutes)
            {
                signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Rejected", current,
                    $"{crossLabel} - skipped, before {IstClock.FormatMinutesOfDay(signalStartMinutes)} IST (pre-open)"));
            }
            else if (adxValue is null)
            {
                signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Rejected", current, $"{crossLabel} - skipped, not enough bars for ADX yet"));
            }
            else if (adxMinimum > 0 && adxValue < adxMinimum)
            {
                signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Rejected", current, $"{crossLabel}, but ADX ({adxValue:0.##}) is below the minimum {adxMinimum} - skipped"));
            }
            else if (isBullish && !takeLongs)
            {
                signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Rejected", current, $"{crossLabel} - skipped, DI- crosses only"));
            }
            else if (!isBullish && !takeShorts)
            {
                signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Rejected", current, $"{crossLabel} - skipped, DI+ crosses only"));
            }
            else
            {
                signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Entry", current, $"{crossLabel}, ADX {adxValue:0.##}"));
                entries.Add((bar.Time, current));
            }

            previousDirection = current;
        }

        return (entries, signals.OrderByDescending(s => s.TimeUtc).ToList());
    }
}
