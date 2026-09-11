using OptionAnalytics.Server.Models;
using Skender.Stock.Indicators;

namespace OptionAnalytics.Server.Services.Backtesting;

/// <summary>
/// Gerald Appel's MACD (Moving Average Convergence/Divergence) - one of the most widely used
/// momentum indicators in the world, in the same "12, 26, 9" default form popularized since the
/// late 1970s and still the out-of-the-box setting on essentially every charting platform.
///
/// Signal: the MACD line (fast EMA minus slow EMA) crossing its own Signal line (an EMA of the MACD
/// line itself) - MACD above Signal is Bullish, MACD below Signal is Bearish, firing only the
/// instant that relationship changes, not on every bar it continues to hold. This is the classic
/// "MACD crossover" reading - distinct from EmaCrossoverStrategy's fast/slow PRICE-EMA cross, since
/// MACD crosses are a cross of two lines DERIVED from price (a difference-of-EMAs and an EMA of
/// that difference), one level of smoothing removed from the raw price series and reacting to
/// momentum shifts rather than the price average itself.
///
/// An optional histogram-strength filter (off by default) requires the MACD histogram (MACD minus
/// Signal - the crossover's own margin) to already be at least MinHistogram in the signal's
/// direction, screening out a cross so shallow the two lines are practically touching - the same
/// "require actual separation, not just a technical cross" idea EmaCrossoverStrategy's slope filter
/// and EmaBandRsiAdxStrategy's ADX minimum both apply to their own indicators.
/// </summary>
public sealed class MacdCrossoverStrategy : IBacktestStrategy
{
    public string Key => "macd-crossover";
    public string Name => "MACD Signal Line Crossover";
    public string Description => "Gerald Appel's MACD in its classic 12/26/9 form: enters the instant the MACD line crosses its own Signal line - MACD above Signal is Bullish, below is Bearish. An optional filter requires the crossover's own histogram to already show real separation, not just a technical touch.";

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
        new BacktestParameterSpec("fastPeriod", "Fast EMA (bars)", Default: 12, Min: 1, Max: 100, Step: 1),
        new BacktestParameterSpec("slowPeriod", "Slow EMA (bars)", Default: 26, Min: 2, Max: 200, Step: 1),
        new BacktestParameterSpec("signalPeriod", "Signal EMA (bars)", Default: 9, Min: 1, Max: 100, Step: 1),
        new BacktestParameterSpec("minHistogram", "Min histogram at crossover, points (0 = off)", Default: 0, Min: 0, Max: 500, Step: 0.5m),
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
        var signalPeriod = (int)parameters["signalPeriod"];
        var minHistogram = parameters.GetValueOrDefault("minHistogram", 0);
        var direction = parameters["direction"];
        var signalStartMinutes = (int)parameters.GetValueOrDefault("signalStartMinutes", 555);

        var takeLongs = direction != DirectionShortOnly;
        var takeShorts = direction != DirectionLongOnly;

        var entries = new List<(DateTimeOffset Time, string Direction)>();
        var signals = new List<BacktestSignal>();

        var bars = context.SpotBars;
        if (fastPeriod < 1 || slowPeriod < 1 || signalPeriod < 1 || fastPeriod >= slowPeriod || bars.Count == 0)
            return (entries, signals);

        var quotes = bars.Select(c => new Quote
        {
            Date = c.Time.UtcDateTime,
            Open = c.Open,
            High = c.High,
            Low = c.Low,
            Close = c.Close,
            Volume = 0,
        }).ToList();

        var macd = quotes.GetMacd(fastPeriod, slowPeriod, signalPeriod).ToList();

        string? previousDirection = null;

        for (var i = 0; i < bars.Count; i++)
        {
            if (macd[i].Macd is not { } macdLine || macd[i].Signal is not { } signalLine) continue;

            var current = macdLine > signalLine ? "Bullish" : macdLine < signalLine ? "Bearish" : null;
            if (current is null) continue;
            if (current == previousDirection) { previousDirection = current; continue; } // holding, not crossing

            var bar = bars[i];
            var isBullish = current == "Bullish";
            var histogram = (decimal)(macdLine - signalLine);
            var crossLabel = isBullish
                ? $"MACD ({macdLine:0.##}) crossed above Signal ({signalLine:0.##})"
                : $"MACD ({macdLine:0.##}) crossed below Signal ({signalLine:0.##})";

            var passesHistogram = minHistogram <= 0 || Math.Abs(histogram) >= minHistogram;

            if (signalStartMinutes > 0 && IstClock.MinutesOfDay(bar.Time) < signalStartMinutes)
            {
                signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Rejected", current,
                    $"{crossLabel} - skipped, before {IstClock.FormatMinutesOfDay(signalStartMinutes)} IST (pre-open)"));
            }
            else if (!passesHistogram)
            {
                signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Rejected", current,
                    $"{crossLabel}, but the histogram ({histogram:0.##}) is under the {minHistogram:0.##} minimum - skipped"));
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
