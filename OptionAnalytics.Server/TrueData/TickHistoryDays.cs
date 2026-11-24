using System.Collections.Concurrent;
using Microsoft.Extensions.Options;

namespace OptionAnalytics.Server.TrueData;

/// <summary>
/// A PAST day for the Tick Flow page's replay, rebuilt from TrueData's tick history (GET history.truedata.in/getticks?bidask=1 - the
/// trial keeps today and the day before, a subscription longer) through the same TickBook the live feed fills, so a replayed day is
/// read exactly as the live one. A history tick has the day's running volume (or the tick's own - TrueDataTickCsv turns either into a
/// running total): its rise is that trade's quantity; a tick that traded nothing is a quote. The first tick only sets the volume
/// baseline when the volume is a running total. Days are kept in memory (<see cref="MaxDays"/>), never on disk; TrueData is asked for
/// a day once, and a failed ask is not kept. Needs TrueData:Enabled (the history source) - without it a replay says so.
/// </summary>
public sealed class TickHistoryDays
{
    public const int MaxDays = 6;
    private static readonly TimeSpan Open = new(9, 15, 0);
    private static readonly TimeSpan Close = new(15, 30, 0);

    private readonly ITrueDataHistoryApi? _api;
    private readonly ILogger<TickHistoryDays> _logger;
    private readonly ConcurrentDictionary<(string Underlying, DateOnly Day), (TickBook Book, DateTimeOffset At)> _days = new();
    private readonly SemaphoreSlim _building = new(1, 1);

    public TickHistoryDays(IServiceProvider services, ILogger<TickHistoryDays> logger)
    {
        _api = services.GetService<ITrueDataHistoryApi>();
        _logger = logger;
    }

    public bool Available => _api is not null;

    public sealed record Result(TickBook? Book, string? Error);

    public async Task<Result> DayAsync(TrueDataLiveInstrument instrument, DateOnly day, CancellationToken cancellationToken)
    {
        if (_api is null) return new Result(null, "Replay needs TrueData's tick history: set TrueData:Enabled true (with the login) as well as TrueData:Live:Enabled.");
        var key = (instrument.Underlying.ToUpperInvariant(), day);
        if (_days.TryGetValue(key, out var hit)) return new Result(hit.Book, null);
        await _building.WaitAsync(cancellationToken);
        try
        {
            if (_days.TryGetValue(key, out hit)) return new Result(hit.Book, null);
            string csv;
            try { csv = await _api.GetTicksWithBidAskAsync(instrument.Symbol, day.ToDateTime(TimeOnly.FromTimeSpan(Open)), day.ToDateTime(TimeOnly.FromTimeSpan(Close)), cancellationToken); }
            catch (OperationCanceledException) { throw; }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "TrueData ticks for {Symbol} on {Day} failed.", instrument.Symbol, day);
                return new Result(null, $"TrueData {instrument.Symbol}: {ex.Message}");
            }
            var parsed = TrueDataTickCsv.Parse(csv);
            var ticks = parsed.Ticks.Where(t => DateOnly.FromDateTime(t.Time.DateTime) == day && t.Time.TimeOfDay >= Open && t.Time.TimeOfDay <= Close).ToList();
            if (ticks.Count == 0) return new Result(null, $"TrueData {instrument.Symbol}: {parsed.Error ?? "no ticks for that day (it keeps only the last few days)"}");
            var book = Build(instrument, ticks, parsed.VolumeWasPerTick);
            _days[key] = (book, DateTimeOffset.UtcNow);
            while (_days.Count > MaxDays) _days.TryRemove(_days.OrderBy(kv => kv.Value.At).First().Key, out _);
            _logger.LogInformation("Rebuilt {Symbol} {Day} for Tick Flow replay from {Ticks} TrueData ticks.", instrument.Symbol, day, ticks.Count);
            return new Result(book, null);
        }
        finally { _building.Release(); }
    }

    /// <summary>A day's ticks through a fresh TickBook: the rise in the running volume is a trade at the tick's price, no rise a quote.</summary>
    internal static TickBook Build(TrueDataLiveInstrument instrument, IReadOnlyList<TrueDataTick> ticks, bool volumeWasPerTick)
    {
        var book = new TickBook(instrument.Underlying.ToUpperInvariant(), instrument.Symbol, instrument.LotSize, instrument.TickSize);
        long previous = volumeWasPerTick ? 0 : -1; // a running total's first tick only sets the baseline
        foreach (var t in ticks)
        {
            var traded = previous < 0 ? 0 : Math.Max(0, t.Volume - previous);
            previous = t.Volume;
            if (traded > 0 && t.Ltp > 0) book.OnTrade(t.Time, 0, t.Ltp, traded, t.Bid, t.BidQty, t.Ask, t.AskQty, volumeWasPerTick ? 0 : t.Volume);
            else if (t.Bid > 0 && t.Ask > 0) book.OnQuote(t.Time, t.Bid, t.BidQty, t.Ask, t.AskQty);
        }
        return book;
    }
}
