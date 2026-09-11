using OptionAnalytics.Server.Models;
using Skender.Stock.Indicators;

namespace OptionAnalytics.Server.Services.Backtesting;

/// <summary>
/// John Bollinger's Bollinger Bands - a middle SMA (20 by default, Bollinger's own standard) with
/// upper/lower bands a fixed number of standard deviations away (2, also Bollinger's own default),
/// so the bands automatically widen in choppy markets and narrow in quiet ones instead of sitting at
/// a fixed distance the way EmaBandRsiAdxStrategy's percentage envelope does.
///
/// Two OPPOSITE, both famous, ways to trade a band touch - Mode picks which:
///
///   Reversion (default, the classic "Bollinger Bounce"): a close AT OR BEYOND a band is read as
///   overextended and due to revert back toward the middle band - closing at/below the LOWER band
///   is Bullish (bet on a bounce up), at/above the UPPER band is Bearish (bet on a pullback down).
///   This is the traditional retail use of the bands and the one most commonly meant by "trading
///   Bollinger Bands".
///
///   Breakout (the other classic reading, and the one EmaBandRsiAdxStrategy's own envelope already
///   uses): a close beyond a band is read as a genuine expansion move, not exhaustion - closing
///   above the UPPER band is Bullish (ride the breakout), below the LOWER band is Bearish. Bollinger
///   himself has written about both readings being valid depending on market regime, which is why
///   this is a mode rather than two separate strategies pretending to disagree about "the" right
///   way to use the indicator.
///
/// Only a FRESH touch (a transition into a band from inside it, or from the opposite band) is a new
/// signal - a run of bars all still beyond the same band is the same event continuing, not one
/// signal per bar, the same "state holds until price returns inside" rule EmaBandRsiAdxStrategy's
/// own band uses. Nothing carries overnight.
/// </summary>
public sealed class BollingerBandsStrategy : IBacktestStrategy
{
    public string Key => "bollinger-bands";
    public string Name => "Bollinger Bands";
    public string Description => "John Bollinger's bands: a 20-bar SMA (tunable) with upper/lower bands 2 standard deviations away (tunable). Reversion mode (the classic 'Bollinger Bounce', default) bets on a pullback the instant price closes beyond a band; Breakout mode bets on the move continuing instead. Only a fresh touch fires, not every bar still beyond the band.";

    private const decimal DirectionBoth = 0;
    private const decimal DirectionLongOnly = 1;
    private const decimal DirectionShortOnly = 2;

    private const decimal ModeReversion = 0;
    private const decimal ModeBreakout = 1;

    public IReadOnlyList<BacktestParameterSpec> Parameters { get; } = new[]
    {
        OptionTradeSimulator.SideParameter(),
        OptionTradeSimulator.StrikeOffsetParameter(),
        OptionTradeSimulator.StopLossParameter(),
        OptionTradeSimulator.TakeProfitParameter(),
        OptionTradeSimulator.SquareOffTimeParameter(),
        OptionTradeSimulator.SignalStartTimeParameter(),
        new BacktestParameterSpec("period", "SMA period (bars)", Default: 20, Min: 2, Max: 200, Step: 1),
        new BacktestParameterSpec("stdDev", "Band width (standard deviations)", Default: 2, Min: 0.5m, Max: 5, Step: 0.1m),
        new BacktestParameterSpec("mode", "Trade a band touch as", Default: ModeReversion, Min: ModeReversion, Max: ModeBreakout, Step: 1, Options: new[]
        {
            new BacktestParameterOption(ModeReversion, "Reversion - bet on a pullback (classic bounce)"),
            new BacktestParameterOption(ModeBreakout, "Breakout - bet on the move continuing"),
        }),
        new BacktestParameterSpec("direction", "Take", Default: DirectionBoth, Min: DirectionBoth, Max: DirectionShortOnly, Step: 1, Options: new[]
        {
            new BacktestParameterOption(DirectionBoth, "Both sides"),
            new BacktestParameterOption(DirectionLongOnly, "Bullish only (buy CE)"),
            new BacktestParameterOption(DirectionShortOnly, "Bearish only (buy PE)"),
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
        var stdDev = (double)parameters["stdDev"];
        var isBreakout = parameters.GetValueOrDefault("mode", ModeReversion) >= (ModeReversion + ModeBreakout) / 2;
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

        var bands = quotes.GetBollingerBands(period, stdDev).ToList();

        string? bandState = null;
        DateOnly? currentDay = null;

        for (var i = 0; i < bars.Count; i++)
        {
            var bar = bars[i];

            // Nothing carries overnight - yesterday's band level says nothing about where today's
            // price should sit relative to a freshly-continuing average, same rule
            // EmaBandRsiAdxStrategy's own band state uses.
            var day = BacktestUtil.IstDate(bar.Time);
            if (currentDay != day)
            {
                currentDay = day;
                bandState = null;
            }

            if (bands[i].UpperBand is not { } upper || bands[i].LowerBand is not { } lower) continue;

            // A window with exactly zero variance (every bar in it printed the identical price)
            // collapses both bands onto that price - "touching the band" is meaningless there since
            // upper, lower, and every close in the window are all the same number, not a real
            // overextension. Only ever arises on a dead-flat synthetic/illiquid opening; genuine
            // price noise never lands on it.
            if (upper <= lower) continue;

            var touchedUpper = bar.Close >= (decimal)upper;
            var touchedLower = bar.Close <= (decimal)lower;
            string? rawTouch = touchedUpper ? "Upper" : touchedLower ? "Lower" : null;

            var isFreshTouch = rawTouch is not null && rawTouch != bandState;
            bandState = rawTouch;
            if (!isFreshTouch) continue;

            // Reversion bets AGAINST the touched band (upper touch -> expect a pullback -> Bearish);
            // Breakout bets WITH it (upper touch -> expect continuation -> Bullish).
            var upperMeans = isBreakout ? "Bullish" : "Bearish";
            var lowerMeans = isBreakout ? "Bearish" : "Bullish";
            var current = rawTouch == "Upper" ? upperMeans : lowerMeans;
            var modeLabel = isBreakout ? "breakout" : "reversion";
            var bandLabel = rawTouch == "Upper" ? "upper" : "lower";
            var bandValue = rawTouch == "Upper" ? upper : lower;
            var summary = $"Close ({bar.Close:0.##}) touched the {period}-SMA {bandLabel} Bollinger Band ({bandValue:0.##}) - {modeLabel} read";

            var isBullish = current == "Bullish";

            if (signalStartMinutes > 0 && IstClock.MinutesOfDay(bar.Time) < signalStartMinutes)
            {
                signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Rejected", current,
                    $"{summary} - skipped, before {IstClock.FormatMinutesOfDay(signalStartMinutes)} IST (pre-open)"));
            }
            else if (isBullish && !takeLongs)
            {
                signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Rejected", current, $"{summary} - skipped, bearish only"));
            }
            else if (!isBullish && !takeShorts)
            {
                signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Rejected", current, $"{summary} - skipped, bullish only"));
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
