using System.Collections.Concurrent;
using OptionAnalytics.Server.Dhan;
using OptionAnalytics.Server.Models;

namespace OptionAnalytics.Server.Services.OrderFlow;

/// <summary>
/// Any day's order flow for the Order Flow page's Load day: EXACT when the server has the day (the
/// live engine for today, OrderFlowDayStore for the last few days), otherwise ESTIMATED from Dhan's
/// 1-minute futures candles (OrderFlowEstimator). Candles are cached in memory - a past day never
/// changes (kept for the last few days asked for); today's for a minute.
/// </summary>
public sealed class OrderFlowHistory
{
    private static readonly TimeSpan TodayCandleTtl = TimeSpan.FromMinutes(1);
    private const int MaxCachedDays = 12;

    private readonly OrderFlowService _orderFlow;
    private readonly DhanHistoricalDataService _historical;
    private readonly ConcurrentDictionary<(uint SecurityId, DateOnly Day), (IReadOnlyList<CandleWithVolume> Candles, DateTimeOffset FetchedAt)> _candles = new();

    public OrderFlowHistory(OrderFlowService orderFlow, DhanHistoricalDataService historical)
    {
        _orderFlow = orderFlow;
        _historical = historical;
    }

    public sealed record Result(OrderFlowSnapshot? Snapshot, string? Error);

    public async Task<Result> DayAsync(string underlying, DateOnly date, DateOnly? expiry, decimal rowSize, int minTradeLots, int heatmapColumns, CancellationToken cancellationToken)
    {
        var contract = await _orderFlow.ResolveContractAsync(underlying, expiry, date, cancellationToken);
        if (contract is null)
            return new Result(null, expiry is null
                ? $"No {underlying.ToUpperInvariant()} futures contract found for {date:dd MMM yyyy} - NSE's contract list for that week could not be read (SENSEX: only contracts Dhan still lists)."
                : $"No {underlying.ToUpperInvariant()} futures contract expiring {expiry:dd MMM yyyy} was listed on {date:dd MMM yyyy}.");
        if (contract.Expiry < date) return new Result(null, $"The {contract.TradingSymbol} contract had already expired on {date:dd MMM yyyy}.");

        // Exact: a live engine already holding that day, or a day kept in memory. (Replaying a day never
        // starts tracking a contract live.)
        var live = _orderFlow.TrackedEngine(contract.SecurityId);
        var exact = live is not null && live.ExportDayDate() == date
            ? live
            : _orderFlow.PastDays.EngineFor(underlying, contract.SecurityId, date);
        if (exact is not null)
            return new Result(exact.Snapshot(rowSize, Math.Max(1, minTradeLots) * (long)exact.LotSize, heatmapColumns), null);

        // Estimated from Dhan's 1-minute candles.
        var key = (contract.SecurityId, date);
        var isToday = date == IstClock.Today();
        if (!_candles.TryGetValue(key, out var cached) || (isToday && DateTimeOffset.UtcNow - cached.FetchedAt > TodayCandleTtl))
        {
            var (bars, _, error) = await _historical.GetIntradayFuturesCandlesAsync(contract.SecurityId, contract.DhanSegment, date, date, 1, cancellationToken);
            if (error is not null) return new Result(null, $"Dhan did not return {contract.TradingSymbol} candles for {date:dd MMM yyyy}: {error}");
            cached = (bars.Select(b => b.Bar).ToList(), DateTimeOffset.UtcNow);
            _candles[key] = cached;
            while (_candles.Count > MaxCachedDays) _candles.TryRemove(_candles.OrderBy(kv => kv.Value.FetchedAt).First().Key, out _);
        }
        if (cached.Candles.Count == 0)
            return new Result(null, contract.Expiry < IstClock.Today()
                ? $"Dhan returned no candles for {contract.TradingSymbol} (id {contract.SecurityId}, expired {contract.Expiry:dd MMM yyyy}) on {date:dd MMM yyyy} - a holiday, or Dhan does not serve that expired contract's history."
                : $"No {contract.TradingSymbol} trading on {date:dd MMM yyyy} (a holiday or weekend, or the contract was not listed yet).");

        return new Result(OrderFlowEstimator.Build(underlying.ToUpperInvariant(), contract.SecurityId, contract.TradingSymbol, contract.DhanSegment,
            contract.TickSize, contract.LotSize, contract.Expiry, date, cached.Candles, rowSize, Math.Max(1, minTradeLots) * (long)contract.LotSize), null);
    }
}
