using OptionAnalytics.Server.Models;
using Skender.Stock.Indicators;

namespace OptionAnalytics.Server.Services.Backtesting;

/// <summary>
/// Larry Connors' RSI(2) mean-reversion strategy - one of the best-known short-term trading systems
/// to come out of the US quant/retail research world (popularized in "Short Term Trading Strategies
/// That Work"), and a completely different paradigm from every other strategy in this app so far:
/// every one of them trades WITH a fresh move (a crossover, a breakout); this one trades AGAINST a
/// short-term extreme, betting on a snap-back rather than continuation.
///
/// Connors' own published rule pairs the very-short RSI(2) reading with a LONGER-term trend filter
/// so the strategy only buys dips within an uptrend and sells rallies within a downtrend, rather
/// than picking bottoms/tops in a market that is simply falling/rising hard - trading purely against
/// RSI(2) with no trend filter at all is a well-known way to keep buying a falling knife. That
/// filter (Close vs a longer SMA, TrendPeriod - 200 in Connors' own daily version) is ON by default
/// here too, adapted to whatever timeframe this runs at rather than only the daily bars the original
/// research used.
///
///   BULLISH: RSI(2) crosses AT OR BELOW OversoldBelow (10 by default - deeply oversold even by
///            RSI(2)'s own already-extreme scale), AND (if the trend filter is on) Close is above
///            the TrendPeriod SMA.
///   BEARISH: the mirror - RSI(2) crosses AT OR ABOVE OverboughtAbove (90), AND Close is below the
///            TrendPeriod SMA.
///
/// Only the crossING (a fresh move past the threshold) fires, not every bar RSI(2) continues to sit
/// beyond it - RSI(2) is jumpy enough that a real extreme can span several bars, and this should
/// read as one setup, not one signal per bar, same "state holds until it clears" rule this app's
/// other extreme-reading strategies (EmaBandRsiAdxStrategy's band, BollingerBandsStrategy's band)
/// already use.
/// </summary>
public sealed class Rsi2MeanReversionStrategy : IBacktestStrategy
{
    public string Key => "rsi2-mean-reversion";
    public string Name => "RSI(2) Mean Reversion (Connors)";
    public string Description => "Larry Connors' RSI(2) pullback system: buys a deeply oversold RSI(2) reading (10 or below by default) while price still sits above its longer-term trend average, sells a deeply overbought one (90+) while below it - betting on a short-term snap-back, not a continuation. The trend filter can be turned off to trade RSI(2) extremes on their own.";

    private const decimal DirectionBoth = 0;
    private const decimal DirectionLongOnly = 1;
    private const decimal DirectionShortOnly = 2;

    private const decimal FlagOff = 0;
    private const decimal FlagOn = 1;

    public IReadOnlyList<BacktestParameterSpec> Parameters { get; } = new[]
    {
        OptionTradeSimulator.SideParameter(),
        OptionTradeSimulator.StrikeOffsetParameter(),
        OptionTradeSimulator.StopLossParameter(),
        OptionTradeSimulator.TakeProfitParameter(),
        OptionTradeSimulator.SquareOffTimeParameter(),
        OptionTradeSimulator.SignalStartTimeParameter(),
        new BacktestParameterSpec("rsiPeriod", "RSI period (bars)", Default: 2, Min: 1, Max: 50, Step: 1),
        new BacktestParameterSpec("oversoldBelow", "Bullish when RSI at/below", Default: 10, Min: 0, Max: 50, Step: 1),
        new BacktestParameterSpec("overboughtAbove", "Bearish when RSI at/above", Default: 90, Min: 50, Max: 100, Step: 1),
        new BacktestParameterSpec("useTrendFilter", "Require price to already be trending that way", Default: FlagOn, Min: FlagOff, Max: FlagOn, Step: 1, Options: new[]
        {
            new BacktestParameterOption(FlagOff, "No - trade RSI(2) extremes alone"),
            new BacktestParameterOption(FlagOn, "Yes - Connors' own trend filter"),
        }),
        new BacktestParameterSpec("trendPeriod", "Trend SMA (bars, only used when the above is Yes)", Default: 200, Min: 5, Max: 400, Step: 1),
        new BacktestParameterSpec("direction", "Take", Default: DirectionBoth, Min: DirectionBoth, Max: DirectionShortOnly, Step: 1, Options: new[]
        {
            new BacktestParameterOption(DirectionBoth, "Both sides"),
            new BacktestParameterOption(DirectionLongOnly, "Oversold bounces only (buy CE)"),
            new BacktestParameterOption(DirectionShortOnly, "Overbought pullbacks only (buy PE)"),
        }),
    };

    public IReadOnlyList<BacktestTrade> Simulate(BacktestStrategyContext context, IReadOnlyDictionary<string, decimal> parameters) =>
        OptionTradeSimulator.Run(context, Evaluate(context, parameters).Entries, parameters);

    public IReadOnlyList<BacktestSignal> EntrySignals(BacktestStrategyContext context, IReadOnlyDictionary<string, decimal> parameters) =>
        Evaluate(context, parameters).Signals;

    private (List<(DateTimeOffset Time, string Direction)> Entries, List<BacktestSignal> Signals) Evaluate(
        BacktestStrategyContext context, IReadOnlyDictionary<string, decimal> parameters)
    {
        var rsiPeriod = (int)parameters["rsiPeriod"];
        var oversoldBelow = parameters["oversoldBelow"];
        var overboughtAbove = parameters["overboughtAbove"];
        var useTrendFilter = parameters.GetValueOrDefault("useTrendFilter", FlagOn) >= (FlagOff + FlagOn) / 2;
        var trendPeriod = (int)parameters.GetValueOrDefault("trendPeriod", 200);
        var direction = parameters["direction"];
        var signalStartMinutes = (int)parameters.GetValueOrDefault("signalStartMinutes", 555);

        var takeLongs = direction != DirectionShortOnly;
        var takeShorts = direction != DirectionLongOnly;

        var entries = new List<(DateTimeOffset Time, string Direction)>();
        var signals = new List<BacktestSignal>();

        var bars = context.SpotBars;
        if (rsiPeriod < 1 || bars.Count == 0) return (entries, signals);

        var quotes = bars.Select(c => new Quote
        {
            Date = c.Time.UtcDateTime,
            Open = c.Open,
            High = c.High,
            Low = c.Low,
            Close = c.Close,
            Volume = 0,
        }).ToList();

        var rsi = quotes.GetRsi(rsiPeriod).ToList();
        var trendSma = useTrendFilter ? quotes.GetSma(trendPeriod).ToList() : null;

        string? extremeState = null;

        for (var i = 0; i < bars.Count; i++)
        {
            if (rsi[i].Rsi is not { } rsiValue) continue;

            string? rawExtreme = rsiValue <= (double)oversoldBelow ? "Oversold" : rsiValue >= (double)overboughtAbove ? "Overbought" : null;
            var isFreshExtreme = rawExtreme is not null && rawExtreme != extremeState;
            extremeState = rawExtreme;
            if (!isFreshExtreme) continue;

            var bar = bars[i];
            var current = rawExtreme == "Oversold" ? "Bullish" : "Bearish";
            var isBullish = current == "Bullish";
            var summary = isBullish
                ? $"RSI({rsiPeriod}) fell to {rsiValue:0.##}, at/below the oversold threshold {oversoldBelow:0.##}"
                : $"RSI({rsiPeriod}) rose to {rsiValue:0.##}, at/above the overbought threshold {overboughtAbove:0.##}";

            var passesTrend = true;
            string? trendRejectReason = null;
            if (useTrendFilter)
            {
                if (trendSma![i].Sma is not { } trend)
                {
                    passesTrend = false;
                    trendRejectReason = $"not enough bars for the {trendPeriod}-SMA trend filter yet";
                }
                else if (isBullish && bar.Close <= (decimal)trend)
                {
                    passesTrend = false;
                    trendRejectReason = $"price ({bar.Close:0.##}) is not above the {trendPeriod}-SMA trend filter ({trend:0.##})";
                }
                else if (!isBullish && bar.Close >= (decimal)trend)
                {
                    passesTrend = false;
                    trendRejectReason = $"price ({bar.Close:0.##}) is not below the {trendPeriod}-SMA trend filter ({trend:0.##})";
                }
            }

            if (signalStartMinutes > 0 && IstClock.MinutesOfDay(bar.Time) < signalStartMinutes)
            {
                signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Rejected", current,
                    $"{summary} - skipped, before {IstClock.FormatMinutesOfDay(signalStartMinutes)} IST (pre-open)"));
            }
            else if (!passesTrend)
            {
                signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Rejected", current, $"{summary}, but {trendRejectReason} - skipped"));
            }
            else if (isBullish && !takeLongs)
            {
                signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Rejected", current, $"{summary} - skipped, overbought pullbacks only"));
            }
            else if (!isBullish && !takeShorts)
            {
                signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Rejected", current, $"{summary} - skipped, oversold bounces only"));
            }
            else
            {
                signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Entry", current, summary));
                entries.Add((bar.Time, current));
            }
        }

        return (entries, signals.OrderByDescending(s => s.TimeUtc).ToList());
    }
}
