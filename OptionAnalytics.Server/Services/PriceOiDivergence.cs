using OptionAnalytics.Server.Models;

namespace OptionAnalytics.Server.Services;

/// <summary>What counts as "price moved but OI did not follow". Every default is deliberately strict -
/// this is an alert, and a false one costs more than a missed one. Bound from the "OiDivergence"
/// configuration section.</summary>
public sealed class DivergenceOptions
{
    public bool Enabled { get; init; } = true;
    /// <summary>How many completed 1-minute bars the move is read over.</summary>
    public int Minutes { get; init; } = 3;
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
    /// <summary>A zone found is alerted only once this many completed minutes after it confirm it (see
    /// PriceOiDivergenceDetector.Confirm): no close beyond the move's low / high, price back away from the level, the
    /// strike's OI still holding. 0 = alert the moment it is found.</summary>
    public int ConfirmMinutes { get; init; } = 5;
    /// <summary>IST, start of the minute the move ends in: nothing before From (the open is noise) or from To.</summary>
    public int FromMinuteOfDay { get; init; } = 9 * 60 + 25;
    public int ToMinuteOfDay { get; init; } = 15 * 60 + 15;
    public bool Telegram { get; init; } = true;
}

/// <summary>Price fell (or rose) for the last Minutes minutes, yet the OI that should have given way at
/// the nearest strike did not: a falling price into a strike whose PUT OI is holding or growing is a
/// support being defended (a discount zone); a rising price into a strike whose CALL OI is holding or
/// growing is a resistance being defended (a premium zone). It is a prompt to look - not an order - and is
/// only sent once the minutes after it confirm it (ConfirmMinutes; the Confirm* fields say how).
/// Extreme is the move's lowest low (a discount zone) / highest high (a premium zone).</summary>
public sealed record PriceOiDivergence(
    string Underlying, DateTimeOffset BarTime, string Zone, string Side, decimal Strike,
    long OiBefore, long OiNow, decimal OiChangePct, decimal PriceFrom, decimal PriceTo, decimal PriceChangePct,
    int Minutes, string Message, decimal Extreme = 0,
    DateTimeOffset? ConfirmedBarTime = null, int ConfirmMinutes = 0, decimal? ConfirmPrice = null, long? OiConfirm = null, decimal? OiConfirmChangePct = null);

public enum DivergenceConfirmState { Waiting, Confirmed, Failed }

/// <summary>What the minutes after a zone say about it: still waiting, confirmed (Alert = the zone with its
/// confirmation), or failed (Reason).</summary>
public sealed record DivergenceConfirmation(DivergenceConfirmState State, PriceOiDivergence? Alert = null, string? Reason = null);

public static class PriceOiDivergenceDetector
{
    /// <param name="closed">Completed 1-minute spot bars, oldest first - the last Minutes + 1 are read.</param>
    /// <param name="step">Strike spacing.</param>
    /// <param name="strikes">The strikes with OI readings (any side).</param>
    /// <param name="oiAt">OI of (side "CE" / "PE", strike) as of the END of the given minute (unix minutes),
    /// or null when there is no recent enough reading.</param>
    public static PriceOiDivergence? Evaluate(
        string underlying, IReadOnlyList<Candle> closed, decimal step, IEnumerable<decimal> strikes,
        Func<string, decimal, long, long?> oiAt, DivergenceOptions o)
    {
        var n = o.Minutes;
        if (n < 1 || step <= 0 || closed.Count < n + 1) return null;
        var bars = closed.Skip(closed.Count - (n + 1)).ToList();

        // Consecutive minutes, none missing.
        for (var i = 1; i < bars.Count; i++)
            if (bars[i].Time - bars[i - 1].Time != TimeSpan.FromMinutes(1)) return null;

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
        var endMinute = last.Time.ToUnixTimeSeconds() / 60;
        var startMinute = bars[0].Time.ToUnixTimeSeconds() / 60;

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
        var extreme = fell ? bars.Min(b => b.Low) : bars.Max(b => b.High);
        var points = to - from;
        var verb = fell ? "fell" : "rose";
        var level = fell ? "support" : "resistance";
        var message =
            $"{underlying} spot {verb} {Math.Abs(points):0.#} pts ({Math.Abs(movePct):0.00}%) in {n} min to {to:0.#}, but {side} OI at {strike:0} " +
            $"{(changePct > o.FlatTolerancePct ? "rose" : "held")} ({changePct:+0.0;-0.0}%, {before.Value:N0} → {now.Value:N0}) - {level} being defended, a {zone.ToLowerInvariant()} zone. " +
            "Wait for a confirming candle before entering.";
        return new PriceOiDivergence(underlying, last.Time, zone, side, strike, before.Value, now.Value, changePct, from, to, movePct, n, message, extreme);
    }

    /// <summary>
    /// Whether the ConfirmMinutes completed 1-minute bars after the zone's own minute confirm it. Confirmed when all of:
    /// every one of those minutes is there (no gap); none of them CLOSED beyond the move's extreme (a discount zone: below
    /// its lowest low; a premium zone: above its highest high) - a wick through is allowed, a close is the level giving
    /// way; the last of them closed back away from the level (above the price the fall ended at / below the rise's); the
    /// strike's OI at the end of the last of them is still no more than FlatTolerancePct below what it was when the move
    /// began; and that last minute starts before ToMinuteOfDay. Failed as soon as one of them cannot hold any more (a close
    /// through the extreme fails it at once); Waiting until the minutes are there. Only completed bars and OI as of
    /// the end of the last of them are read.
    /// </summary>
    /// <param name="closed">Completed 1-minute spot bars, oldest first.</param>
    /// <param name="oiAt">As in Evaluate.</param>
    public static DivergenceConfirmation Confirm(PriceOiDivergence zone, IReadOnlyList<Candle> closed, Func<string, decimal, long, long?> oiAt, DivergenceOptions o)
    {
        var n = o.ConfirmMinutes;
        if (n <= 0) return new DivergenceConfirmation(DivergenceConfirmState.Confirmed, zone);
        var discount = zone.Zone == "Discount";
        var after = closed.Where(c => c.Time > zone.BarTime).OrderBy(c => c.Time).Take(n).ToList();
        var expected = zone.BarTime;
        foreach (var bar in after)
        {
            expected = expected.AddMinutes(1);
            if (bar.Time != expected) return Failed($"the {Ist(expected)} minute is missing");
            if (discount ? bar.Close < zone.Extreme : bar.Close > zone.Extreme)
                return Failed($"the {Ist(bar.Time)} minute closed at {bar.Close:0.#}, {(discount ? "below the low" : "above the high")} of {zone.Extreme:0.#}");
        }
        if (after.Count < n) return new DivergenceConfirmation(DivergenceConfirmState.Waiting);

        var last = after[^1];
        if (last.Time.ToOffset(IstClock.Offset).TimeOfDay.TotalMinutes >= o.ToMinuteOfDay) return Failed("too late in the day");
        var turned = discount ? last.Close > zone.PriceTo : last.Close < zone.PriceTo;
        if (!turned) return Failed($"spot is at {last.Close:0.#} after {n} min, not back {(discount ? "above" : "below")} {zone.PriceTo:0.#}");
        var oiNow = oiAt(zone.Side, zone.Strike, last.Time.ToUnixTimeSeconds() / 60);
        if (oiNow is null) return Failed($"no {zone.Side} OI reading at {zone.Strike:0}");
        var changePct = zone.OiBefore > 0 ? (decimal)(oiNow.Value - zone.OiBefore) / zone.OiBefore * 100 : 0;
        if (changePct < -o.FlatTolerancePct) return Failed($"{zone.Side} OI at {zone.Strike:0} unwound ({changePct:+0.0;-0.0}%)");

        var bounce = last.Close - zone.PriceTo;
        var verb = discount ? "fell" : "rose";
        var level = discount ? "support" : "resistance";
        var message =
            $"{zone.Underlying} {zone.Zone.ToLowerInvariant()} zone CONFIRMED after {n} min. Spot {verb} {Math.Abs(zone.PriceTo - zone.PriceFrom):0.#} pts ({Math.Abs(zone.PriceChangePct):0.00}%) " +
            $"in {zone.Minutes} min to {zone.PriceTo:0.#} by {Ist(zone.BarTime.AddMinutes(1))} into {zone.Side} OI at {zone.Strike:0} - {level} being defended. " +
            $"Since then: no close {(discount ? "below the low" : "above the high")} of {zone.Extreme:0.#}, spot back {(discount ? "up" : "down")} to {last.Close:0.#} ({bounce:+0.#;-0.#} pts) " +
            $"by {Ist(last.Time.AddMinutes(1))}, {zone.Side} OI at {zone.Strike:0} still {changePct:+0.0;-0.0}% ({zone.OiBefore:N0} → {oiNow.Value:N0}).";
        return new DivergenceConfirmation(DivergenceConfirmState.Confirmed, zone with
        {
            Message = message, ConfirmedBarTime = last.Time, ConfirmMinutes = n, ConfirmPrice = last.Close, OiConfirm = oiNow.Value, OiConfirmChangePct = changePct,
        });

        static DivergenceConfirmation Failed(string reason) => new(DivergenceConfirmState.Failed, null, reason);
        static string Ist(DateTimeOffset t) => t.ToOffset(IstClock.Offset).ToString("HH:mm", System.Globalization.CultureInfo.InvariantCulture);
    }
}

/// <summary>
/// Turns zones found into alerts: a zone is held until the minutes after it confirm it (Confirm), dropped as soon as they
/// cannot; the same zone of an underlying is not alerted again inside CooldownMinutes of the last one, and is not
/// looked at again while one is being confirmed. Not thread-safe - the caller locks.
/// </summary>
public sealed class DivergenceGate
{
    private readonly DivergenceOptions _o;
    private readonly Dictionary<(string Underlying, string Zone), PriceOiDivergence> _pending = new();
    private readonly Dictionary<(string Underlying, string Zone), DateTimeOffset> _lastAlert = new();

    public DivergenceGate(DivergenceOptions options) => _o = options;

    public IReadOnlyList<PriceOiDivergence> Pending => _pending.Values.ToList();

    /// <summary>A completed bar of <paramref name="underlying"/>: the zones waiting are re-checked first, then the zone
    /// found on this bar (Evaluate's result, or null) starts waiting. Returns what to alert now and what was dropped.</summary>
    public (IReadOnlyList<PriceOiDivergence> Alerts, IReadOnlyList<(PriceOiDivergence Zone, string Reason)> Dropped) OnBar(
        string underlying, IReadOnlyList<Candle> closed, Func<string, decimal, long, long?> oiAt, PriceOiDivergence? found)
    {
        var alerts = new List<PriceOiDivergence>();
        var dropped = new List<(PriceOiDivergence, string)>();
        foreach (var key in _pending.Keys.Where(k => k.Underlying == underlying).ToList())
        {
            var outcome = PriceOiDivergenceDetector.Confirm(_pending[key], closed, oiAt, _o);
            if (outcome.State == DivergenceConfirmState.Waiting) continue;
            var zone = _pending[key];
            _pending.Remove(key);
            if (outcome.Alert is { } confirmed) alerts.Add(Remember(confirmed));
            else dropped.Add((zone, outcome.Reason ?? "not confirmed"));
        }
        if (found is not null)
        {
            var key = (found.Underlying, found.Zone);
            var cooling = _lastAlert.TryGetValue(key, out var at) && found.BarTime - at < TimeSpan.FromMinutes(_o.CooldownMinutes);
            if (!cooling && !_pending.ContainsKey(key))
            {
                if (_o.ConfirmMinutes > 0) _pending[key] = found;
                else alerts.Add(Remember(found));
            }
        }
        return (alerts, dropped);
    }

    private PriceOiDivergence Remember(PriceOiDivergence alert)
    {
        _lastAlert[(alert.Underlying, alert.Zone)] = alert.BarTime;
        return alert;
    }
}
