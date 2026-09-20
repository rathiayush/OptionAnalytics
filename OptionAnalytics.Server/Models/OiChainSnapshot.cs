namespace OptionAnalytics.Server.Models;

/// <summary>One strike's CE/PE open interest and premium at some point in time - either this
/// morning's baseline or right now. Premium is carried alongside OI (not just the OI number alone)
/// because "is this strike's writer in profit" needs both: OptionTradeSimulator's own P&amp;L
/// convention already reads a seller's profit off premium decay, and price-vs-strike alone can't
/// tell a strike that has barely moved from one that has genuinely decayed.</summary>
public sealed record OiStrikeSnapshot(long? CeOpenInterest, decimal? CePremium, long? PeOpenInterest, decimal? PePremium);

/// <summary>One underlying/expiry's open-interest picture for OiUnwindStrategy: a Baseline captured
/// once each morning (see OpenInterestHostedService.BaselineCaptureMinutesOfDay) and a Current
/// snapshot refreshed on a short poll thereafter, both keyed by strike.
///
/// This is a LIVE-ONLY concept - Dhan's Option Chain API has no history (see
/// DhanOptionChainQuotes's own doc comment), so there is no way to reconstruct what OI looked like
/// at any past bar, only what it looks like right now compared to this morning. A strategy reading
/// this can therefore only ever answer "does the wall look like this AT THIS INSTANT," not replay it
/// across a backtest - see OiUnwindStrategy's own doc comment for what that means for where this
/// strategy can and cannot run.
///
/// Baseline is empty (not null - the whole snapshot is null instead, see
/// BacktestStrategyContext.OpenInterest) until the morning capture has actually happened, so a
/// caller checking Baseline.Count == 0 can tell "not ready yet" apart from "ready but this specific
/// strike wasn't listed."</summary>
public sealed record OiChainSnapshot(
    DateOnly Day,
    DateTimeOffset BaselineCapturedAtUtc,
    IReadOnlyDictionary<decimal, OiStrikeSnapshot> Baseline,
    IReadOnlyDictionary<decimal, OiStrikeSnapshot> Current);
