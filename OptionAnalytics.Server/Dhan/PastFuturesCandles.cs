using OptionAnalytics.Server.Models;

namespace OptionAnalytics.Server.Dhan;

/// <summary>
/// A past day's 1-minute futures candles even when that day's contract has since expired.
///
/// Dhan's intraday history covers ACTIVE instruments only - its intraday request has no expiryCode and
/// its expired-contract API (rolling option) serves options, not futures - and NSE publishes no free
/// intraday history at all (only daily bhavcopies and the contract file NseFuturesContractArchive reads).
/// So an expired front-month returns no candles. NSE lists three monthly contracts at a time, though,
/// and the next ones that traded that same day are usually still live - Dhan serves their history. This
/// tries the requested contract first, then the other contracts listed that day (nearest expiry first),
/// and says which one it used.
/// </summary>
public static class PastFuturesCandles
{
    public sealed record Result(
        DhanFuturesInstrument Contract, IReadOnlyList<(CandleWithVolume Bar, long? OpenInterest)> Bars, bool OiFieldPresent, string? Error, string? Note);

    public static async Task<Result> FetchAsync(
        DhanHistoricalDataService historical, DhanFuturesInstrument contract, IEnumerable<DhanFuturesInstrument> listedThatDay, DateOnly date,
        CancellationToken cancellationToken)
    {
        var (bars, oi, error) = await historical.GetIntradayFuturesCandlesAsync(contract.SecurityId, contract.DhanSegment, date, date, 1, cancellationToken);
        if (error is not null || bars.Count > 0 || contract.Expiry >= IstClock.Today()) return new Result(contract, bars, oi, error, null);

        var tried = new HashSet<uint> { contract.SecurityId };
        foreach (var other in listedThatDay.Where(c => c.Expiry >= date && c.Underlying.Equals(contract.Underlying, StringComparison.OrdinalIgnoreCase)).OrderBy(c => c.Expiry))
        {
            if (!tried.Add(other.SecurityId) || tried.Count > 4) continue;
            var (otherBars, otherOi, otherError) = await historical.GetIntradayFuturesCandlesAsync(other.SecurityId, other.DhanSegment, date, date, 1, cancellationToken);
            if (otherError is null && otherBars.Count > 0)
                return new Result(other, otherBars, otherOi, null,
                    $"Dhan keeps no intraday history for expired contracts (and NSE publishes none for free), so {contract.TradingSymbol} cannot be loaded - " +
                    $"showing {other.TradingSymbol}, which also traded on {date:dd MMM yyyy}: the same index moves, a slightly higher price (cost of carry) and less volume.");
        }
        return new Result(contract, bars, oi, null, null);
    }
}
