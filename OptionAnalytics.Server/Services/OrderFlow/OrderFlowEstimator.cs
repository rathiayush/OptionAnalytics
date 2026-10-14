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
/// - Footprint rows: a candle cannot say where in its range it traded, so its volume is laid along the
///   path price most likely took inside the minute (see Rows) - rising legs as buying, falling legs as
///   selling, in whole lots. Volume profile, delta and cumulative delta are meaningful from this;
///   per-row imbalances are not (the page turns them off for an estimated day).
/// - "Big orders": a candle has no individual trades, so minutes with a volume spike (at least
///   SpikeFactor x the day's median minute) are marked instead, at their close.
/// - No heatmap, book or icebergs - those need market depth, which has no history.
/// </summary>
public static class OrderFlowEstimator
{
    public const decimal SpikeFactor = 3m;

    public const string Note =
        "Estimated from Dhan's 1-minute candles - Dhan has no historical tick or market-depth data. Delta is each minute's volume split by its price move " +
        "(bulk volume classification); each minute's volume is laid along the path price most likely took inside it (rising legs as buying, falling legs as " +
        "selling), so per-row numbers are an estimate too; big dots are minutes with a volume spike, and there is no " +
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
            // In whole lots - futures volume always is, so both sides stay whole lots.
            var lot = Math.Max(1, lotSize);
            var buy = Math.Min(c.Volume, (long)Math.Round(c.Volume * buyShare / lot) * lot);
            var sell = c.Volume - buy;
            var time = c.Time.ToOffset(IstClock.Offset);
            bars.Add(new OrderFlowBar(time, c.Open, c.High, c.Low, c.Close, buy, sell, 0, Rows(c, buy, sell, rowSize, lotSize)));

            if (medianVolume > 0 && c.Volume >= SpikeFactor * medianVolume && c.Volume >= minTradeQty)
                trades.Add(new OrderFlowTrade(++seq, time.AddSeconds(59), c.Close, c.Volume, buy >= sell));
        }

        var last = ordered.LastOrDefault();
        var meta = new OrderFlowMeta(underlying, contractSymbol, securityId, exchangeSegment, lotSize, tickSize,
            last.Close, ordered.Count > 0 ? last.Time.AddSeconds(59) : null, 0, day, expiry);
        return new OrderFlowSnapshot(meta, rowSize, bars, trades, Array.Empty<OrderFlowIceberg>(), Array.Empty<HeatmapColumn>(),
            new OrderFlowBook(Array.Empty<BookLevel>(), Array.Empty<BookLevel>()), "estimated", Note);
    }

    /// <summary>
    /// A candle's buy and sell volume laid over its range, following the path price most likely took
    /// inside the minute: an up-minute dips to its low first, then rallies to its high and closes
    /// (O-L-H-C); a down-minute rallies first (O-H-L-C). Volume is spread along that path, so prices the
    /// path crossed more than once get more of it; the rising legs carry the buying and the falling legs
    /// the selling (each side keeps its bulk-volume total - a side with no leg of its own follows the
    /// whole path). Quantities are whole lots (largest remainder, so the rows still add up exactly to
    /// the bar), grouped into rowSize rows, highest first.
    /// </summary>
    internal static IReadOnlyList<FootprintLevel> Rows(CandleWithVolume c, long buy, long sell, decimal rowSize, int lotSize = 1)
    {
        var baseRow = OrderFlowEngine.HeatmapBaseRow;
        var low = (int)Math.Floor(c.Low / baseRow);
        var high = (int)Math.Floor(c.High / baseRow);
        var n = high - low + 1;
        var upWeight = new double[n];
        var downWeight = new double[n];

        var path = c.Close >= c.Open ? new[] { c.Open, c.Low, c.High, c.Close } : new[] { c.Open, c.High, c.Low, c.Close };
        for (var leg = 0; leg < 3; leg++)
        {
            var from = (double)path[leg];
            var to = (double)path[leg + 1];
            if (from == to) continue;
            var weights = to > from ? upWeight : downWeight;
            var (a, b) = (Math.Min(from, to), Math.Max(from, to));
            for (var k = 0; k < n; k++)
            {
                var rowLow = (double)((low + k) * baseRow);
                var overlap = Math.Min(b, rowLow + (double)baseRow) - Math.Max(a, rowLow);
                if (overlap > 0) weights[k] += overlap;
            }
        }
        // A flat minute (or one whose range sits inside a single row) trades where it is.
        var total = new double[n];
        for (var k = 0; k < n; k++) total[k] = upWeight[k] + downWeight[k];
        if (total.Sum() <= 0) total[Math.Clamp((int)Math.Floor(c.Close / baseRow) - low, 0, n - 1)] = 1;

        var lot = Math.Max(1, lotSize);
        var buyRows = Allocate(buy, upWeight.Sum() > 0 ? upWeight : total, lot);
        var sellRows = Allocate(sell, downWeight.Sum() > 0 ? downWeight : total, lot);

        var grouped = new SortedDictionary<decimal, (long Buy, long Sell)>();
        for (var k = 0; k < n; k++)
        {
            if (buyRows[k] == 0 && sellRows[k] == 0) continue;
            var price = OrderFlowEngine.Row((low + k) * baseRow, rowSize);
            grouped.TryGetValue(price, out var existing);
            grouped[price] = (existing.Buy + buyRows[k], existing.Sell + sellRows[k]);
        }
        return grouped.Reverse().Select(kv => new FootprintLevel(kv.Key, kv.Value.Buy, kv.Value.Sell)).ToList();
    }

    /// <summary>Splits <paramref name="total"/> over rows in proportion to <paramref name="weights"/>,
    /// in whole lots by largest remainder; whatever is less than a lot goes to the heaviest row, so the
    /// rows add up to exactly <paramref name="total"/>.</summary>
    internal static long[] Allocate(long total, double[] weights, int lot)
    {
        var result = new long[weights.Length];
        var sum = weights.Sum();
        if (total <= 0 || sum <= 0) return result;
        var lots = total / lot;
        var exact = weights.Select(w => lots * w / sum).ToArray();
        var given = 0L;
        for (var k = 0; k < weights.Length; k++) { result[k] = (long)Math.Floor(exact[k]); given += result[k]; }
        foreach (var k in Enumerable.Range(0, weights.Length).OrderByDescending(k => exact[k] - Math.Floor(exact[k])).Take((int)(lots - given)))
            result[k]++;
        for (var k = 0; k < weights.Length; k++) result[k] *= lot;
        var heaviest = Array.IndexOf(weights, weights.Max());
        result[heaviest] += total - lots * lot;
        return result;
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
