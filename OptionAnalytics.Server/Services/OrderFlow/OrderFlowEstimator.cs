using OptionAnalytics.Server.Models;

namespace OptionAnalytics.Server.Services.OrderFlow;

/// <summary>
/// A past day's order flow rebuilt from Dhan's 1-MINUTE futures candles - for a day the server did not
/// see live (Dhan has no historical tick or market-depth data at all, so this is the most that can be
/// had). Everything here is an ESTIMATE and is labelled as one on the page:
///
/// - Buy/sell split (delta): bulk volume classification (Easley, Lopez de Prado & O'Hara): a minute's
///   buy share is the normal CDF of its price change over the day's typical one-minute change,
///   Phi(dP / sigma) - a big up-minute is mostly buying, a flat one half and half.
/// - Footprint rows: a candle cannot say where in its range it traded, so its volume is spread evenly
///   over the HeatmapBaseRow rows its high-low range covers, at the minute's buy/sell split. Volume
///   profile, delta and cumulative delta are meaningful from this; per-row imbalances are not (the
///   page turns them off for an estimated day).
/// - "Big orders": a candle has no individual trades, so minutes with a volume spike (at least
///   SpikeFactor x the day's median minute) are marked instead, at their close.
/// - No heatmap, book or icebergs - those need market depth, which has no history.
/// </summary>
public static class OrderFlowEstimator
{
    public const decimal SpikeFactor = 3m;

    public const string Note =
        "Estimated from Dhan's 1-minute candles - Dhan has no historical tick or market-depth data. Delta is each minute's volume split by its price move " +
        "(bulk volume classification), each minute's volume is spread evenly over its range, big dots are minutes with a volume spike, and there is no " +
        "depth heatmap. Days the server saw live replay exactly.";

    public static OrderFlowSnapshot Build(
        string underlying, uint securityId, string contractSymbol, string exchangeSegment, decimal tickSize, int lotSize, DateOnly? expiry,
        DateOnly day, IReadOnlyList<CandleWithVolume> candles, decimal rowSize, long minTradeQty)
    {
        var ordered = candles.Where(c => c.Volume > 0 && c.High >= c.Low && c.Low > 0).OrderBy(c => c.Time).ToList();
        var changes = new List<double>(ordered.Count);
        for (var i = 0; i < ordered.Count; i++)
            changes.Add((double)(ordered[i].Close - (i == 0 ? ordered[i].Open : ordered[i - 1].Close)));
        var sigma = StdDev(changes);
        if (sigma <= 0) sigma = (double)Math.Max(tickSize, 0.05m);

        var bars = new List<OrderFlowBar>(ordered.Count);
        var trades = new List<OrderFlowTrade>();
        var medianVolume = ordered.Count > 0 ? ordered.Select(c => c.Volume).OrderBy(v => v).ElementAt(ordered.Count / 2) : 0;
        long seq = 0;
        for (var i = 0; i < ordered.Count; i++)
        {
            var c = ordered[i];
            var buyShare = NormalCdf(changes[i] / sigma);
            var buy = (long)Math.Round(c.Volume * buyShare);
            var sell = c.Volume - buy;
            var time = c.Time.ToOffset(IstClock.Offset);
            bars.Add(new OrderFlowBar(time, c.Open, c.High, c.Low, c.Close, buy, sell, 0, Rows(c, buy, sell, rowSize)));

            if (medianVolume > 0 && c.Volume >= SpikeFactor * medianVolume && c.Volume >= minTradeQty)
                trades.Add(new OrderFlowTrade(++seq, time.AddSeconds(59), c.Close, c.Volume, buy >= sell));
        }

        var last = ordered.LastOrDefault();
        var meta = new OrderFlowMeta(underlying, contractSymbol, securityId, exchangeSegment, lotSize, tickSize,
            last.Close, ordered.Count > 0 ? last.Time.AddSeconds(59) : null, 0, day, expiry);
        return new OrderFlowSnapshot(meta, rowSize, bars, trades, Array.Empty<OrderFlowIceberg>(), Array.Empty<HeatmapColumn>(),
            new OrderFlowBook(Array.Empty<BookLevel>(), Array.Empty<BookLevel>()), "estimated", Note);
    }

    /// <summary>A candle's volume spread evenly over its range in HeatmapBaseRow rows (any remainder to
    /// the middle rows, so the rows add up exactly), then grouped into rowSize rows, highest first.</summary>
    internal static IReadOnlyList<FootprintLevel> Rows(CandleWithVolume c, long buy, long sell, decimal rowSize)
    {
        var baseRow = OrderFlowEngine.HeatmapBaseRow;
        var low = (int)Math.Floor(c.Low / baseRow);
        var high = (int)Math.Floor(c.High / baseRow);
        var n = high - low + 1;
        var grouped = new SortedDictionary<decimal, (long Buy, long Sell)>();
        for (var k = 0; k < n; k++)
        {
            var price = OrderFlowEngine.Row((low + k) * baseRow, rowSize);
            grouped.TryGetValue(price, out var existing);
            grouped[price] = (existing.Buy + Share(buy, n, k), existing.Sell + Share(sell, n, k));
        }
        return grouped.Reverse().Select(kv => new FootprintLevel(kv.Key, kv.Value.Buy, kv.Value.Sell)).ToList();

        static long Share(long total, int count, int index)
        {
            var each = total / count;
            var remainder = total - each * count;
            // The remainder goes one apiece to the rows nearest the middle.
            var fromMiddle = Math.Abs(index - (count - 1) / 2.0);
            var rank = Enumerable.Range(0, count).Count(j => Math.Abs(j - (count - 1) / 2.0) < fromMiddle || (Math.Abs(j - (count - 1) / 2.0) == fromMiddle && j < index));
            return each + (rank < remainder ? 1 : 0);
        }
    }

    private static double StdDev(IReadOnlyList<double> values)
    {
        if (values.Count < 2) return 0;
        var mean = values.Average();
        return Math.Sqrt(values.Sum(v => (v - mean) * (v - mean)) / (values.Count - 1));
    }

    /// <summary>The standard normal CDF (Abramowitz-Stegun 7.1.26 erf, error below 1.5e-7).</summary>
    internal static double NormalCdf(double x)
    {
        var z = Math.Abs(x) / Math.Sqrt(2);
        var t = 1 / (1 + 0.3275911 * z);
        var erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.Exp(-z * z);
        return x >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
    }
}
