using System.Collections.Concurrent;
using OptionAnalytics.Server.Dhan;
using OptionAnalytics.Server.Models;

namespace OptionAnalytics.Server.Services.OrderFlow;

/// <summary>
/// Any day's order flow for the Order Flow page's Load day: EXACT when the server has the day (the
/// live engine for today, OrderFlowDayStore for the last few days), otherwise ESTIMATED from Dhan's
/// 1-minute futures candles (OrderFlowEstimator). Candles are fetched straight from Dhan and kept in
/// memory only (never written to disk) for the rest of the IST day - a past day never changes, today's
/// is re-read after a minute - and the whole lot is dropped when the day changes.
/// </summary>
public sealed class OrderFlowHistory
{
    private static readonly TimeSpan TodayCandleTtl = TimeSpan.FromMinutes(1);
    private const int MaxCachedDays = 12;

    private readonly OrderFlowService _orderFlow;
    private readonly DhanHistoricalDataService _historical;
    private readonly ConcurrentDictionary<(uint SecurityId, DateOnly Day), (IReadOnlyList<CandleWithVolume> Candles, DateTimeOffset FetchedAt)> _candles = new();
    private DateOnly _cacheDay = IstClock.Today();

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
        var today = IstClock.Today();
        if (today != _cacheDay) { _candles.Clear(); _cacheDay = today; }
        var isToday = date == today;
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

    /// <summary>Whether Dhan serves a day's 1-minute candles for the futures contract listed then - an
    /// expired one included (resolved through NSE's contract file). Always asks Dhan afresh.</summary>
    public async Task<HistoryCheck> CheckAsync(string underlying, DateOnly date, DateOnly? expiry, CancellationToken cancellationToken)
    {
        var u = underlying.ToUpperInvariant();
        var today = IstClock.Today();
        var contract = await _orderFlow.ResolveContractAsync(underlying, expiry, date, cancellationToken);
        if (contract is null)
            return new HistoryCheck(u, date, null, null, null, false, null, 0, null, null, "no contract found for that date (NSE contract file unreachable, or not listed)");
        var source = date < today && NseFuturesContractArchive.Covers(u) ? "NSE contract file for that date" : "Dhan scrip master";
        var (bars, _, error) = await _historical.GetIntradayFuturesCandlesAsync(contract.SecurityId, contract.DhanSegment, date, date, 1, cancellationToken);
        var candles = bars.Select(b => b.Bar).ToList();
        return new HistoryCheck(u, date, contract.TradingSymbol, contract.SecurityId, contract.Expiry, contract.Expiry < today, source,
            candles.Count, candles.Count > 0 ? candles[0].Time : null, candles.Count > 0 ? candles[^1].Time : null,
            error ?? (candles.Count == 0 ? "Dhan returned no candles (holiday, or Dhan does not serve this contract's history)" : null));
    }

    public sealed record HistoryCheck(
        string Underlying, DateOnly Date, string? ContractSymbol, uint? SecurityId, DateOnly? Expiry, bool Expired, string? ContractSource,
        int Candles, DateTimeOffset? FirstCandle, DateTimeOffset? LastCandle, string? Error);

    /// <summary>The Time &amp; Sales tape of a day the server holds exactly (today's live engine, or a
    /// recent day kept in memory): prints at or before <paramref name="until"/>. A day estimated from
    /// candles has no prints.</summary>
    public async Task<TapeResult> TapeAsync(string underlying, DateOnly? date, DateOnly? expiry, DateTimeOffset? until, int count, int minLots,
        CancellationToken cancellationToken)
    {
        var day = date ?? IstClock.Today();
        OrderFlowEngine? engine;
        if (date is null)
        {
            engine = await _orderFlow.EngineForAsync(underlying, expiry, cancellationToken);
        }
        else
        {
            var contract = await _orderFlow.ResolveContractAsync(underlying, expiry, day, cancellationToken);
            if (contract is null) return new TapeResult(Array.Empty<OrderFlowTrade>(), $"no {underlying.ToUpperInvariant()} futures contract for {day:dd MMM yyyy}");
            var live = _orderFlow.TrackedEngine(contract.SecurityId);
            engine = live is not null && live.ExportDayDate() == day ? live : _orderFlow.PastDays.EngineFor(underlying, contract.SecurityId, day);
        }
        if (engine is null)
            return new TapeResult(Array.Empty<OrderFlowTrade>(), $"no Time & Sales for {day:dd MMM yyyy} - only days recorded live are held (an estimated day has no prints)");
        return new TapeResult(engine.Tape(until, Math.Clamp(count, 1, 5000), Math.Max(1, minLots) * (long)engine.LotSize), null);
    }

    public sealed record TapeResult(IReadOnlyList<OrderFlowTrade> Prints, string? Error);
}
