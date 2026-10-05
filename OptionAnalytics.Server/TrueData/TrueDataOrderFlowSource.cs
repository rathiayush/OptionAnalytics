using System.Collections.Concurrent;
using System.Globalization;
using Microsoft.Extensions.Options;
using OptionAnalytics.Server.Dhan;
using OptionAnalytics.Server.Services.OrderFlow;

namespace OptionAnalytics.Server.TrueData;

/// <summary>
/// Rebuilds a past Order Flow day from TrueData's tick history (see TrueDataOptions) - used by
/// OrderFlowHistory only when the server holds no exact day and TrueData:Enabled is true (otherwise this
/// class is never registered).
///
/// Every tick goes through a fresh OrderFlowEngine exactly like a live tick: the change in the day's
/// traded volume is a trade at the last price, classified buy / sell against the bid / ask of the ticks
/// BEFORE it (the engine's Lee-Ready rule - quote, midpoint, then tick rule), so the footprint, delta,
/// big prints and tape come out the way the live day would have - only coarser where TrueData's ticks
/// bundle several trades. There is no book: TrueData has no NSE depth, so the day has no heatmap or DOM.
/// Days are kept in memory (TrueDataOptions.MaxCachedDays), never on disk.
/// </summary>
public sealed class TrueDataOrderFlowSource
{
    private static readonly TimeSpan Open = new(9, 15, 0);
    private static readonly TimeSpan Close = new(15, 30, 0);

    private readonly ITrueDataHistoryApi _api;
    private readonly TrueDataOptions _options;
    private readonly ILogger<TrueDataOrderFlowSource> _logger;
    private readonly ConcurrentDictionary<(uint SecurityId, DateOnly Day), (OrderFlowEngine Engine, string Symbol, DateTimeOffset BuiltAt)> _days = new();
    private readonly SemaphoreSlim _building = new(1, 1);

    public TrueDataOrderFlowSource(ITrueDataHistoryApi api, IOptions<TrueDataOptions> options, ILogger<TrueDataOrderFlowSource> logger)
    {
        _api = api;
        _options = options.Value;
        _logger = logger;
    }

    public sealed record Result(OrderFlowEngine? Engine, string? Symbol, string? Error, int Ticks = 0);

    /// <summary>Whether TrueData can still have this day's ticks: a past day (or today) within
    /// TickHistoryDays.</summary>
    public bool Covers(DateOnly day, DateOnly today) => _options.IsConfigured && day <= today && day >= today.AddDays(-Math.Max(1, _options.TickHistoryDays));

    /// <summary>The TrueData symbol of a futures contract (NIFTY25OCTFUT).</summary>
    public static string ContractSymbol(DhanFuturesInstrument contract, string format) =>
        string.Format(CultureInfo.InvariantCulture, format, contract.Underlying.ToUpperInvariant(), contract.Expiry.ToDateTime(TimeOnly.MinValue)).ToUpperInvariant();

    /// <summary>A day already rebuilt (no fetch) - for the tape of a day the page has loaded.</summary>
    public OrderFlowEngine? Cached(uint securityId, DateOnly day) => _days.TryGetValue((securityId, day), out var hit) ? hit.Engine : null;

    public async Task<Result> DayAsync(DhanFuturesInstrument contract, DateOnly day, bool frontMonth, CancellationToken cancellationToken)
    {
        var today = IstClock.Today();
        var key = (contract.SecurityId, day);
        // A past day never changes; today's is rebuilt after a minute.
        if (_days.TryGetValue(key, out var hit) && (day < today || DateTimeOffset.UtcNow - hit.BuiltAt < TimeSpan.FromMinutes(1)))
            return new Result(hit.Engine, hit.Symbol, null);

        await _building.WaitAsync(cancellationToken);
        try
        {
            if (_days.TryGetValue(key, out hit) && (day < today || DateTimeOffset.UtcNow - hit.BuiltAt < TimeSpan.FromMinutes(1)))
                return new Result(hit.Engine, hit.Symbol, null);

            var from = day.ToDateTime(TimeOnly.FromTimeSpan(Open));
            var to = day.ToDateTime(TimeOnly.FromTimeSpan(Close));
            var symbols = new List<string> { ContractSymbol(contract, _options.FuturesSymbolFormat) };
            if (frontMonth) symbols.Add($"{contract.Underlying.ToUpperInvariant()}-I");

            string? lastError = null;
            foreach (var symbol in symbols)
            {
                string csv;
                try { csv = await _api.GetTicksWithBidAskAsync(symbol, from, to, cancellationToken); }
                catch (OperationCanceledException) { throw; }
                catch (Exception ex)
                {
                    _logger.LogWarning(ex, "TrueData ticks for {Symbol} on {Day} failed.", symbol, day);
                    lastError = $"TrueData {symbol}: {ex.Message}";
                    continue;
                }
                var parsed = TrueDataTickCsv.Parse(csv);
                var ticks = parsed.Ticks.Where(t => DateOnly.FromDateTime(t.Time.DateTime) == day && t.Time.TimeOfDay >= Open && t.Time.TimeOfDay <= Close).ToList();
                if (ticks.Count == 0) { lastError = $"TrueData {symbol}: {parsed.Error ?? "no ticks for that day"}"; continue; }

                var engine = Build(contract, ticks);
                _days[key] = (engine, symbol, DateTimeOffset.UtcNow);
                while (_days.Count > Math.Max(1, _options.MaxCachedDays))
                    _days.TryRemove(_days.OrderBy(kv => kv.Value.BuiltAt).First().Key, out _);
                _logger.LogInformation("Rebuilt {Contract} {Day} from {Ticks} TrueData ticks ({Symbol}{PerTick}).",
                    contract.TradingSymbol, day, ticks.Count, symbol, parsed.VolumeWasPerTick ? ", per-tick volume" : "");
                return new Result(engine, symbol, null, ticks.Count);
            }
            return new Result(null, null, lastError ?? "TrueData returned no ticks");
        }
        finally
        {
            _building.Release();
        }
    }

    /// <summary>Feeds the ticks through a fresh engine, as the live feed would.</summary>
    internal static OrderFlowEngine Build(DhanFuturesInstrument contract, IReadOnlyList<TrueDataTick> ticks)
    {
        var engine = new OrderFlowEngine(contract.Underlying.ToUpperInvariant(), contract.SecurityId, contract.TradingSymbol,
            contract.DhanSegment, contract.TickSize, contract.LotSize, contract.Expiry);
        long previous = 0;
        foreach (var t in ticks)
        {
            var tick = new SpotTick(contract.SecurityId, t.Ltp, 0, 0, 0, 0, t.Volume, t.Bid, t.Ask, t.OpenInterest, t.Time)
            {
                LastTradedQty = (int)Math.Clamp(t.Volume - previous, 0, int.MaxValue),
            };
            previous = t.Volume;
            engine.OnTick(tick, t.Time);
        }
        return engine;
    }
}
