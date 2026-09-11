using OptionAnalytics.Server.Models;
using Skender.Stock.Indicators;

namespace OptionAnalytics.Server.Services.Backtesting;

/// <summary>
/// Tushar Chande's VMA (Variable Moving Average, from the same "The New Technical Trader" book that
/// introduced CMO and Aroon) - an EMA whose smoothing constant adapts to how volatile the market
/// currently is, rather than staying fixed like a plain EMA/SMA: it hugs price closely and reacts
/// fast during a real trending move (high |CMO|), and flattens out to resist whipsaw during a quiet,
/// directionless one (low |CMO|). Not to be confused with a Volume-weighted Moving Average (also
/// sometimes abbreviated VMA) - this app's spot candles carry no volume at all
/// (BacktestStrategyContext.SpotBars is plain OHLC), so a volume-weighted line has nothing real to
/// weight by here; Chande's volatility-adaptive VMA needs only price and fits this app's data
/// exactly as EmaCrossoverStrategy's plain EMA does.
///
/// VMA[i] = VMA[i-1] + SC * VI * (Close[i] - VMA[i-1]), where VI = |CMO(period)| / 100 (0 when the
/// market is perfectly flat, up to 1 at CMO's own extremes) and SC = 2 / (period + 1) is the same
/// smoothing constant a plain EMA of that period would use - VMA IS that EMA, just damped by how
/// weak the current trend is.
///
/// Signal: the instant Close crosses the VMA line - above is Bullish, below is Bearish - firing only
/// on the change, not every bar the same side continues to hold, same convention every other
/// crossover strategy in this app already follows.
///
/// Small default stop-loss + wide default take-profit (SmallStopLossParameter/
/// LongRangeTakeProfitParameter), same trend-following reasoning as this app's other adaptive-line
/// strategies (Supertrend, Parabolic SAR): a cross this indicator is specifically built to be quiet
/// about is worth risking a small, fixed amount to find out about, while a genuinely extended trend
/// day is bounded by the session's own EOD exit rather than a target set too close to let it pay off.
/// </summary>
public sealed class VmaStrategy : IBacktestStrategy
{
    public string Key => "vma-crossover";
    public string Name => "VMA (Chande's Variable Moving Average)";
    public string Description => "Tushar Chande's volatility-adaptive moving average - an EMA that speeds up in a real trend and flattens out in a quiet chop (via the Chande Momentum Oscillator). Enters the instant price crosses the VMA line. Small stop-loss, wide take-profit by default - cut a false cross loose quickly, give a real trend room to run.";

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
        new BacktestParameterSpec("period", "VMA period (bars)", Default: 9, Min: 2, Max: 200, Step: 1),
        new BacktestParameterSpec("direction", "Take", Default: DirectionBoth, Min: DirectionBoth, Max: DirectionShortOnly, Step: 1, Options: new[]
        {
            new BacktestParameterOption(DirectionBoth, "Both sides"),
            new BacktestParameterOption(DirectionLongOnly, "Bullish crosses only (buy CE)"),
            new BacktestParameterOption(DirectionShortOnly, "Bearish crosses only (buy PE)"),
        }),
    };

    public IReadOnlyList<BacktestTrade> Simulate(BacktestStrategyContext context, IReadOnlyDictionary<string, decimal> parameters) =>
        OptionTradeSimulator.Run(context, Evaluate(context, parameters).Entries, parameters);

    public IReadOnlyList<BacktestSignal> EntrySignals(BacktestStrategyContext context, IReadOnlyDictionary<string, decimal> parameters) =>
        Evaluate(context, parameters).Signals;

    private (List<(DateTimeOffset Time, string Direction)> Entries, List<BacktestSignal> Signals) Evaluate(
        BacktestStrategyContext context, IReadOnlyDictionary<string, decimal> parameters)
    {
        var period = (int)parameters["period"];
        var direction = parameters["direction"];
        var signalStartMinutes = (int)parameters.GetValueOrDefault("signalStartMinutes", 555);

        var takeLongs = direction != DirectionShortOnly;
        var takeShorts = direction != DirectionLongOnly;

        var entries = new List<(DateTimeOffset Time, string Direction)>();
        var signals = new List<BacktestSignal>();

        var bars = context.SpotBars;
        if (period < 1 || bars.Count == 0) return (entries, signals);

        var quotes = bars.Select(c => new Quote
        {
            Date = c.Time.UtcDateTime,
            Open = c.Open,
            High = c.High,
            Low = c.Low,
            Close = c.Close,
            Volume = 0,
        }).ToList();

        var vmaSeries = ComputeVma(quotes, bars, period);

        string? previousDirection = null;

        for (var i = 0; i < bars.Count; i++)
        {
            if (vmaSeries[i] is not { } vma) continue;

            var bar = bars[i];
            var current = bar.Close > vma ? "Bullish" : bar.Close < vma ? "Bearish" : null;
            if (current is null) continue;
            if (current == previousDirection) { previousDirection = current; continue; } // holding, not crossing

            var isBullish = current == "Bullish";
            var crossLabel = isBullish
                ? $"Close ({bar.Close:0.##}) crossed above VMA({period}) ({vma:0.##})"
                : $"Close ({bar.Close:0.##}) crossed below VMA({period}) ({vma:0.##})";

            if (signalStartMinutes > 0 && IstClock.MinutesOfDay(bar.Time) < signalStartMinutes)
            {
                signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Rejected", current,
                    $"{crossLabel} - skipped, before {IstClock.FormatMinutesOfDay(signalStartMinutes)} IST (pre-open)"));
            }
            else if (isBullish && !takeLongs)
            {
                signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Rejected", current, $"{crossLabel} - skipped, bearish crosses only"));
            }
            else if (!isBullish && !takeShorts)
            {
                signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Rejected", current, $"{crossLabel} - skipped, bullish crosses only"));
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

    /// <summary>VMA[i] = VMA[i-1] + SC * VI * (Close[i] - VMA[i-1]) - Chande's own recurrence, seeded
    /// at the first bar CMO has a value for (VMA has nothing to recur from before then). SC = 2/
    /// (period+1) is the same constant a plain EMA of this period uses; VI = |CMO(period)|/100 is
    /// what makes it adaptive - 0 damps the update to nothing in a flat market, 1 (CMO at its own
    /// extreme) lets it move exactly as fast as a plain EMA would.</summary>
    private static decimal?[] ComputeVma(List<Quote> quotes, IReadOnlyList<Candle> bars, int period)
    {
        var cmo = quotes.GetCmo(period).ToList();
        var smoothingConstant = 2m / (period + 1);
        var result = new decimal?[bars.Count];
        decimal? vma = null;

        for (var i = 0; i < bars.Count; i++)
        {
            if (cmo[i].Cmo is not { } cmoValue) continue;

            if (vma is null)
            {
                vma = bars[i].Close; // nothing to recur from yet - seed at this bar's own close
            }
            else
            {
                var volatilityIndex = Math.Abs((decimal)cmoValue) / 100m;
                vma += smoothingConstant * volatilityIndex * (bars[i].Close - vma.Value);
            }

            result[i] = vma;
        }

        return result;
    }
}
