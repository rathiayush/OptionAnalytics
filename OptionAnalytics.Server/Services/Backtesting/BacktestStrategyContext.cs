using OptionAnalytics.Server.Models;

namespace OptionAnalytics.Server.Services.Backtesting;

/// <summary>Everything a IBacktestStrategy needs to run, already computed once by
/// BacktestService.RunStrategy so no two strategies redo the same timeframe-aggregation/signal-
/// replay work. A strategy that wants a signal source other than Confluence (an EMA-only strategy,
/// a CDV-divergence strategy, ...) is free to ignore ConfluenceSignalsAscending and derive its own
/// timing from SpotBars, or a future BacktestService revision can grow this context with more
/// series as strategies that need them show up - it is intentionally not closed off to only what
/// the strategies registered today happen to use.</summary>
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

    /// <summary>Every signal the shared replay produced - individual leg flips as well as
    /// Confluences - newest first. A strategy that works off these can hand them straight back as
    /// its own EntrySignals view; one with its own entry rule ignores them and reports its own.</summary>
    public required IReadOnlyList<BacktestSignal> AllSignals { get; init; }

    /// <summary>The delta-weighted CE/PE OBV series (see CdvUnderlyingState.GetObvSeries), already
    /// aggregated to TimeframeMinutes - day-baselined and EMA-smoothed exactly as the dashboard's
    /// OBV chart plots it, so a strategy measuring an OBV surge measures the same numbers the chart
    /// shows. CDV is carried separately below - the two measure different things and a strategy
    /// may want either or both.</summary>
    public required IReadOnlyList<ObvPoint> ObvCeSeries { get; init; }
    public required IReadOnlyList<ObvPoint> ObvPeSeries { get; init; }

    /// <summary>The EMA-smoothed CE/PE CDV series (see CdvUnderlyingState.GetSmoothedCdvSeries),
    /// aggregated to TimeframeMinutes - the same numbers the CDV lookback table reports on. Covers
    /// the whole backfill window, same as OBV, with one difference in SHAPE that matters when
    /// reading it: CDV is a session indicator, so every trading day restarts at zero rather than
    /// carrying forward. Compare a value to that DAY's own open, never to a previous day's level.</summary>
    public required IReadOnlyList<ObvPoint> CdvCeSeries { get; init; }
    public required IReadOnlyList<ObvPoint> CdvPeSeries { get; init; }

    /// <summary>Closed premium candles (already aggregated to TimeframeMinutes) for one specific
    /// CE/PE strike - not necessarily the current ATM one. Returns empty if that strike was never
    /// tracked (fell outside the underlying's ATM+-8 window for its whole in-memory history).
    /// Backed by CdvUnderlyingState.GetStrikeClosedCandles; exposed as a delegate rather than the
    /// state object itself so a strategy only ever depends on this narrow contract, not the whole
    /// CDV subsystem.</summary>
    public required Func<decimal, bool, IReadOnlyList<Candle>> GetOptionBars { get; init; }

    /// <summary>The ATM CE/PE candles (already aggregated to TimeframeMinutes) exactly as
    /// ConfluenceAlertService's own ATM legs track them - the SAME series BacktestService's replay
    /// already builds internally for its own Confluence detection, exposed here so a strategy that
    /// wants "did the option side agree" (EmaCrossoverStrategy's optional ATM confirmation, for one)
    /// can compute its own EMA/crossover check directly off these rather than needing a second
    /// CDV-aware code path. Unlike GetOptionBars above, this ALWAYS tracks whatever is currently
    /// ATM at each point in time (rolling as spot moves), not one fixed strike.</summary>
    public required IReadOnlyList<Candle> AtmCeBars { get; init; }
    public required IReadOnlyList<Candle> AtmPeBars { get; init; }
}
