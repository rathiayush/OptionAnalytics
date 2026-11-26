namespace OptionAnalytics.Server.TrueData;

/// <summary>
/// HOW OFTEN THE FEED ACTUALLY SENDS (asked for - "is TrueData really tick by tick?"): counts every trade / quote message the live feed applies, per stream
/// (a futures contract's trades, its quotes, the options' trades), by the second it ARRIVED. For each: the total, the rate over the last 10 s and 60 s, the
/// busiest second, how many seconds had 1 / 2 / 3 / 4+ messages, the median gap between two messages and the share of messages that came within 100 ms of the one
/// before. The verdict is read from those: a feed that is "tick by tick" sends bursts inside one second; one that is a snapshot about once a second shows almost
/// every second with exactly one message and gaps near a second or more. Memory only, a new IST day starts over. Reading it changes nothing.
/// </summary>
public sealed class TickRateMeter
{
    private const int GapsKept = 400;
    private readonly object _lock = new();
    private readonly Dictionary<string, Stream> _streams = new();

    private sealed class Stream
    {
        public long Total;
        public DateOnly Day;
        public DateTimeOffset First, Last;
        public long SecondStart = long.MinValue;     // unix seconds of the second being counted
        public int InSecond;
        public readonly long[] Histogram = new long[4];   // seconds with 1, 2, 3, 4+ messages
        public int Peak;
        public readonly Queue<long> Recent = new();      // arrival unix ms of the last 60 s (for the rates)
        public readonly Queue<double> Gaps = new();
        public long Fast;                                // gaps under 100 ms
        public long GapCount;
    }

    public void Record(string key, DateTimeOffset arrival)
    {
        lock (_lock)
        {
            if (!_streams.TryGetValue(key, out var s)) _streams[key] = s = new Stream { First = arrival };
            var day = DateOnly.FromDateTime(arrival.ToOffset(TimeSpan.FromHours(5.5)).DateTime);
            if (s.Day != day && s.Total > 0) { _streams[key] = s = new Stream { First = arrival }; }
            s.Day = day;
            var ms = arrival.ToUnixTimeMilliseconds();
            var sec = ms / 1000;
            if (s.Total > 0)
            {
                var gap = (arrival - s.Last).TotalMilliseconds;
                if (gap >= 0)
                {
                    s.Gaps.Enqueue(gap); if (s.Gaps.Count > GapsKept) s.Gaps.Dequeue();
                    s.GapCount++; if (gap < 100) s.Fast++;
                }
            }
            if (sec != s.SecondStart) { Close(s); s.SecondStart = sec; s.InSecond = 0; }
            s.InSecond++;
            s.Total++;
            s.Last = arrival;
            s.Recent.Enqueue(ms);
            while (s.Recent.Count > 0 && ms - s.Recent.Peek() > 60_000) s.Recent.Dequeue();
        }
    }

    private static void Close(Stream s)
    {
        if (s.InSecond <= 0) return;
        s.Histogram[Math.Min(s.InSecond, 4) - 1]++;
        if (s.InSecond > s.Peak) s.Peak = s.InSecond;
    }

    public sealed record Rate(string Key, long Total, double PerSecond10, double PerSecond60, double PerSecondSinceFirst, int PeakInASecond,
        long SecondsWith1, long SecondsWith2, long SecondsWith3, long SecondsWith4Plus, double? MedianGapMs, double? Within100MsShare, string Verdict, DateTimeOffset? LastAt);

    public IReadOnlyList<Rate> Snapshot(DateTimeOffset now)
    {
        lock (_lock)
        {
            var nowMs = now.ToUnixTimeMilliseconds();
            return _streams.OrderBy(kv => kv.Key).Select(kv =>
            {
                var s = kv.Value;
                long h1 = s.Histogram[0], h2 = s.Histogram[1], h3 = s.Histogram[2], h4 = s.Histogram[3];
                var peak = s.Peak;
                if (s.InSecond > 0) { var i = Math.Min(s.InSecond, 4) - 1; if (i == 0) h1++; else if (i == 1) h2++; else if (i == 2) h3++; else h4++; peak = Math.Max(peak, s.InSecond); }
                var last10 = s.Recent.Count(t => nowMs - t <= 10_000);
                var last60 = s.Recent.Count(t => nowMs - t <= 60_000);
                var span = Math.Max(1, (s.Last - s.First).TotalSeconds);
                double? median = null;
                if (s.Gaps.Count > 0) { var g = s.Gaps.OrderBy(x => x).ToArray(); median = g[g.Length / 2]; }
                double? fast = s.GapCount > 0 ? (double)s.Fast / s.GapCount : null;
                return new Rate(kv.Key, s.Total, last10 / 10.0, last60 / 60.0, s.Total / span, peak, h1, h2, h3, h4, median, fast, VerdictOf(s.Total, h1, h2 + h3 + h4, median, fast), s.Total > 0 ? s.Last : null);
            }).ToList();
        }
    }

    /// <summary>Reads the shape: enough messages to say anything (>= 60), then bursts inside a second (a real share of seconds with 2+ messages, or many gaps under
    /// 100 ms) = tick by tick; almost every second exactly one message with a gap near a second or more = a snapshot feed.</summary>
    internal static string VerdictOf(long total, long seconds1, long secondsMore, double? medianGapMs, double? within100)
    {
        if (total < 60) return "Not enough messages yet to say (needs 60).";
        var seconds = Math.Max(1, seconds1 + secondsMore);
        var burst = (double)secondsMore / seconds;
        if (burst >= 0.30 || (within100 ?? 0) >= 0.30) return $"Tick by tick: {burst:P0} of the seconds carried several messages, {(within100 ?? 0):P0} came within 100 ms of the one before.";
        return $"Snapshot-like: {1 - burst:P0} of the seconds carried exactly one message (median gap {(medianGapMs ?? 0) / 1000:0.0} s) - one reading a second or slower, not one per trade.";
    }
}
