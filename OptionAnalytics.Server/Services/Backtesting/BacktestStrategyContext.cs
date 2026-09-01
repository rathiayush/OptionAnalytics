using OptionAnalytics.Server.Models;

namespace OptionAnalytics.Server.Services.Backtesting;

/// <summary>Everything a IBacktestStrategy needs to run, already computed once by
/// BacktestService.RunStrategy so no two strategies redo the same timeframe-aggregation/signal-
/// replay work. A strategy that wants a signal source other than Confluence (an EMA-only strategy,
/// a CDV-divergence strategy, ...) is free to ignore ConfluenceSignalsAscending and derive its own
/// timing from SpotBars, or a future BacktestService revision can grow this context with more
/// series as strategies that need them show up - it is intentionally not closed off to only what
/// OtmConfluenceStrategy happens to use today.</summary>
public sealed class BacktestStrategyContext
{
    public required string Underlying { get; init; }

    /// <summary>The timeframe strategy code should assume SpotBars/GetOptionBars are already
    /// bucketed to - a strategy never needs to aggregate candles itself.</summary>
    public required int TimeframeMinutes { get; init; }

    /// <summary>This underlying's strike-step (50 for NIFTY, 100 for BANKNIFTY) - what "N strikes
    /// OTM" or any other strike-offset math should multiply by.</summary>
    public required int Step { get; init; }

    /// <summary>The underlying's own closed spot bars, aggregated to TimeframeMinutes, ascending.</summary>
    public required IReadOnlyList<Candle> SpotBars { get; init; }

    /// <summary>Every Confluence signal BacktestService's shared replay produced at this timeframe,
    /// ascending (oldest first) - the natural order to walk when simulating trades one at a time.</summary>
    public required IReadOnlyList<BacktestSignal> ConfluenceSignalsAscending { get; init; }

    /// <summary>Closed premium candles (already aggregated to TimeframeMinutes) for one specific
    /// CE/PE strike - not necessarily the current ATM one. Returns empty if that strike was never
    /// tracked (fell outside the underlying's ATM+-8 window for its whole in-memory history).
    /// Backed by CdvUnderlyingState.GetStrikeClosedCandles; exposed as a delegate rather than the
    /// state object itself so a strategy only ever depends on this narrow contract, not the whole
    /// CDV subsystem.</summary>
    public required Func<decimal, bool, IReadOnlyList<Candle>> GetOptionBars { get; init; }
}
