using OptionAnalytics.Server.Models;

namespace OptionAnalytics.Server.Services.Backtesting;

/// <summary>One alert candle that was actually broken - the moment the setup fires. AlertCandle is
/// the exhaustion bar itself (not the bar that broke it), which is what the taught stop-loss is
/// placed against: its High for a short, its Low for a long.</summary>
public sealed record FiveEmaBreak(DateTimeOffset Time, string Direction, Candle AlertCandle);

/// <summary>
/// The Subhasish Pani 5 EMA alert-candle scan, shared by both versions of the strategy so the ONE
/// thing they genuinely agree on - when the setup fires - cannot drift between them. They differ
/// only in what they do afterwards (v1 exits on premium points, v2 on the taught spot-based stop
/// and 1:3 target), which is exactly the split this separation is drawn along.
///
/// The rules, all on the underlying's own bars:
///   - A candle entirely ABOVE the 5 EMA (its LOW does not touch the line) is a SHORT alert candle;
///     entirely BELOW (its HIGH does not touch) is a LONG one.
///   - It fires when a later candle breaks that candle's low (short) or high (long).
///   - It ROLLS FORWARD: while unbroken, any newer candle itself entirely clear of the EMA on the
///     same side replaces it, so the reference is always the most recent exhaustion bar.
///   - Any candle that TOUCHES the EMA cancels both sides outright - price has come back to the
///     average, so the stretched-away condition the setup is built on is gone.
///   - Nothing carries across a trading day.
/// </summary>
public static class FiveEmaAlertScanner
{
    /// <summary>Every break in <paramref name="bars"/>, ascending, plus the times spot touched the
    /// EMA (the taught exit condition, which v1 offers as an option). <paramref name="maxAgeBars"/>
    /// of 0 means an alert candle never goes stale, as taught.</summary>
    public static (List<FiveEmaBreak> Breaks, List<DateTimeOffset> EmaTouchTimes) Scan(
        IReadOnlyList<Candle> bars, int emaPeriod, int maxAgeBars)
    {
        var breaks = new List<FiveEmaBreak>();
        var touchTimes = new List<DateTimeOffset>();
        var ema = EmaCrossoverDetector.EmaSeries(bars, emaPeriod);

        // Only one side can ever be pending: a candle entirely above the EMA is a short alert AND
        // proof that any long alert (which needed price below the EMA) is dead.
        (Candle Bar, int Index)? shortAlert = null;
        (Candle Bar, int Index)? longAlert = null;
        DateOnly? currentDay = null;

        for (var i = 0; i < bars.Count; i++)
        {
            var bar = bars[i];

            var day = BacktestUtil.IstDate(bar.Time);
            if (currentDay != day)
            {
                currentDay = day;
                shortAlert = null;
                longAlert = null;
            }

            if (ema[i] is not { } emaValue) continue;

            if (bar.Low <= emaValue && bar.High >= emaValue) touchTimes.Add(bar.Time);

            if (maxAgeBars > 0)
            {
                if (shortAlert is { } s && i - s.Index > maxAgeBars) shortAlert = null;
                if (longAlert is { } l && i - l.Index > maxAgeBars) longAlert = null;
            }

            // Step 1: does THIS bar break a PREVIOUS bar's alert candle? Checked before the alert
            // candle is updated below, so a candle can never trigger against itself.
            if (shortAlert is { } shortCandle && bar.Low < shortCandle.Bar.Low)
            {
                breaks.Add(new FiveEmaBreak(bar.Time, "Bearish", shortCandle.Bar));
                shortAlert = null;
            }
            else if (longAlert is { } longCandle && bar.High > longCandle.Bar.High)
            {
                breaks.Add(new FiveEmaBreak(bar.Time, "Bullish", longCandle.Bar));
                longAlert = null;
            }

            // Step 2: this bar becomes the new alert candle if it is itself entirely clear of the
            // EMA - strictly, so a bar merely grazing the line does not qualify. A bar that does
            // touch cancels both sides: price is back at the average.
            if (bar.Low > emaValue)
            {
                shortAlert = (bar, i);
                longAlert = null;
            }
            else if (bar.High < emaValue)
            {
                longAlert = (bar, i);
                shortAlert = null;
            }
            else
            {
                shortAlert = null;
                longAlert = null;
            }
        }

        return (breaks, touchTimes);
    }
}
