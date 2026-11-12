using OptionAnalytics.Server.Models;

namespace OptionAnalytics.Server.Services;

/// <summary>What counts as "price moved but OI did not follow". Every default is deliberately strict -
/// this is an alert, and a false one costs more than a missed one. Bound from the "OiDivergence"
/// configuration section.</summary>
public sealed class DivergenceOptions
{
    public bool Enabled { get; init; } = true;
    /// <summary>How many completed bars the move is read over (bars of BarMinutes each).</summary>
    public int Minutes { get; init; } = 3;
    /// <summary>The bars' size in minutes: 1 = the 1-minute spot bars as they close; 15 = the session's completed
    /// 15-minute candles from 09:15 (SessionCandles) - the move over the last of them, its OI read at each candle's end.</summary>
    public int BarMinutes { get; init; } = 1;
    /// <summary>The spot move over those bars, as a percent of price (0.05% = about 12 points on NIFTY).</summary>
    public decimal MinMovePct { get; init; } = 0.05m;
    /// <summary>"OI did not unwind": the strike's OI may have changed by no worse than this many percent
    /// (a fall of up to this much still counts as the same). Anything above it - rising - qualifies.</summary>
    public decimal FlatTolerancePct { get; init; } = 0.5m;
    /// <summary>The strike must be a real level: its OI at least this share of the biggest OI of its
    /// side within BandSteps strikes of price, so a thin far strike's flat OI is not a "wall".</summary>
    public decimal MinWallShare { get; init; } = 0.25m;
    public int BandSteps { get; init; } = 10;
    /// <summary>The OI feed must be visibly alive: at least this many of the strikes within AliveSteps of
    /// price changed OI over the window - otherwise "flat" only means no OI tick arrived.</summary>
    public int AliveStrikes { get; init; } = 3;
    public int AliveSteps { get; init; } = 3;
    /// <summary>An OI reading older than this many minutes before the minute asked about is not used
    /// (e.g. yesterday's last reading carried into this morning).</summary>
    public int MaxCarryMinutes { get; init; } = 5;
    /// <summary>The same zone is not alerted again for an underlying inside this window.</summary>
    public int CooldownMinutes { get; init; } = 10;
    /// <summary>IST, start of the minute the move ends in: nothing before From (the open is noise) or from To.</summary>
    public int FromMinuteOfDay { get; init; } = 9 * 60 + 25;
    public int ToMinuteOfDay { get; init; } = 15 * 60 + 15;
    /// <summary>Sent to Telegram too (asked for - "only send signal for 15 min divergence": the 1-minute check is the
    /// app's popup only, off here by default; the 15-minute one - FifteenMinuteDefaults - goes to Telegram).</summary>
    public bool Telegram { get; init; }

    /// <summary>The 15-minute divergence (the "OiDivergence15m" section binds over these): the last completed
    /// 15-minute candle closed beyond the one before by MinMovePct while the OI at its strike held - from the first
    /// candle that has one before it (09:30 - 09:44) - sent to Telegram, once per zone in 30 minutes.</summary>
    public static DivergenceOptions FifteenMinuteDefaults() => new()
    {
        BarMinutes = 15, Minutes = 1, MinMovePct = 0.10m, CooldownMinutes = 30, FromMinuteOfDay = 9 * 60 + 30, Telegram = true,
    };
}

/// <summary>Price fell (or rose) for the last Minutes minutes, yet the OI that should have given way at
/// the nearest strike did not: a falling price into a strike whose PUT OI is holding or growing is a
/// support being defended (a discount zone); a rising price into a strike whose CALL OI is holding or
/// growing is a resistance being defended (a premium zone). It is a prompt to look - an entry waits for
/// a confirming candle - not an order.</summary>
public sealed record PriceOiDivergence(
    string Underlying, DateTimeOffset BarTime, string Zone, string Side, decimal Strike,
    long OiBefore, long OiNow, decimal OiChangePct, decimal PriceFrom, decimal PriceTo, decimal PriceChangePct,
    int Minutes, string Message);

public static class PriceOiDivergenceDetector
{
    /// <param name="closed">Completed spot bars of BarMinutes each, oldest first - the last Minutes + 1 are read.</param>
    /// <param name="step">Strike spacing.</param>
    /// <param name="strikes">The strikes with OI readings (any side).</param>
    /// <param name="oiAt">OI of (side "CE" / "PE", strike) as of the END of the given minute (unix minutes),
    /// or null when there is no recent enough reading.</param>
    public static PriceOiDivergence? Evaluate(
        string underlying, IReadOnlyList<Candle> closed, decimal step, IEnumerable<decimal> strikes,
        Func<string, decimal, long, long?> oiAt, DivergenceOptions o)
    {
        var n = o.Minutes;
        var tf = Math.Max(1, o.BarMinutes);
        if (n < 1 || step <= 0 || closed.Count < n + 1) return null;
        var bars = closed.Skip(closed.Count - (n + 1)).ToList();

        // Consecutive bars, none missing.
        for (var i = 1; i < bars.Count; i++)
            if (bars[i].Time - bars[i - 1].Time != TimeSpan.FromMinutes(tf)) return null;

        var last = bars[^1];
        var minuteOfDay = last.Time.ToOffset(IstClock.Offset).TimeOfDay.TotalMinutes;
        if (minuteOfDay < o.FromMinuteOfDay || minuteOfDay >= o.ToMinuteOfDay) return null;

        // Every one of the minutes closed beyond the one before it - not one noisy bar.
        var fell = true;
        var rose = true;
        for (var i = 1; i < bars.Count; i++)
        {
            fell &= bars[i].Close < bars[i - 1].Close;
            rose &= bars[i].Close > bars[i - 1].Close;
        }
        if (!fell && !rose) return null;

        var from = bars[0].Close;
        var to = last.Close;
        if (from <= 0) return null;
        var movePct = (to - from) / from * 100;
        if (Math.Abs(movePct) < o.MinMovePct) return null;

        var side = fell ? "PE" : "CE";
        var strike = Math.Round(to / step, MidpointRounding.AwayFromZero) * step;
        // OI at the END of a bar = at the end of its last minute (a 1-minute bar: its own minute).
        var endMinute = last.Time.ToUnixTimeSeconds() / 60 + tf - 1;
        var startMinute = bars[0].Time.ToUnixTimeSeconds() / 60 + tf - 1;

        var before = oiAt(side, strike, startMinute);
        var now = oiAt(side, strike, endMinute);
        if (before is not > 0 || now is null) return null;
        var changePct = (decimal)(now.Value - before.Value) / before.Value * 100;
        if (changePct < -o.FlatTolerancePct) return null;

        // A real level: big enough next to the rest of its side near price.
        var band = strikes.Where(k => Math.Abs(k - to) <= o.BandSteps * step).Distinct().ToList();
        var wallMax = band.Select(k => oiAt(side, k, endMinute) ?? 0).DefaultIfEmpty(0).Max();
        if (wallMax <= 0 || now.Value < o.MinWallShare * wallMax) return null;

        // The OI feed is alive: strikes around price did change over the window.
        var changed = 0;
        foreach (var k in band.Where(k => Math.Abs(k - to) <= o.AliveSteps * step))
            foreach (var s in new[] { "CE", "PE" })
                if (oiAt(s, k, startMinute) is { } a && oiAt(s, k, endMinute) is { } b && a != b) changed++;
        if (changed < o.AliveStrikes) return null;

        var zone = fell ? "Discount" : "Premium";
        var points = to - from;
        var verb = fell ? "fell" : "rose";
        var level = fell ? "support" : "resistance";
        var message =
            $"{underlying} spot {verb} {Math.Abs(points):0.#} pts ({Math.Abs(movePct):0.00}%) in {n * tf} min to {to:0.#}, but {side} OI at {strike:0} " +
            $"{(changePct > o.FlatTolerancePct ? "rose" : "held")} ({changePct:+0.0;-0.0}%, {before.Value:N0} → {now.Value:N0}) - {level} being defended, a {zone.ToLowerInvariant()} zone. " +
            "Wait for a confirming candle before entering.";
        return new PriceOiDivergence(underlying, last.Time, zone, side, strike, before.Value, now.Value, changePct, from, to, movePct, n * tf, message);
    }

    /// <summary>The session's COMPLETED candles of `barMinutes` (15) from 09:15 IST, of the last bar's IST day, from its
    /// closed 1-minute bars: a candle counts once its last minute has closed (one with a minute missing inside still
    /// counts - its OHLC from the minutes there); its Time is its start. Nothing of a candle still forming.</summary>
    public static IReadOnlyList<Candle> SessionCandles(IReadOnlyList<Candle> closed, int barMinutes)
    {
        if (closed.Count == 0 || barMinutes < 1) return [];
        var day = IstClock.IstDate(closed[^1].Time);
        var open = IstClock.AtIstTime(day, 9 * 60 + 15);
        var buckets = new SortedDictionary<long, List<Candle>>();
        var lastMinutes = new HashSet<long>();
        foreach (var c in closed)
        {
            if (IstClock.IstDate(c.Time) != day || c.Time < open) continue;
            var k = (long)Math.Floor((c.Time - open).TotalMinutes / barMinutes);
            if (!buckets.TryGetValue(k, out var list)) buckets[k] = list = [];
            list.Add(c);
            if ((long)Math.Round((c.Time - open).TotalMinutes) % barMinutes == barMinutes - 1) lastMinutes.Add(k);
        }
        return buckets.Where(b => lastMinutes.Contains(b.Key)).Select(b =>
        {
            var minutes = b.Value.OrderBy(c => c.Time).ToList();
            return new Candle(open.AddMinutes(b.Key * barMinutes), minutes[0].Open, minutes.Max(c => c.High), minutes.Min(c => c.Low), minutes[^1].Close);
        }).ToList();
    }
}
