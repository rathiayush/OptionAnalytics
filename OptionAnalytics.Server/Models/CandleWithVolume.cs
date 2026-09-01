namespace OptionAnalytics.Server.Models;

/// <summary>One OHLC+volume bar - what an option contract's historical backfill needs beyond
/// Candle: volume feeds both OBV (Skender.Stock.Indicators) and the CDV backfill's bar-proxy delta
/// classification (see CdvUnderlyingState.BarProxyDelta), neither of which the plain spot/ATM
/// display candle needs.</summary>
public readonly record struct CandleWithVolume(DateTimeOffset Time, decimal Open, decimal High, decimal Low, decimal Close, long Volume)
{
    public Candle ToCandle() => new(Time, Open, High, Low, Close);
}
