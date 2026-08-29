namespace OptionAnalytics.Server.Models;

/// <summary>One OHLC bar of a spot index's price series - the unit both the historical backfill
/// and the live 1-minute bar builder produce, and what the chart plots.</summary>
public readonly record struct Candle(DateTimeOffset Time, decimal Open, decimal High, decimal Low, decimal Close);
