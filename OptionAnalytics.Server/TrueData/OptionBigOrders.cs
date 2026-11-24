using System.Globalization;

namespace OptionAnalytics.Server.TrueData;

/// <summary>One option contract of TrueData's master (getOptionChain): its streaming symbol id and name ("NIFTY26120125000CE").</summary>
public sealed record OptionContract(string SymbolId, string Symbol, decimal Strike, bool Call, DateOnly Expiry, int LotSize);

/// <summary>One BIG ORDER on an option, from TrueData's live ticks: the tick's own quantity (the day's volume rise when several trades were
/// bundled in it), the side the quote BEFORE it gives, how it hit the book and what the open interest did since the option's tick before.</summary>
public sealed record BigOrderEvent(
    long Seq, DateTimeOffset Time, string Symbol, decimal Strike, string Type, long Qty, decimal Lots, decimal Price, bool Buy, decimal Value,
    decimal Ratio, decimal TouchRatio, bool Through, bool Bundled, long? OiChange, decimal MovePct, int AtmDistance, int LotSize);

/// <summary>Where an option chain comes from (TrueData's REST master; a fake in the tests).</summary>
public interface IOptionChainSource
{
    /// <summary>The chain of <paramref name="underlying"/> for <paramref name="expiry"/>; empty when it has none (not an expiry).</summary>
    Task<IReadOnlyList<OptionContract>> GetAsync(string underlying, DateOnly expiry, CancellationToken token);
}

/// <summary>TrueData's getOptionChain (api.truedata.in): "symbolid,symbol,series,isin,exchange,lotsize,strike,expiry,..." one row an option,
/// series CE / PE, expiry dd-MM-yyyy. The login is TrueData:UserId / Password; calls are spaced (their REST limit is a few a second).</summary>
public sealed class TrueDataOptionChainSource : IOptionChainSource
{
    private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(30) };
    private readonly TrueDataOptions _options;
    private DateTimeOffset _lastCall = DateTimeOffset.MinValue;
    private readonly SemaphoreSlim _gate = new(1, 1);

    public TrueDataOptionChainSource(TrueDataOptions options) { _options = options; }

    public async Task<IReadOnlyList<OptionContract>> GetAsync(string underlying, DateOnly expiry, CancellationToken token)
    {
        await _gate.WaitAsync(token);
        try
        {
            var wait = TimeSpan.FromMilliseconds(1100) - (DateTimeOffset.UtcNow - _lastCall);
            if (wait > TimeSpan.Zero) await Task.Delay(wait, token);
            var url = $"https://api.truedata.in/getOptionChain?user={Uri.EscapeDataString(_options.UserId)}&password={Uri.EscapeDataString(_options.Password)}&symbol={Uri.EscapeDataString(underlying)}&expiry={expiry:yyyyMMdd}&csv=true";
            _lastCall = DateTimeOffset.UtcNow;
            using var response = await Http.GetAsync(url, token);
            response.EnsureSuccessStatusCode();
            return ParseCsv(await response.Content.ReadAsStringAsync(token));
        }
        finally { _gate.Release(); }
    }

    /// <summary>Pure: the rows of a getOptionChain CSV (an answer with no rows - "No Record found" - is an empty list).</summary>
    public static IReadOnlyList<OptionContract> ParseCsv(string? csv)
    {
        var rows = new List<OptionContract>();
        if (string.IsNullOrWhiteSpace(csv)) return rows;
        var lines = csv.Replace("\r", "").Split('\n', StringSplitOptions.RemoveEmptyEntries);
        if (lines.Length < 2 || !lines[0].StartsWith("symbolid", StringComparison.OrdinalIgnoreCase)) return rows;
        var header = lines[0].Split(',').Select(h => h.Trim().ToLowerInvariant()).ToList();
        int Col(string name) => header.IndexOf(name);
        int id = Col("symbolid"), sym = Col("symbol"), series = Col("series"), lot = Col("lotsize"), strike = Col("strike"), exp = Col("expiry");
        if (new[] { id, sym, series, strike, exp }.Any(c => c < 0)) return rows;
        foreach (var line in lines.Skip(1))
        {
            var f = line.Split(',');
            if (f.Length <= new[] { id, sym, series, strike, exp }.Max()) continue;
            var type = f[series].Trim().ToUpperInvariant();
            if (type is not ("CE" or "PE")) continue;
            if (!decimal.TryParse(f[strike], NumberStyles.Float, CultureInfo.InvariantCulture, out var k)) continue;
            if (!DateOnly.TryParseExact(f[exp].Trim(), "dd-MM-yyyy", CultureInfo.InvariantCulture, DateTimeStyles.None, out var e)) continue;
            var lots = lot >= 0 && lot < f.Length && int.TryParse(f[lot], NumberStyles.Integer, CultureInfo.InvariantCulture, out var l) && l > 0 ? l : 1;
            rows.Add(new OptionContract(f[id].Trim(), f[sym].Trim(), k, type == "CE", e, lots));
        }
        return rows;
    }
}

/// <summary>
/// BIG ORDERS ON OPTIONS from TrueData's live ticks (the Tick Flow page's "Big option orders"; nothing of Dhan's - asked for: "ignore
/// dhan on live tick data ... create big order punch trades from option ... the best possible way with live tick data").
///
/// What a TrueData tick is: a snapshot about every second (history: 0.4 ticks a second on NIFTY futures) carrying the quantity traded
/// since the one before - often several trades - with the best bid / ask and their sizes, the day's volume (TTQ) and the open interest.
/// So an order here is a tick's quantity, never a single print; when the day's volume rose by more than the tick's own last-trade quantity,
/// the RISE is taken (the bundled trades - <see cref="BigOrderEvent.Bundled"/>). For each tick of each option it keeps:
///  - the SIDE from the quote BEFORE it (at / through the ask = bought, at / through the bid = sold, inside the nearer half, then the tick rule);
///  - HOW it hit the book: its size against the size shown at the touch it took (<c>TouchRatio</c> - over 1 = it ate the whole touch) and
///    whether its price went THROUGH the touch (a sweep);
///  - the option's OWN usual tick (the median of its last 50 ticks' quantity) and the multiple (<c>Ratio</c>);
///  - the open interest change since the option's tick before (new positions opening or closing - with the side it reads as the page's
///    long build-up / short build-up / covering / unwinding);
///  - the move of the premium from the tick before.
/// An event is kept when it is at least <see cref="FloorLots"/> lots and, once the option has <see cref="MinHistory"/> ticks, at least
/// <see cref="FloorRatio"/> x its usual - a loose floor: the page filters finer. Memory only; a new IST day starts empty.
/// </summary>
public sealed class OptionBigOrderWatch
{
    public const int Capacity = 5000, History = 50, MinHistory = 5;
    private static readonly TimeSpan Ist = TimeSpan.FromMinutes(330);

    private readonly object _lock = new();
    private readonly Dictionary<string, State> _states = new(StringComparer.Ordinal);
    private readonly List<BigOrderEvent> _events = new();
    private long _seq, _ticks;
    private int _stateCount;   // distinct options (an alias is a second key to the same state)
    private DateOnly? _day;
    private DateTimeOffset? _lastTickAt;

    public decimal FloorLots { get; set; } = 10;
    public decimal FloorRatio { get; set; } = 2;
    /// <summary>The strike the window is centred on and the strike step - for each event's distance from the ATM.</summary>
    public decimal Atm { get; set; }
    public decimal Step { get; set; } = 50;

    private sealed class State
    {
        public OptionContract Contract = null!;
        public decimal Bid, Ask, LastPrice;
        public long BidQty, AskQty, LastTtq, LastOi;
        public bool LastBuy = true;
        public DateTimeOffset? LastTickAt;
        public readonly Queue<long> Recent = new();
    }

    public void Track(OptionContract contract)
    {
        lock (_lock)
            if (!_states.ContainsKey(contract.SymbolId)) { _states[contract.SymbolId] = new State { Contract = contract }; _stateCount++; }
    }

    public void Untrack(string symbolId)
    {
        lock (_lock)
        {
            if (!_states.TryGetValue(symbolId, out var state)) return;
            foreach (var key in _states.Where(kv => ReferenceEquals(kv.Value, state)).Select(kv => kv.Key).ToList()) _states.Remove(key);
            _stateCount--;
        }
    }

    public bool Tracks(string symbolId) { lock (_lock) return _states.ContainsKey(symbolId); }

    /// <summary>The id the feed uses for <paramref name="symbol"/> when its subscribe reply names it differently from the master.</summary>
    public void Alias(string symbol, string symbolId)
    {
        lock (_lock)
        {
            var existing = _states.FirstOrDefault(s => s.Value.Contract.Symbol == symbol);
            if (existing.Value is { } state && existing.Key != symbolId) _states[symbolId] = state;
        }
    }

    public int TrackedCount { get { lock (_lock) return _stateCount; } }

    public void Clear() { lock (_lock) { _states.Clear(); _stateCount = 0; _events.Clear(); _ticks = 0; _lastTickAt = null; } }

    /// <summary>A best bid / ask update with no trade.</summary>
    public void OnQuote(string symbolId, decimal bid, long bidQty, decimal ask, long askQty)
    {
        lock (_lock)
        {
            if (!_states.TryGetValue(symbolId, out var s)) return;
            s.Bid = bid; s.BidQty = bidQty; s.Ask = ask; s.AskQty = askQty;
        }
    }

    /// <summary>One trade tick of a tracked option. Returns the big order it makes, or null.</summary>
    public BigOrderEvent? OnTrade(TrueDataTrade t, DateTimeOffset time)
    {
        lock (_lock)
        {
            if (!_states.TryGetValue(t.SymbolId, out var s)) return null;
            var day = DateOnly.FromDateTime(time.ToOffset(Ist).DateTime);
            if (_day != day) { _events.Clear(); _day = day; foreach (var st in _states.Values) { st.Recent.Clear(); st.LastTtq = 0; st.LastOi = 0; } }
            _ticks++;
            _lastTickAt = time;

            // The tick's quantity: its own last trade, or the rise of the day's volume when that is more (trades bundled in the snapshot).
            var ltq = t.Quantity;
            var rise = s.LastTtq > 0 && t.TotalVolume > 0 ? t.TotalVolume - s.LastTtq : 0;
            var bundled = rise > ltq;
            var qty = bundled ? rise : ltq;
            var lotSize = Math.Max(1, s.Contract.LotSize);

            BigOrderEvent? made = null;
            // A quantity of one on a lot-sized contract is TrueData's day-high / low update, not a trade.
            if (qty > 1 || lotSize == 1)
            {
                var buy = TickBook.Side(t.Price, s.Bid, s.Ask, s.LastPrice, s.LastBuy);
                var lots = (decimal)qty / lotSize;
                // The cheap test first: most ticks are small, and only a candidate pays for the median of the option's usual.
                if (lots >= FloorLots)
                {
                    decimal ratio = 0;
                    if (s.Recent.Count >= MinHistory)
                    {
                        var sorted = s.Recent.ToArray();
                        Array.Sort(sorted);
                        var median = sorted.Length % 2 == 1 ? sorted[sorted.Length / 2] : (sorted[sorted.Length / 2 - 1] + sorted[sorted.Length / 2]) / 2.0;
                        if (median > 0) ratio = (decimal)(qty / median);
                    }
                    if (ratio == 0 || ratio >= FloorRatio)
                    {
                        var quotes = s.Bid > 0 && s.Ask > s.Bid;
                        var touchQty = buy ? s.AskQty : s.BidQty;
                        var through = quotes && (buy ? t.Price > s.Ask : t.Price < s.Bid);
                        long? oiChange = t.OpenInterest > 0 && s.LastOi > 0 ? t.OpenInterest - s.LastOi : null;
                        var move = s.LastPrice > 0 ? (t.Price - s.LastPrice) / s.LastPrice * 100 : 0;
                        var distance = Step > 0 && Atm > 0 ? (int)Math.Round((s.Contract.Strike - Atm) / Step) : 0;
                        made = new BigOrderEvent(++_seq, time, s.Contract.Symbol, s.Contract.Strike, s.Contract.Call ? "CE" : "PE", qty, lots, t.Price, buy, t.Price * qty,
                            ratio, touchQty > 0 ? (decimal)qty / touchQty : 0, through, bundled, oiChange, move, distance, lotSize);
                        _events.Add(made);
                        if (_events.Count > Capacity) _events.RemoveRange(0, _events.Count - Capacity);
                    }
                }
                s.LastBuy = buy;
                if (qty > 0) { s.Recent.Enqueue(qty); while (s.Recent.Count > History) s.Recent.Dequeue(); }
            }
            // The packet's own quote is the one AFTER the trade: it is the "before" of the next tick.
            if (t.Bid > 0 && t.Ask > 0) { s.Bid = t.Bid; s.BidQty = t.BidQty; s.Ask = t.Ask; s.AskQty = t.AskQty; }
            if (t.Price > 0) s.LastPrice = t.Price;
            if (t.TotalVolume > 0) s.LastTtq = t.TotalVolume;
            if (t.OpenInterest > 0) s.LastOi = t.OpenInterest;
            s.LastTickAt = time;
            return made;
        }
    }

    /// <summary>The events after <paramref name="seq"/> (the newest <paramref name="limit"/> of them), oldest first.</summary>
    public IReadOnlyList<BigOrderEvent> Since(long seq, int limit = 1000)
    {
        lock (_lock)
        {
            // Sequences only grow along the list: a binary search for the first one after `seq`, not a scan of every event on every poll.
            int lo = 0, hi = _events.Count;
            while (lo < hi) { var mid = (lo + hi) >> 1; if (_events[mid].Seq > seq) hi = mid; else lo = mid + 1; }
            if (lo >= _events.Count) return Array.Empty<BigOrderEvent>();
            var take = Math.Min(limit, _events.Count - lo);
            return _events.GetRange(_events.Count - take, take);
        }
    }

    public (long LastSeq, long Ticks, DateTimeOffset? LastTickAt, int Tracked) Meta()
    {
        lock (_lock) return (_seq, _ticks, _lastTickAt, _stateCount);
    }

    /// <summary>The ATM the options themselves show: the strike where the call and the put cost the same (put-call parity) among options
    /// that ticked in the last two minutes, and the forward it implies (strike + call - put). Null with no such pair.</summary>
    public (decimal Strike, decimal Forward)? ImpliedAtm(DateTimeOffset now)
    {
        lock (_lock)
        {
            (decimal Strike, decimal Forward, decimal Gap)? best = null;
            foreach (var group in _states.Values.Distinct().Where(s => s.LastPrice > 0 && s.LastTickAt is { } at && now - at <= TimeSpan.FromMinutes(2)).GroupBy(s => s.Contract.Strike))
            {
                var ce = group.FirstOrDefault(s => s.Contract.Call);
                var pe = group.FirstOrDefault(s => !s.Contract.Call);
                if (ce is null || pe is null) continue;
                var gap = Math.Abs(ce.LastPrice - pe.LastPrice);
                if (best is null || gap < best.Value.Gap) best = (group.Key, group.Key + ce.LastPrice - pe.LastPrice, gap);
            }
            return best is { } b ? (b.Strike, b.Forward) : null;
        }
    }
}
