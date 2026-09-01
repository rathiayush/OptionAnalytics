namespace OptionAnalytics.Server.Models;

/// <summary>One selectable choice for a parameter that is a pick-one rather than a free number
/// (see BacktestParameterSpec.Options). The value stays a plain decimal so the whole parameter
/// pipeline - query string, controller parsing, IBacktestStrategy.Simulate's dictionary - is
/// unchanged; only how the frontend renders it differs.</summary>
public sealed record BacktestParameterOption(decimal Value, string Label);

/// <summary>Describes one input a strategy needs (see
/// Services.Backtesting.IBacktestStrategy.Parameters) - the frontend renders one control per spec
/// entry generically, without knowing anything about the specific strategy, so a new strategy's
/// parameters show up on the Backtrack page automatically the moment the strategy class exists and
/// is registered, with no frontend change needed.
///
/// <paramref name="Options"/> is what makes a parameter a pick-one instead of a free number: when
/// it is null the page renders a numeric input bounded by Min/Max/Step, and when it is set it
/// renders a dropdown of exactly those choices instead. Min/Max/Step are still worth setting on a
/// choice parameter as the bounds of its underlying value.</summary>
public sealed record BacktestParameterSpec(
    string Key,
    string Label,
    decimal Default,
    decimal Min,
    decimal Max,
    decimal Step,
    IReadOnlyList<BacktestParameterOption>? Options = null);
