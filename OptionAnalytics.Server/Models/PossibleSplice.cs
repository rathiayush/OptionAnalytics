namespace OptionAnalytics.Server.Models;

/// <summary>One suspiciously large premium jump ExpiredOptionBacktestService.DetectPossibleSplices
/// found between two consecutive bars - PreviousClose/ThisOpen are the actual prices either side of
/// it, surfaced (not just the timestamp) so a real occurrence is self-diagnosing: whether the jump
/// looks like a genuine contract splice (a near-worthless about-to-expire print next to a fresh
/// contract's own real opening premium) or a real, single-contract move that merely LOOKED like one
/// (e.g. a deep-OTM strike's own last-hour gamma swing) can be judged directly from these two
/// numbers, without needing a separate round trip to ask what they were.</summary>
public readonly record struct PossibleSplice(DateTimeOffset Time, decimal PreviousClose, decimal ThisOpen);
