using OptionAnalytics.Server.Models;

namespace OptionAnalytics.Server.Dhan;

/// <summary>
/// A past day's 1-minute futures candles even when that day's contract has since expired.
///
/// Dhan's intraday history covers ACTIVE instruments only - its intraday request has no expiryCode and
/// its expired-contract API (rolling option) serves options, not futures. So for an expired contract:
///  1. Dhan, in case it still has it;
///  2. NSE's own chart data for that exact contract (NseChartHistory) - the real prices and volume, but
///     no open interest;
///  3. another contract listed that day that is still live (NSE lists three monthly contracts at a time)
///     - Dhan serves its history: the same index moves at a slightly higher price (cost of carry).
/// The result says which one it used, and when nothing worked, what each source answered.
/// </summary>
public static class PastFuturesCandles
{
    public sealed record Result(
        DhanFuturesInstrument Contract, IReadOnlyList<(CandleWithVolume Bar, long? OpenInterest)> Bars, bool OiFieldPresent, string? Error, string? Note);

    public static async Task<Result> FetchAsync(
        DhanHistoricalDataService historical, DhanFuturesInstrument contract, IEnumerable<DhanFuturesInstrument> listedThatDay, DateOnly date,
        CancellationToken cancellationToken, NseChartHistory? nse = null)
    {
        var (bars, oi, error) = await historical.GetIntradayFuturesCandlesAsync(contract.SecurityId, contract.DhanSegment, date, date, 1, cancellationToken);
        if (bars.Count > 0 || contract.Expiry >= IstClock.Today()) return new Result(contract, bars, oi, error, null);

        var dhanSaid = error is null ? "Dhan: no candles (it keeps intraday history for live contracts only)" : $"Dhan: {error}";
        string? nseSaid = null;
        if (nse is not null)
        {
            var fromNse = await nse.DayAsync(contract, date, cancellationToken);
            if (fromNse.Bars.Count > 0)
                return new Result(contract, fromNse.Bars.Select(b => (b, (long?)null)).ToList(), false, null,
                    $"{contract.TradingSymbol} has expired and Dhan keeps no intraday history for it - loaded from NSE's chart data instead (prices and volume; NSE's chart has no open interest).");
            nseSaid = fromNse.Error is null ? $"NSE: no {NseChartHistory.Ticker(contract)} bars for that day" : $"NSE: {fromNse.Error}";
        }

        var tried = new HashSet<uint> { contract.SecurityId };
        foreach (var other in listedThatDay.Where(c => c.Expiry >= date && c.Expiry >= IstClock.Today() && c.Underlying.Equals(contract.Underlying, StringComparison.OrdinalIgnoreCase)).OrderBy(c => c.Expiry))
        {
            if (!tried.Add(other.SecurityId) || tried.Count > 4) continue;
            var (otherBars, otherOi, otherError) = await historical.GetIntradayFuturesCandlesAsync(other.SecurityId, other.DhanSegment, date, date, 1, cancellationToken);
            if (otherError is null && otherBars.Count > 0)
                return new Result(other, otherBars, otherOi, null,
                    $"{contract.TradingSymbol} has expired and neither Dhan nor NSE served its day ({dhanSaid}; {nseSaid ?? "NSE not asked"}) - " +
                    $"showing {other.TradingSymbol}, which also traded on {date:dd MMM yyyy}: the same index moves, a slightly higher price (cost of carry) and less volume.");
        }
        // Nothing worked: a Dhan error is the error; otherwise empty, with what each source said.
        return new Result(contract, bars, oi, error, $"{dhanSaid}; {nseSaid ?? "NSE not asked"}.");
    }
}
