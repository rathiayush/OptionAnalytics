namespace OptionAnalytics.Server.Models;

/// <summary>Describes one numeric input a strategy needs (see
/// Services.Backtesting.IBacktestStrategy.Parameters) - the frontend renders one control per spec
/// entry generically, without knowing anything about the specific strategy, so a new strategy's
/// parameters show up on the Backtrack page automatically the moment the strategy class exists and
/// is registered, with no frontend change needed.</summary>
public sealed record BacktestParameterSpec(string Key, string Label, decimal Default, decimal Min, decimal Max, decimal Step);
