namespace OptionAnalytics.Server.Models;

/// <summary>One registered strategy's metadata, served by GET /api/backtest/strategies - what the
/// Backtrack page needs to list strategies in a dropdown and render each one's own parameter
/// controls without any strategy-specific frontend code.</summary>
public sealed record BacktestStrategyInfo(string Key, string Name, string Description, IReadOnlyList<BacktestParameterSpec> Parameters);
