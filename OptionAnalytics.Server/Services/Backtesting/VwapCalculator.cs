using OptionAnalytics.Server.Models;

namespace OptionAnalytics.Server.Services.Backtesting;

/// <summary>Session-anchored Volume Weighted Average Price off a real volume-bearing bar series -
/// cumulative(typicalPrice * volume) / cumulative(volume), typicalPrice = (High+Low+Close)/3,
/// resetting to zero at the start of every IST trading day (VWAP is a SESSION indicator, same
/// "restart every day" rule CdvUnderlyingState's own CDV/TradingDay doc comment explains; carrying
/// yesterday's cumulative volume into today would make the very first bars of a new session read a
/// VWAP left over from the previous day's close instead of that day's own price discovery).
///
/// Needs a genuinely traded volume to mean anything - see DhanHistoricalDataService's own doc
/// comment on why NIFTY/BANKNIFTY's own spot/index bars now carry one (Dhan's January 2026 rollout
/// of real index volume, summed from each index's constituent stocks, the same convention NSE and
/// TradingView use) where they used to carry none at all.</summary>
public static class VwapCalculator
{
    /// <summary>The session VWAP at every bar that has SOME volume behind it yet, shaped like
    /// ObvCeSeries/CdvCeSeries (a time-keyed running value, not index-aligned to any one caller's own
    /// bar series) precisely because the source bars here are usually native 1-minute
    /// (SpotVolumeBarsOneMinute) while a strategy reads this against its own SpotBars at whatever
    /// timeframe it's running at - two differently-timed series that only line up by timestamp, not
    /// by index. Use BacktestUtil.LastValueAtOrBefore to read "VWAP as of this bar's time" the same
    /// way EmaCrossAtmFlowStrategy already reads OBV/CDV.
    ///
    /// No point at all is emitted for a bar before the day's first traded volume - not a zero, which
    /// would silently pass a "spot below VWAP" check because 0 is below anything, and not the bar's
    /// own price either, which would silently pass a "spot above/below VWAP" check for the opposite
    /// reason. A caller reading nothing back from LastValueAtOrBefore for a given time correctly
    /// finds no VWAP confirmation available, exactly like a lookup before OBV/CDV's own first bar.</summary>
    public static IReadOnlyList<ObvPoint> ComputeSeries(IReadOnlyList<CandleWithVolume> bars)
    {
        var result = new List<ObvPoint>();
        if (bars.Count == 0) return result;

        DateOnly? currentDay = null;
        decimal cumulativePriceVolume = 0;
        decimal cumulativeVolume = 0;

        foreach (var bar in bars.OrderBy(b => b.Time))
        {
            var day = BacktestUtil.IstDate(bar.Time);
            if (currentDay != day)
            {
                currentDay = day;
                cumulativePriceVolume = 0;
                cumulativeVolume = 0;
            }

            if (bar.Volume > 0)
            {
                var typicalPrice = (bar.High + bar.Low + bar.Close) / 3m;
                cumulativePriceVolume += typicalPrice * bar.Volume;
                cumulativeVolume += bar.Volume;
            }

            if (cumulativeVolume > 0)
                result.Add(new ObvPoint(bar.Time, cumulativePriceVolume / cumulativeVolume));
        }

        return result;
    }
}
