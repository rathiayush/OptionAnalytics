using OptionAnalytics.Server.Models;
using Skender.Stock.Indicators;

namespace OptionAnalytics.Server.Services.Backtesting;

/// <summary>
/// The "Golden Cross" / "Death Cross" - almost certainly the single most widely cited technical
/// signal in financial media worldwide (US equity indices especially: a 50-day/200-day SMA cross is
/// front-page news whenever it happens on the S&amp;P 500). Distinct from EmaCrossoverStrategy in
/// both flavor and intent: this uses SIMPLE moving averages (the original, still-standard
/// definition) at the specific 50/200 periods that give the pattern its name, rather than an
/// exponential average at a fast intraday period - a genuinely different, much slower-reacting
/// trend-following signal, not just the same idea with different numbers.
///
/// Signal: the instant the fast SMA crosses the slow SMA - fast above slow is Bullish (Golden
/// Cross), fast below slow is Bearish (Death Cross) - firing only the instant that relationship
/// actually CHANGES, not on every bar it continues to hold, same convention every crossover
/// strategy in this app already follows.
///
/// Both periods are tunable (so this can be run at whatever bar-count "50/200" ought to mean for a
/// given timeframe), but default to the famous 50/200 pair rather than this app's usual fast
/// intraday defaults - changing them stops this being a Golden Cross in anything but name, so the
/// defaults matter here more than for most strategies.
///
/// Reuses OptionTradeSimulator.Run unchanged, exactly like every other spot-crossover strategy here.
/// </summary>
public sealed class GoldenCrossStrategy : IBacktestStrategy
{
    public string Key => "golden-cross";
    public string Name => "Golden Cross / Death Cross (SMA 50/200)";
    public string Description => "The classic Golden Cross / Death Cross: enters the instant the fast simple moving average (50 by default) crosses the slow one (200) - fast above slow is Bullish (Golden Cross), fast below slow is Bearish (Death Cross). Both periods are tunable, but default to the pair that gives the pattern its name.";

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
        new BacktestParameterSpec("fastPeriod", "Fast SMA (bars)", Default: 50, Min: 2, Max: 300, Step: 1),
        new BacktestParameterSpec("slowPeriod", "Slow SMA (bars)", Default: 200, Min: 3, Max: 400, Step: 1),
        new BacktestParameterSpec("direction", "Take", Default: DirectionBoth, Min: DirectionBoth, Max: DirectionShortOnly, Step: 1, Options: new[]
        {
            new BacktestParameterOption(DirectionBoth, "Both sides"),
            new BacktestParameterOption(DirectionLongOnly, "Golden Cross only (buy CE)"),
            new BacktestParameterOption(DirectionShortOnly, "Death Cross only (buy PE)"),
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
        var direction = parameters["direction"];
        var signalStartMinutes = (int)parameters.GetValueOrDefault("signalStartMinutes", 555);

        var takeLongs = direction != DirectionShortOnly;
        var takeShorts = direction != DirectionLongOnly;

        var entries = new List<(DateTimeOffset Time, string Direction)>();
        var signals = new List<BacktestSignal>();

        var bars = context.SpotBars;
        if (fastPeriod < 1 || slowPeriod < 1 || fastPeriod >= slowPeriod || bars.Count == 0)
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

        var fastSma = quotes.GetSma(fastPeriod).ToList();
        var slowSma = quotes.GetSma(slowPeriod).ToList();

        string? previousDirection = null;

        for (var i = 0; i < bars.Count; i++)
        {
            if (fastSma[i].Sma is not { } fast || slowSma[i].Sma is not { } slow) continue;

            var current = fast > slow ? "Bullish" : fast < slow ? "Bearish" : null;
            // An exact tie is not a real direction - same tolerance every other crossover in this
            // app gives one, rather than either overwriting the last real direction or firing here.
            if (current is null) continue;
            if (current == previousDirection) { previousDirection = current; continue; } // holding, not crossing

            var bar = bars[i];
            var isBullish = current == "Bullish";
            var crossLabel = isBullish
                ? $"Golden Cross - {fastPeriod} SMA ({fast:0.##}) crossed above {slowPeriod} SMA ({slow:0.##})"
                : $"Death Cross - {fastPeriod} SMA ({fast:0.##}) crossed below {slowPeriod} SMA ({slow:0.##})";

            if (signalStartMinutes > 0 && IstClock.MinutesOfDay(bar.Time) < signalStartMinutes)
            {
                signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Rejected", current,
                    $"{crossLabel} - skipped, before {IstClock.FormatMinutesOfDay(signalStartMinutes)} IST (pre-open)"));
            }
            else if (isBullish && !takeLongs)
            {
                signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Rejected", current, $"{crossLabel} - skipped, Death Cross only"));
            }
            else if (!isBullish && !takeShorts)
            {
                signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Rejected", current, $"{crossLabel} - skipped, Golden Cross only"));
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
