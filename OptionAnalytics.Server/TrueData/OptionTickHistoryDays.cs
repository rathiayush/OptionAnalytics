using System.Collections.Concurrent;
using Microsoft.Extensions.Options;
using OptionAnalytics.Server.Services;

namespace OptionAnalytics.Server.TrueData;

/// <summary>
/// BIG OPTION ORDERS OF A PAST DAY for the Tick Flow page's replay (and OI Replay's spot chart), rebuilt from TrueData's TICK HISTORY of the option
/// contracts (tested on the trial account: one whole-day call a contract answers in ~2 s - time, ltp, quantity, OI and the best bid / ask - the trial keeps
/// today and the day before). The same <see cref="OptionBigOrderWatch"/> as the live stream reads the ticks in time order, so a replayed order is
/// the live order: its side from the quote before, how it hit the book, the OI change, the multiple of the option's own usual.
///
/// Which contracts: the nearest expiry that still has a chain (<see cref="OptionChains"/> - an expiry already gone from TrueData's master cannot be asked),
/// the strikes from ATM - N to ATM + N over the whole of that day's futures range (the futures day the page already replays), so the window follows the
/// ATM through the day; only the orders within ATM +- N of the ATM AT THAT TIME are kept (the ATM from the options' own put-call parity, else the futures).
/// It takes about a second a contract (TrueData's history is a few calls a second, one at a time here, a failed call tried once more) so the first ask for a
/// day builds in the background with progress; the answer is kept in memory (<see cref="MaxDays"/>), never on disk, and a failed build is not kept.
/// </summary>
public sealed class OptionTickHistoryDays
{
    public const int MaxDays = 4;
    public const int MaxEvents = 20_000;
    /// <summary>A replayed day keeps only the page's default size and over (the live stream keeps a looser floor and the page filters it).</summary>
    internal const decimal ReplayFloorLots = 30, ReplayFloorRatio = 3;
    private static readonly TimeSpan Open = new(9, 15, 0);
    private static readonly TimeSpan Close = new(15, 30, 0);

    private readonly ITrueDataHistoryApi? _api;
    private readonly TickHistoryDays _futures;
    private readonly ILogger<OptionTickHistoryDays> _logger;
    /// <summary>The most strikes a replay asks for (asked for - "15 each side from the ATM, not 64 contracts"): 15 calls + 15 puts = 30 contracts.</summary>
    public const int MaxStrikes = 15;

    private readonly ConcurrentDictionary<(string Underlying, DateOnly Day, int Strikes), Job> _jobs = new();
    /// <summary>Where the option chain comes from (TrueData's REST master; a test sets a fake).</summary>
    internal IOptionChainSource ChainSource { get; set; }
    /// <summary>The pause between two history calls (TrueData's limit is a few a second; a test sets none).</summary>
    internal TimeSpan CallGap { get; set; } = TimeSpan.FromMilliseconds(900);
    internal TimeSpan RetryGap { get; set; } = TimeSpan.FromSeconds(3);

    public OptionTickHistoryDays(IServiceProvider services, TickHistoryDays futures, IOptions<TrueDataOptions> options, ILogger<OptionTickHistoryDays> logger)
    {
        _api = services.GetService<ITrueDataHistoryApi>();
        _futures = futures;
        _logger = logger;
        ChainSource = new TrueDataOptionChainSource(options.Value);
    }

    public bool Available => _api is not null;

    internal sealed class Job
    {
        public volatile string State = "loading";
        public int Done, Total, Failed;
        public string? Error, Expiry;
        public decimal Step;
        public IReadOnlyList<BigOrderEvent> Events = Array.Empty<BigOrderEvent>();
        public DateTimeOffset At = DateTimeOffset.UtcNow;
    }

    /// <summary>State: "loading" (Done of Total contracts), "ready" (Events) or "failed" (Error).</summary>
    public sealed record Status(string State, int Done, int Total, int Failed, string? Error, string? Expiry, decimal Step, IReadOnlyList<BigOrderEvent> Events);

    /// <summary>The day's state - and the start of its build the first time it is asked (in the background; ask again for progress).</summary>
    public Status Request(TrueDataLiveInstrument instrument, DateOnly day, int strikes)
    {
        if (_api is null) return new Status("failed", 0, 0, 0, "Replay needs TrueData's tick history: set TrueData:Enabled true (with the login) as well as TrueData:Live:Enabled.", null, 0, Array.Empty<BigOrderEvent>());
        strikes = Math.Clamp(strikes, 1, 15);
        var key = (instrument.Underlying.ToUpperInvariant(), day, strikes);
        if (_jobs.TryGetValue(key, out var existing))
        {
            if (existing.State != "failed" || DateTimeOffset.UtcNow - existing.At < TimeSpan.FromSeconds(20)) return Snapshot(existing);
            _jobs.TryRemove(key, out _);   // a failed build is asked again - but not every poll
        }
        var job = _jobs.GetOrAdd(key, _ => new Job());
        if (job.Total == 0 && job.Done == 0 && job.State == "loading" && Interlocked.CompareExchange(ref job.Total, -1, 0) == 0)
            _ = Task.Run(async () =>
            {
                try { await BuildAsync(job, instrument, day, strikes, CancellationToken.None); }
                catch (Exception ex)
                {
                    _logger.LogWarning(ex, "Option tick history for {Underlying} {Day} failed.", instrument.Underlying, day);
                    job.Error = ex.Message; job.State = "failed"; job.At = DateTimeOffset.UtcNow;
                }
                Trim();
            });
        return Snapshot(job);
    }

    private static Status Snapshot(Job j) => new(j.State, j.Done, Math.Max(0, j.Total), j.Failed, j.Error, j.Expiry, j.Step, j.State == "ready" ? j.Events : Array.Empty<BigOrderEvent>());

    private void Trim()
    {
        while (_jobs.Count > MaxDays)
            if (!_jobs.TryRemove(_jobs.OrderBy(kv => kv.Value.At).First().Key, out _)) break;
    }

    internal async Task BuildAsync(Job job, TrueDataLiveInstrument instrument, DateOnly day, int strikes, CancellationToken token)
    {
        // The day's futures range: where the ATM went.
        var futures = await _futures.DayAsync(instrument, day, token);
        if (futures.Book is null) { job.Error = futures.Error ?? "no futures day"; job.State = "failed"; job.At = DateTimeOffset.UtcNow; return; }
        var bars = futures.Book.Snapshot(1, long.MaxValue, 1, 1).Bars;
        if (bars.Count == 0) { job.Error = "the futures day has no minutes"; job.State = "failed"; job.At = DateTimeOffset.UtcNow; return; }
        decimal low = bars.Min(b => b.Low), high = bars.Max(b => b.High);
        var closeAt = bars.ToDictionary(b => b.Time, b => b.Close);

        // The nearest expiry that still has a chain - from the day itself (an expiry already past is not in TrueData's master).
        var found = await OptionChains.FindNearestAsync(ChainSource, instrument.Underlying, day, token);
        if (found is null) { job.Error = $"No {instrument.Underlying} option chain is listed on TrueData from {day:dd MMM}"; job.State = "failed"; job.At = DateTimeOffset.UtcNow; return; }
        var step = OptionChains.StepOf(found.Value.Contracts);
        var from = Math.Floor((low - strikes * step) / step) * step;
        var to = Math.Ceiling((high + strikes * step) / step) * step;
        // At most MaxStrikes strikes (calls and puts each) - the ones nearest the middle of the day's range - so a replay asks 30 contracts, not 60+.
        var mid = (low + high) / 2;
        var keep = found.Value.Contracts.Where(c => c.Strike >= from && c.Strike <= to).Select(c => c.Strike).Distinct()
            .OrderBy(k => Math.Abs(k - mid)).Take(MaxStrikes).ToHashSet();
        var wanted = found.Value.Contracts.Where(c => keep.Contains(c.Strike)).OrderBy(c => Math.Abs(c.Strike - mid)).ToList();
        job.Expiry = found.Value.Expiry.ToString("yyyy-MM-dd"); job.Step = step;
        job.Total = wanted.Count;
        if (wanted.Count == 0) { job.Error = "no option contract in the day's range"; job.State = "failed"; job.At = DateTimeOffset.UtcNow; return; }

        // One whole-day call a contract.
        var loaded = new List<(OptionContract Contract, IReadOnlyList<TrueDataTick> Ticks, bool PerTick)>(wanted.Count);
        foreach (var contract in wanted)
        {
            token.ThrowIfCancellationRequested();
            var parsed = await FetchAsync(contract.Symbol, day, token);
            if (parsed is { Ticks.Count: > 0 }) loaded.Add((contract, parsed.Ticks, parsed.VolumeWasPerTick)); else job.Failed++;
            job.Done++;
            if (CallGap > TimeSpan.Zero) await Task.Delay(CallGap, token);
        }
        if (loaded.Count == 0) { job.Error = "TrueData had no option ticks for that day (it keeps only the last few days)"; job.State = "failed"; job.At = DateTimeOffset.UtcNow; return; }

        job.Events = Detect(loaded, closeAt, step, strikes, keep);
        job.State = "ready"; job.At = DateTimeOffset.UtcNow;
        _logger.LogInformation("Option ticks of {Underlying} {Day}: {Contracts} contracts ({Failed} without data), {Events} big orders.", instrument.Underlying, day, loaded.Count, job.Failed, job.Events.Count);
    }

    private async Task<TrueDataTickCsv.Result?> FetchAsync(string symbol, DateOnly day, CancellationToken token)
    {
        for (var attempt = 1; attempt <= 3; attempt++)
        {
            try
            {
                var csv = await _api!.GetTicksWithBidAskAsync(symbol, day.ToDateTime(TimeOnly.FromTimeSpan(Open)), day.ToDateTime(TimeOnly.FromTimeSpan(Close)), token);
                var parsed = TrueDataTickCsv.Parse(csv);
                if (parsed.Ticks.Count > 0) return parsed;
            }
            catch (OperationCanceledException) { throw; }
            catch (Exception ex) { _logger.LogDebug("TrueData ticks for {Symbol}: {Error}", symbol, ex.Message); }
            // TrueData's history answers some calls with a server error that works a few seconds later.
            if (attempt < 3 && RetryGap > TimeSpan.Zero) await Task.Delay(RetryGap * attempt, token);
        }
        return null;
    }

    /// <summary>The ticks of every contract in time order through one <see cref="OptionBigOrderWatch"/>; the ATM follows the options' own parity (else the futures'),
    /// and an order outside ATM +- <paramref name="strikes"/> of the ATM at its time is left out. Internal for the tests.</summary>
    internal static IReadOnlyList<BigOrderEvent> Detect(IReadOnlyList<(OptionContract Contract, IReadOnlyList<TrueDataTick> Ticks, bool PerTick)> loaded,
        IReadOnlyDictionary<DateTimeOffset, decimal> futuresCloseByMinute, decimal step, int strikes, ISet<decimal>? onlyStrikes = null)
    {
        var watch = new OptionBigOrderWatch { Step = step, MaxEvents = 1, FloorLots = ReplayFloorLots, FloorRatio = ReplayFloorRatio };
        var flat = new List<(DateTimeOffset Time, int Index, int Tick, long Traded)>();
        for (var i = 0; i < loaded.Count; i++)
        {
            watch.Track(loaded[i].Contract);
            long previous = loaded[i].PerTick ? 0 : -1;       // a running total's first tick only sets the baseline
            var ticks = loaded[i].Ticks;
            for (var k = 0; k < ticks.Count; k++)
            {
                var traded = previous < 0 ? 0 : Math.Max(0, ticks[k].Volume - previous);
                previous = ticks[k].Volume;
                flat.Add((ticks[k].Time, i, k, traded));
            }
        }
        flat.Sort((a, b) => a.Time != b.Time ? a.Time.CompareTo(b.Time) : a.Index.CompareTo(b.Index));

        var events = new List<BigOrderEvent>();
        decimal lastFutures = 0;
        var atmAt = DateTimeOffset.MinValue;
        foreach (var (time, index, tickIndex, traded) in flat)
        {
            // The ATM, worked out again every 30 s of the data's own time.
            if (time - atmAt >= TimeSpan.FromSeconds(30))
            {
                atmAt = time;
                var minute = new DateTimeOffset(time.Year, time.Month, time.Day, time.Hour, time.Minute, 0, time.Offset);
                if (futuresCloseByMinute.TryGetValue(minute, out var f)) lastFutures = f;
                if (watch.ImpliedAtm(time) is { } implied) watch.Atm = implied.Strike;
                else if (lastFutures > 0) watch.Atm = Math.Round(lastFutures / step) * step;
            }
            var c = loaded[index].Contract;
            var t = loaded[index].Ticks[tickIndex];
            if (traded > 0 && t.Ltp > 0)
            {
                var made = watch.OnTrade(new TrueDataTrade(c.SymbolId, t.Time, t.Ltp, traded, t.Ltp, 0, 0, 0, 0, 0, t.OpenInterest, "", 0, t.Bid, t.BidQty, t.Ask, t.AskQty), t.Time);
                if (made is not null && Math.Abs(made.AtmDistance) <= strikes && (onlyStrikes is null || onlyStrikes.Contains(c.Strike)) && events.Count < HardCap) events.Add(made);
            }
            else if (t.Bid > 0 && t.Ask > 0) watch.OnQuote(c.SymbolId, t.Bid, t.BidQty, t.Ask, t.AskQty);
        }
        // A day over the cap keeps its BIGGEST orders (the first ones only would end the day at 11:00), oldest first.
        if (events.Count > MaxEvents) events = events.OrderByDescending(e => e.Value).Take(MaxEvents).OrderBy(e => e.Time).ThenBy(e => e.Seq).ToList();
        return events;
    }
    private const int HardCap = 200_000;
}
