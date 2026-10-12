using System.Text.Json;
using OptionAnalytics.Server.Telegram;

namespace OptionAnalytics.Server.Services;

/// <summary>What placing / closing a live trade needs (LiveTradingService) - a seam for the tests.</summary>
public interface IServerLiveOrders
{
    Task<ManualOrderResult> PlaceAsync(ManualOrderRequest request, CancellationToken cancellationToken);
    Task<ManualOrderResult> ExitTradeAsync(IReadOnlyList<string> orderIds, decimal slippagePoints, CancellationToken cancellationToken, bool onlyWithWorkingLegs);
    /// <summary>Where these super orders stand on Dhan, from the order book in memory (no Dhan call); unlisted ones left out.</summary>
    IReadOnlyList<LiveOrderState> OrderStates(IReadOnlyCollection<string> orderIds);
    /// <summary>Moves a trade's stop-loss / target legs to these premium points from its entry (0 = leave that leg).</summary>
    Task<ManualOrderResult> UpdateLegsAsync(IReadOnlyList<string> orderIds, decimal stopLossPoints, decimal targetPoints, CancellationToken cancellationToken);
}

/// <summary>
/// LIVE trading by the server scanner, per index. An admin switches an index to Live (the Trade settings page or the
/// Order Flow page) for TODAY only - the next day it is back to paper until switched on again. While it is Live, an
/// alert of the server scanner on that index places a real Dhan super order, but only through here and only when:
///  - the index is Live today, it is 09:15 - 14:45 IST, and the scanner has not already placed this signal;
///  - no other live trade of the index is still open (one at a time);
///  - the index's live trades today are under its max count and its live loss today is under its max loss;
///  - the strategy is on the index's LIVE LIST (LiveListService: proven on that index after costs, or added by hand);
///  - the account's own daily loss limit / kill switch does not block it (LiveTradingService checks that itself).
/// The lots and slippage are the index's Trade settings - the scanner only names the option; its SL / target legs are the
/// strategy's own (the ones its paper trade uses), never past the index's Max SL / Max target; the option's trailing stop
/// is the one the scanner sends (a strategy has none of the index's: TrailGapPoints 0), else the index's.
/// Every trade is kept in {data}/server-live.json with what the scanner reported when it closed, so the limits hold
/// across restarts. The scanner's "Runner" role reaches only this, never the manual live-trading API.
/// </summary>
public sealed class ServerLiveService
{
    public const int EntryFromMinute = 9 * 60 + 15;
    public const int LastEntryMinute = 14 * 60 + 45;
    /// <summary>A server scanner entry with nothing traded this long after it was placed is cancelled (ReconcileAsync).</summary>
    public const int EntryFillSeconds = 60;
    private readonly TradeSettingsStore _trade;
    private readonly IServerLiveOrders _orders;
    private readonly ILogger<ServerLiveService> _logger;
    private readonly TelegramAlertService? _telegram;
    private readonly Func<string, string, string?>? _listBlock;
    private readonly string _path;
    private readonly object _lock = new();
    private readonly SemaphoreSlim _placing = new(1, 1);
    private State _state;
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { WriteIndented = true };

    public ServerLiveService(TradeSettingsStore trade, LiveTradingService trading, IHostEnvironment environment, IConfiguration configuration,
        ILogger<ServerLiveService> logger, TelegramAlertService telegram, LiveListService list)
        : this(trade, new Live(trading), PathOf(environment, configuration), logger, telegram, list.BlockReason) { }

    /// <param name="listBlock">(index, strategy id) -> why it is not on the live list, else null; null = no list check (tests).</param>
    internal ServerLiveService(TradeSettingsStore trade, IServerLiveOrders orders, string path, ILogger<ServerLiveService> logger, TelegramAlertService? telegram = null,
        Func<string, string, string?>? listBlock = null)
    {
        _listBlock = listBlock;
        _trade = trade;
        _orders = orders;
        _path = path;
        _logger = logger;
        _telegram = telegram;
        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(_path))!);
        _state = Load();
    }

    private static string PathOf(IHostEnvironment environment, IConfiguration configuration)
    {
        var configured = configuration["Storage:ServerLivePath"];
        var path = string.IsNullOrWhiteSpace(configured) ? "server-live.json" : configured;
        return Path.IsPathRooted(path) ? path : Path.Combine(environment.ContentRootPath, path);
    }

    /// <summary>Every index: Live today or not, its limits and today's live trades.</summary>
    public List<ServerLiveIndexStatus> Status(DateTimeOffset now)
    {
        var today = Day(now);
        lock (_lock)
        {
            return TradeSettingsStore.Underlyings.Select(u =>
            {
                var s = _state.Indices.GetValueOrDefault(u) ?? IndexSettings.Default(u);
                var trades = _state.Trades.Where(t => t.Underlying == u && t.Day == today).ToList();
                // The counts are the server scanner's own (its limits); the page's watched trades are listed too.
                var own = trades.Where(t => !t.IsPageTrade).ToList();
                return new ServerLiveIndexStatus(u, s.LiveDay == today, s.LiveDay, s.MaxTrades, s.MaxLoss, own.Count(t => !t.NotFilled),
                    own.Count(t => t.ExitedUtc is null && (t.ExitAtMs <= 0 || now.ToUnixTimeMilliseconds() < t.ExitAtMs)), own.Sum(t => t.Pnl ?? 0), s.ArmedBy, s.ArmedUtc, trades);
            }).ToList();
        }
    }

    public bool IsLive(string underlying, DateTimeOffset now)
    {
        lock (_lock) return _state.Indices.GetValueOrDefault(underlying)?.LiveDay == Day(now);
    }

    /// <summary>Switches an index to Live for today (or back to paper) and sets its limits; null, or why not.</summary>
    public string? Set(string underlying, bool live, int? maxTrades, decimal? maxLoss, string? by, DateTimeOffset now)
    {
        var u = underlying.Trim().ToUpperInvariant();
        if (!TradeSettingsStore.Underlyings.Contains(u)) return $"Unknown index {underlying}.";
        if (maxTrades is < 1 or > 50) return "Max live trades must be 1 to 50.";
        if (maxLoss is < 500 or > 10_000_000) return "Max loss must be ₹500 to ₹1,00,00,000.";
        lock (_lock)
        {
            var s = _state.Indices.GetValueOrDefault(u) ?? IndexSettings.Default(u);
            var wasLive = s.LiveDay == Day(now);
            s.MaxTrades = maxTrades ?? s.MaxTrades;
            s.MaxLoss = maxLoss ?? s.MaxLoss;
            if (live) { s.LiveDay = Day(now); if (!wasLive) { s.ArmedBy = by; s.ArmedUtc = now; } }
            else s.LiveDay = null;
            _state.Indices[u] = s;
            Save();
        }
        _logger.LogWarning("Server scanner {Underlying}: {Mode} (by {User}).", u, live ? "LIVE for today" : "paper", by ?? "?");
        return null;
    }

    /// <summary>The scanner asks for a live order for one alert. Placed, or why not (Placed = false, nothing sent).</summary>
    public async Task<ServerLiveOrderResult> PlaceAsync(string underlying, ServerLiveOrderRequest request, DateTimeOffset now, CancellationToken cancellationToken)
    {
        var u = underlying.Trim().ToUpperInvariant();
        var today = Day(now);
        // One at a time: two alerts in the same moment must not both pass the limits.
        await _placing.WaitAsync(cancellationToken);
        try
        {
            var why = BlockReason(u, request, now);
            if (why is not null) return new ServerLiveOrderResult(false, why, null);
            var t = _trade.Get(u);
            // The strategy's own legs (the scanner sends them), held to the index's max rules (Trade settings) - never a
            // wider SL or a farther target than those; none sent: the max itself.
            var sl = Capped(request.StopLossPoints, t.MaxSl);
            var target = Capped(request.TargetPoints, t.MaxTarget);
            if (sl <= 0 || target <= 0) return new ServerLiveOrderResult(false, "a live trade is a Dhan super order - it needs both an SL and a target leg (the strategy's own, or the index's Max SL / Max target)", null);
            // The strategy's own lot size on this index when one was applied with it (the scanner sends it), else the
            // index's lots - within Trade settings' own range.
            var lots = request.Lots is >= 1 and <= 500 ? request.Lots.Value : t.Lots;
            // The option's trailing stop: the strategy's own when the scanner sends one (0 = none), else the index's.
            var (trailStart, trailGap) = request.TrailGapPoints is >= 0 and <= 5000
                ? (request.TrailGapPoints.Value > 0 ? Math.Clamp(request.TrailStartPoints ?? 0, 0, 5000) : 0, request.TrailGapPoints.Value)
                : (t.TrailGap > 0 ? t.TrailStart : 0, t.TrailGap);
            var order = new ManualOrderRequest(u, request.Expiry, request.Strike, request.Side.ToUpperInvariant(), request.Action.ToUpperInvariant(), lots,
                t.SlippagePoints, sl, target, trailStart, trailGap,
                request.ExitAtMs, request.ExitReason ?? "server scanner time stop", ChaseEntry: true);
            _logger.LogWarning("Server scanner LIVE {Action} {Underlying} {Strike}{Side} x{Lots} for {Key}.", order.Direction, u, order.Strike, order.Side, order.Lots, request.Key);
            var result = await _orders.PlaceAsync(order, CancellationToken.None);
            // Taken (all of it, or the slices before a rejection): recorded, so its exit closes it and it counts.
            if (result.OrderIds.Count > 0)
            {
                lock (_lock)
                {
                    _state.Trades.Add(new ServerLiveTrade(u, today, request.Key, request.Strategy ?? "", $"{order.Direction} {order.Strike} {order.Side}",
                        result.OrderIds.ToList(), order.Lots, result.LotSize, result.Prices?.Limit, now, null, null, null, result.Success ? null : $"partly placed - {result.Message}")
                    { ExitAtMs = request.ExitAtMs, IndexStop = request.IndexStop, IndexTarget = request.IndexTarget is > 0 ? request.IndexTarget : null, IndexSide = NormaliseSide(request.IndexSide), PriceBasis = NormaliseBasis(request.PriceBasis),
                      SlPoints = sl, TargetPoints = target });
                    Save();
                }
            }
            return new ServerLiveOrderResult(result.OrderIds.Count > 0, result.Message, result);
        }
        finally { _placing.Release(); }
    }

    /// <summary>A leg (premium points) held to its max rule: the sent one, but never past the max; none sent = the max (0 = none).</summary>
    internal static decimal Capped(decimal? sent, decimal max)
    {
        var own = sent is > 0 and <= 5000 ? sent.Value : 0;
        if (max <= 0) return own;
        return own > 0 ? Math.Min(own, max) : max;
    }

    /// <summary>Why a new live order must not go out for this index now, else null.</summary>
    internal string? BlockReason(string u, ServerLiveOrderRequest request, DateTimeOffset now)
    {
        if (!TradeSettingsStore.Underlyings.Contains(u)) return $"unknown index {u}";
        var today = Day(now);
        var minute = (int)now.ToOffset(IstClock.Offset).TimeOfDay.TotalMinutes;
        lock (_lock)
        {
            var s = _state.Indices.GetValueOrDefault(u);
            if (s?.LiveDay != today) return $"{u} is on paper (not switched to Live today)";
            if (minute < EntryFromMinute || minute > LastEntryMinute) return "outside 09:15 - 14:45 IST - no new live entries";
            // The server scanner's own trades - the Order Flow page's (watched here for their index stop) have their own limits.
            var trades = _state.Trades.Where(t => t.Underlying == u && t.Day == today && !t.IsPageTrade).ToList();
            if (trades.Any(t => t.Key == request.Key)) return "this signal was already placed";
            // Open = no exit reported yet and its time stop (the server's own time exit closes it) not passed.
            if (trades.Any(t => t.ExitedUtc is null && (t.ExitAtMs <= 0 || now.ToUnixTimeMilliseconds() < t.ExitAtMs))) return $"a live {u} trade is still open - one at a time";
            // An entry that never traded (rejected, cancelled, not filled in time) was no trade.
            if (trades.Count(t => !t.NotFilled) >= s.MaxTrades) return $"the day's limit of {s.MaxTrades} live {u} trade(s) is reached";
            var pnl = trades.Sum(t => t.Pnl ?? 0);
            if (pnl <= -s.MaxLoss) return $"{u}'s live loss today (₹{-pnl:N0}) reached its limit of ₹{s.MaxLoss:N0}";
        }
        if (request.Strike <= 0 || request.Side.ToUpperInvariant() is not ("CE" or "PE") || request.Action.ToUpperInvariant() is not ("BUY" or "SELL"))
            return "not an option order (strike, CE / PE, BUY / SELL)";
        // Only strategies proven on this index (or added by hand) trade live; the rest stay on paper.
        if (_listBlock is not null && _listBlock(u, request.StrategyIdOrFromKey) is { } notListed) return notListed;
        return null;
    }

    /// <summary>The scanner closed a live trade (its stop, target, trailing SL, time stop or the option's own levels):
    /// its order is exited on Dhan if it is still open there, and the P&amp;L it reports counts toward the loss limit.</summary>
    public async Task<ManualOrderResult> ExitAsync(string underlying, string key, string? reason, decimal? pnl, DateTimeOffset now, CancellationToken cancellationToken)
    {
        var u = underlying.Trim().ToUpperInvariant();
        ServerLiveTrade? trade;
        lock (_lock) trade = _state.Trades.LastOrDefault(t => t.Underlying == u && t.Key == key);
        if (trade is null) return ManualOrderResult.Fail($"no live {u} trade {key}");
        var slippage = _trade.Get(u).SlippagePoints;
        // Only while its SL / target legs still work: legs gone means Dhan (or the trader) already closed it.
        var result = trade.ExitedUtc is null
            ? await _orders.ExitTradeAsync(trade.OrderIds, slippage, CancellationToken.None, onlyWithWorkingLegs: true)
            : new ManualOrderResult(true, "already closed", Array.Empty<string>(), null);
        lock (_lock)
        {
            var i = _state.Trades.FindLastIndex(t => t.Underlying == u && t.Key == key);
            if (i >= 0)
            {
                var t = _state.Trades[i];
                // Closed by Dhan already (ReconcileAsync): what really happened stays - its leg's fill P&L, or none for
                // an entry that never traded - not the scanner's own reckoning.
                var settled = t.NotFilled || t.PnlFromFills;
                _state.Trades[i] = t with { ExitedUtc = t.ExitedUtc ?? (result.Success ? now : null), ExitReason = settled ? t.ExitReason : reason ?? t.ExitReason,
                    Pnl = settled ? t.Pnl : pnl ?? t.Pnl, Note = result.Success ? t.Note : $"exit failed - {result.Message}" };
                Save();
            }
        }
        if (!result.Success && _telegram is not null)
            await _telegram.SendAsync($"[Server] LIVE exit FAILED for {u} {trade.Contract}: {result.Message} - check the Dhan panel.", CancellationToken.None);
        return result;
    }

    /// <summary>
    /// The strategy moved an open live trade's option SL / target (a new Max SL / Max target in Trade settings reaching
    /// its open trades from that minute - the paper trade's levelLog): its Dhan super order's legs are moved to the same
    /// premium points from its entry (its fill once known) - held to the index's max rules like the order was, a trailed
    /// stop never loosened (LiveTradingService.UpdateTradeLevelsAsync). The server scanner's own open trades only.
    /// </summary>
    public async Task<ManualOrderResult> MoveLegsAsync(string underlying, string key, decimal? stopLossPoints, decimal? targetPoints, DateTimeOffset now, CancellationToken cancellationToken)
    {
        var u = underlying.Trim().ToUpperInvariant();
        ServerLiveTrade? trade;
        lock (_lock) trade = _state.Trades.LastOrDefault(t => t.Underlying == u && t.Key == key && !t.IsPageTrade);
        if (trade is null) return ManualOrderResult.Fail($"no live {u} trade {key}");
        if (trade.ExitedUtc is not null) return ManualOrderResult.Fail($"the live {u} trade {key} is closed already");
        var t = _trade.Get(u);
        var sl = Capped(stopLossPoints, t.MaxSl);
        var target = Capped(targetPoints, t.MaxTarget);
        if (sl <= 0 && target <= 0) return ManualOrderResult.Fail("no stop-loss or target to set");
        if (sl == trade.SlPoints && target == trade.TargetPoints) return new ManualOrderResult(true, "its legs are there already", Array.Empty<string>(), null);
        var result = await _orders.UpdateLegsAsync(trade.OrderIds, sl, target, CancellationToken.None);
        lock (_lock)
        {
            var i = _state.Trades.FindLastIndex(x => x.Underlying == u && x.Key == key && !x.IsPageTrade);
            if (i >= 0)
            {
                var cur = _state.Trades[i];
                _state.Trades[i] = result.Success
                    ? cur with { SlPoints = sl > 0 ? sl : cur.SlPoints, TargetPoints = target > 0 ? target : cur.TargetPoints }
                    : cur with { Note = $"SL / target not moved on Dhan - {result.Message}" };
                Save();
            }
        }
        _logger.LogWarning("Live {Underlying} {Contract} ({Key}): legs to SL {Sl} / target {Target} pts - {Message}", u, trade.Contract, key, sl, target, result.Message);
        return result;
    }

    public const string FuturesBasis = "futures";
    public const string SpotBasis = "spot";
    /// <summary>"spot" for a trade whose index levels are spot prices (the spot + options strategies), else null (futures).</summary>
    internal static string? NormaliseBasis(string? basis) => string.Equals(basis?.Trim(), SpotBasis, StringComparison.OrdinalIgnoreCase) ? SpotBasis : null;

    private static string? NormaliseSide(string? side) => side?.Trim().ToUpperInvariant() is "LONG" or "SHORT" ? side.Trim().ToUpperInvariant() : null;

    /// <summary>
    /// A live trade a PAGE placed - the Order Flow page's strategy scanner, or the OI Replay page's spot + options one
    /// ("Auto-place on alert" in Live mode, or a confirmed punch): kept here so
    /// the server watches its INDEX stop-loss and target too (CheckIndexStopsAsync) - the page's own exits only run while
    /// the page is open; its option SL / target legs (Dhan), trailing SL and time exit are the server's already. Not
    /// counted in the server scanner's limits (the page keeps its own). The same key again replaces it. Null, or why not.
    /// </summary>
    public string? WatchPageTrade(PageLiveWatchRequest request, DateTimeOffset now)
    {
        var u = (request.Underlying ?? "").Trim().ToUpperInvariant();
        if (!TradeSettingsStore.Underlyings.Contains(u)) return $"unknown index {request.Underlying}";
        if (string.IsNullOrWhiteSpace(request.Key) || request.Key.Length > 120) return "no trade key";
        var ids = (request.OrderIds ?? Array.Empty<string>()).Where(id => !string.IsNullOrWhiteSpace(id)).Distinct().ToList();
        if (ids.Count is 0 or > 20) return "no Dhan order ids";
        var side = NormaliseSide(request.IndexSide);
        if (side is null) return "the signal's side must be LONG or SHORT";
        if (request.IndexStop is not > 0) return "no index stop-loss";
        // A stop on the wrong side of a target would exit at once: refused rather than guessed.
        if (request.IndexTarget is { } tg && tg > 0 && (side == "LONG" ? tg <= request.IndexStop : tg >= request.IndexStop)) return "the index target is on the wrong side of the stop";
        var key = PageKey(request.Key);
        lock (_lock)
        {
            _state.Trades.RemoveAll(t => t.Underlying == u && t.Key == key && t.ExitedUtc is null);
            _state.Trades.Add(new ServerLiveTrade(u, Day(now), key, request.Strategy ?? "", request.Contract ?? "", ids, Math.Max(1, request.Lots), request.LotSize,
                request.EntryPrice, now, null, null, null, null)
            { ExitAtMs = request.ExitAtMs, IndexStop = request.IndexStop, IndexTarget = request.IndexTarget is > 0 ? request.IndexTarget : null, IndexSide = side, Source = "page", PriceBasis = NormaliseBasis(request.PriceBasis) });
            Save();
        }
        _logger.LogInformation("Watching the page's live {Underlying} {Contract} ({Key}): index SL {Stop}, target {Target} on the {Basis}.", u, request.Contract, request.Key, request.IndexStop, request.IndexTarget, NormaliseBasis(request.PriceBasis) ?? FuturesBasis);
        return null;
    }

    /// <summary>A page trade's key here - kept apart from the server scanner's keys (the same signal can be traded by both).</summary>
    public static string PageKey(string key) => $"page:{key}";

    /// <summary>The page's trailing stop moved a watched trade's index stop - only ever tighter (MoveIndexStop).</summary>
    public bool MovePageIndexStop(string underlying, string key, decimal stop) => MoveIndexStop(underlying, PageKey(key), stop);

    /// <summary>A live trade closed elsewhere (the page's own exit, the Exit button) - by any of its Dhan order ids: no
    /// longer watched. Returns how many were open.</summary>
    public int ClosedByOrders(IReadOnlyCollection<string> orderIds, string reason, DateTimeOffset now)
    {
        if (orderIds.Count == 0) return 0;
        lock (_lock)
        {
            var n = 0;
            for (var i = 0; i < _state.Trades.Count; i++)
            {
                var t = _state.Trades[i];
                if (t.ExitedUtc is not null || !t.OrderIds.Any(orderIds.Contains)) continue;
                _state.Trades[i] = t with { ExitedUtc = now, ExitReason = t.ExitReason ?? reason };
                n++;
            }
            if (n > 0) Save();
            return n;
        }
    }

    /// <summary>The scanner's trailing stop moved the trade's INDEX stop-loss: kept - only ever tighter (a LONG's stop
    /// only up, a SHORT's only down), so a late or repeated report can never loosen it. False when there is no such
    /// open trade.</summary>
    public bool MoveIndexStop(string underlying, string key, decimal stop)
    {
        var u = underlying.Trim().ToUpperInvariant();
        lock (_lock)
        {
            var i = _state.Trades.FindLastIndex(t => t.Underlying == u && t.Key == key && t.ExitedUtc is null);
            if (i < 0 || stop <= 0) return false;
            var t = _state.Trades[i];
            var tighter = t.IndexStop is not { } cur || (t.IndexSide == "SHORT" ? stop < cur : stop > cur);
            if (!tighter) return true;
            _state.Trades[i] = t with { IndexStop = stop };
            Save();
            return true;
        }
    }

    /// <summary>The futures-only form of <see cref="CheckIndexStopsAsync(Func{string, string, decimal?}, DateTimeOffset, CancellationToken)"/>:
    /// a trade whose levels are spot prices is not checked (never against the futures price).</summary>
    public Task<int> CheckIndexStopsAsync(Func<string, decimal?> priceOf, DateTimeOffset now, CancellationToken cancellationToken) =>
        CheckIndexStopsAsync((u, basis) => basis == FuturesBasis ? priceOf(u) : null, now, cancellationToken);

    /// <summary>
    /// The server's OWN index stop-loss and target check on every open live trade - the server scanner's and the Order
    /// Flow page's - so they hold even when the scanner is down or the page is closed: a LONG whose price is at or
    /// below its index stop (a SHORT at or above) - or at / beyond its index target - is exited on Dhan now, like the
    /// scanner's own exit would, and Telegram says so. The stop is checked first. `priceOf(index, basis)` gives an
    /// index's current price on the trade's own basis - "futures" (the futures strategies' levels) or "spot" (the spot +
    /// options strategies') - null when not fresh. The option's own SL / target legs are on Dhan already; this is the
    /// index level on top of them. Returns the trades exited.
    /// </summary>
    public async Task<int> CheckIndexStopsAsync(Func<string, string, decimal?> priceOf, DateTimeOffset now, CancellationToken cancellationToken)
    {
        List<(ServerLiveTrade Trade, decimal Price, bool Stop)> hit = new();
        var today = Day(now);
        lock (_lock)
        {
            foreach (var t in _state.Trades)
            {
                if (t.Day != today || t.ExitedUtc is not null || t.IndexSide is null || (t.ExitAtMs > 0 && now.ToUnixTimeMilliseconds() >= t.ExitAtMs)) continue;
                if (priceOf(t.Underlying, t.Basis) is not { } p || p <= 0) continue;
                var stopHit = t.IndexStop is > 0 && (t.IndexSide == "LONG" ? p <= t.IndexStop : p >= t.IndexStop);
                var targetHit = t.IndexTarget is > 0 && (t.IndexSide == "LONG" ? p >= t.IndexTarget : p <= t.IndexTarget);
                if (stopHit || targetHit) hit.Add((t, p, stopHit));
            }
        }
        foreach (var (t, price, stop) in hit)
        {
            var level = stop ? $"index SL {t.IndexStop:0.##}" : $"index target {t.IndexTarget:0.##}";
            var who = t.IsPageTrade ? "Order Flow page trade" : "server scanner trade";
            _logger.LogWarning("Server {Level}: {Underlying} {Contract} ({Key}, {Who}) - {Basis} {Price}; exiting.", level, t.Underlying, t.Contract, t.Key, who, t.Basis, price);
            var result = await ExitAsync(t.Underlying, t.Key, $"{level} (server check, {t.Basis} {price:0.##})", null, now, cancellationToken);
            if (_telegram is not null)
                await _telegram.SendAsync(result.Success
                    ? $"[Server] LIVE exit - {level} hit ({t.Basis} {price:0.##}): {t.Underlying} {t.Contract} ({who}) - {result.Message}"
                    : $"[Server] LIVE {level} hit for {t.Underlying} {t.Contract} ({who}) but the exit FAILED: {result.Message} - check the Dhan panel", CancellationToken.None);
        }
        return hit.Count;
    }

    /// <summary>
    /// What Dhan did to the open live trades by itself - every 2 s with the index stop check (ServerLiveStopWatcher), from
    /// the order book in memory: a trade whose every order has ended - its stop-loss or target leg filled, its entry
    /// rejected or cancelled before anything traded, or its legs gone - is closed here at once, with its P&amp;L from the
    /// fills, so it no longer holds the index's one-at-a-time slot until its time stop, even with the scanner down (an
    /// entry that never traded is no trade: not counted in the max trades, P&amp;L 0). And a server scanner entry still
    /// not traded at all <see cref="EntryFillSeconds"/> after it was placed is cancelled - a late fill would no longer be
    /// the signal's trade - through the trade's own exit (cancel the entry; anything that traded meanwhile is exited, so
    /// nothing is left without its legs). Returns the trades closed.
    /// </summary>
    public async Task<int> ReconcileAsync(DateTimeOffset now, CancellationToken cancellationToken)
    {
        List<ServerLiveTrade> open;
        var today = Day(now);
        lock (_lock) open = _state.Trades.Where(t => t.Day == today && t.ExitedUtc is null && t.OrderIds.Count > 0).ToList();
        var closed = 0;
        foreach (var t in open)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var states = _orders.OrderStates(t.OrderIds).GroupBy(x => x.OrderId).ToDictionary(g => g.Key, g => g.First());
            // An order the book does not list yet: nothing is known about it - left alone.
            if (!t.OrderIds.All(states.ContainsKey)) continue;
            var all = t.OrderIds.Select(id => states[id]).ToList();
            if (all.All(x => !x.Open))
            {
                if (Settle(t, all, now)) closed++;
                continue;
            }
            if (!t.IsPageTrade && all.All(x => x.Filled == 0) && now - t.PlacedUtc >= TimeSpan.FromSeconds(EntryFillSeconds)
                && await CancelUnfilledAsync(t, now)) closed++;
        }
        return closed;
    }

    /// <summary>Closes a trade Dhan ended by itself (ReconcileAsync).</summary>
    private bool Settle(ServerLiveTrade trade, List<LiveOrderState> orders, DateTimeOffset now)
    {
        var notFilled = orders.All(x => x.Filled == 0);
        var pnls = orders.Where(x => x.Filled > 0).Select(x => x.Pnl).ToList();
        decimal? pnl = notFilled ? 0 : pnls.All(x => x is not null) ? pnls.Sum(x => x!.Value) : null;
        var ended = orders.FirstOrDefault(x => x.EndedBy is "stop-loss" or "target") ?? orders.FirstOrDefault(x => x.Filled > 0) ?? orders[0];
        var reason = ended.EndedBy switch
        {
            "stop-loss" or "target" => $"{ended.EndedBy} leg filled on Dhan{(ended.ExitPrice is { } px ? $" @ {px:0.##}" : "")}",
            "rejected" => $"entry rejected by Dhan{(ended.Reason is { } r ? $" - {r}" : "")}",
            "cancelled" => "entry cancelled on Dhan before it traded",
            _ => "closed on Dhan (its stop-loss / target legs are gone)",
        };
        lock (_lock)
        {
            var i = _state.Trades.FindLastIndex(x => x.Underlying == trade.Underlying && x.Key == trade.Key && x.ExitedUtc is null);
            if (i < 0) return false;
            _state.Trades[i] = _state.Trades[i] with { ExitedUtc = now, ExitReason = reason, Pnl = pnl ?? _state.Trades[i].Pnl, NotFilled = notFilled, PnlFromFills = !notFilled && pnl is not null };
            Save();
        }
        _logger.LogWarning("Live {Underlying} {Contract} ({Key}) closed by Dhan: {Reason}, P&L {Pnl}.", trade.Underlying, trade.Contract, trade.Key, reason, pnl?.ToString("0.##") ?? "?");
        return true;
    }

    private readonly Dictionary<string, DateTimeOffset> _cancelTried = new();

    /// <summary>Cancels a server scanner entry that never traded (ReconcileAsync) - retried every 30 s if Dhan refuses.</summary>
    private async Task<bool> CancelUnfilledAsync(ServerLiveTrade trade, DateTimeOffset now)
    {
        var id = $"{trade.Underlying}|{trade.Key}";
        bool first;
        lock (_lock)
        {
            if (_cancelTried.TryGetValue(id, out var last) && now - last < TimeSpan.FromSeconds(30)) return false;
            first = !_cancelTried.ContainsKey(id);
            _cancelTried[id] = now;
        }
        var result = await _orders.ExitTradeAsync(trade.OrderIds, _trade.Get(trade.Underlying).SlippagePoints, CancellationToken.None, onlyWithWorkingLegs: true);
        // Something traded as the cancel went out: that part was exited (its exit order ids) - a trade after all.
        var tradedMeanwhile = result.OrderIds.Count > 0;
        lock (_lock)
        {
            var i = _state.Trades.FindLastIndex(x => x.Underlying == trade.Underlying && x.Key == trade.Key && x.ExitedUtc is null);
            if (i < 0) return false;
            var t = _state.Trades[i];
            _state.Trades[i] = result.Success
                ? t with { ExitedUtc = now, ExitReason = $"entry not filled within {EntryFillSeconds} s - cancelled", NotFilled = !tradedMeanwhile, Pnl = tradedMeanwhile ? t.Pnl : 0,
                    Note = tradedMeanwhile ? $"it traded as it was cancelled - exited: {result.Message}" : t.Note }
                : t with { Note = $"unfilled entry not cancelled yet - {result.Message}" };
            Save();
        }
        _logger.LogWarning("Live {Underlying} {Contract} ({Key}): entry not filled in {Seconds} s - cancel: {Message}", trade.Underlying, trade.Contract, trade.Key, EntryFillSeconds, result.Message);
        if (_telegram is not null && (result.Success || first))
            await _telegram.SendAsync(result.Success
                ? $"[Server] LIVE entry not filled in {EntryFillSeconds} s - cancelled: {trade.Underlying} {trade.Contract} ({trade.Strategy}){(tradedMeanwhile ? $" - part traded as it was cancelled and was exited: {result.Message}" : "")}"
                : $"[Server] LIVE entry of {trade.Underlying} {trade.Contract} not filled in {EntryFillSeconds} s and the cancel FAILED: {result.Message} - check the Dhan panel", CancellationToken.None);
        return result.Success;
    }

    private static string Day(DateTimeOffset now) => IstClock.IstDate(now).ToString("yyyy-MM-dd");

    private State Load()
    {
        try
        {
            if (!File.Exists(_path)) return new State();
            var s = JsonSerializer.Deserialize<State>(File.ReadAllText(_path), Json) ?? new State();
            // Only the last 30 days of trades are kept.
            var cutoff = DateTime.UtcNow.AddDays(-30).ToString("yyyy-MM-dd");
            s.Trades.RemoveAll(t => string.CompareOrdinal(t.Day, cutoff) < 0);
            return s;
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "{Path} could not be read - every index starts on paper.", _path);
            return new State();
        }
    }

    private void Save()
    {
        try
        {
            var temp = _path + ".tmp";
            File.WriteAllText(temp, JsonSerializer.Serialize(_state, Json));
            File.Move(temp, _path, overwrite: true);
        }
        catch (Exception ex) { _logger.LogWarning(ex, "{Path} could not be saved.", _path); }
    }

    internal sealed class State
    {
        public Dictionary<string, IndexSettings> Indices { get; set; } = new();
        public List<ServerLiveTrade> Trades { get; set; } = new();
    }

    internal sealed class IndexSettings
    {
        /// <summary>An index's limits before any are set: 5 live trades a day, a ₹15,000 max loss (₹10,000 on SENSEX).</summary>
        public static IndexSettings Default(string underlying) => new() { MaxTrades = 5, MaxLoss = underlying == "SENSEX" ? 10_000 : 15_000 };

        public string? LiveDay { get; set; }
        public int MaxTrades { get; set; } = 5;
        public decimal MaxLoss { get; set; } = 10_000;
        public string? ArmedBy { get; set; }
        public DateTimeOffset? ArmedUtc { get; set; }
    }

    private sealed class Live(LiveTradingService trading) : IServerLiveOrders
    {
        public Task<ManualOrderResult> PlaceAsync(ManualOrderRequest request, CancellationToken cancellationToken) => trading.PlaceAsync(request, cancellationToken);
        public Task<ManualOrderResult> ExitTradeAsync(IReadOnlyList<string> orderIds, decimal slippagePoints, CancellationToken cancellationToken, bool onlyWithWorkingLegs) =>
            trading.ExitTradeAsync(orderIds, slippagePoints, cancellationToken, onlyWithWorkingLegs);
        public IReadOnlyList<LiveOrderState> OrderStates(IReadOnlyCollection<string> orderIds) => trading.OrderStates(orderIds);
        public Task<ManualOrderResult> UpdateLegsAsync(IReadOnlyList<string> orderIds, decimal stopLossPoints, decimal targetPoints, CancellationToken cancellationToken) =>
            trading.UpdateTradeLevelsAsync(orderIds, stopLossPoints, targetPoints, cancellationToken);
    }
}

/// <summary>What the scanner sends for one alert: the option and the signal's key (strategy-time-side).</summary>
public sealed record ServerLiveOrderRequest(string Key, string? Strategy, DateOnly Expiry, decimal Strike, string Side, string Action,
    decimal? StopLossPoints = null, decimal? TargetPoints = null, long ExitAtMs = 0, string? ExitReason = null, string? StrategyId = null,
    decimal? IndexStop = null, string? IndexSide = null, decimal? IndexTarget = null, int? Lots = null, string? PriceBasis = null,
    decimal? TrailStartPoints = null, decimal? TrailGapPoints = null)
{
    /// <summary>The strategy's id - sent, else the key's first part ({id}-{time}-{side}).</summary>
    public string StrategyIdOrFromKey => !string.IsNullOrWhiteSpace(StrategyId) ? StrategyId! : Key.Split('-')[0];
}

public sealed record ServerLiveOrderResult(bool Placed, string Message, ManualOrderResult? Order);

public sealed record ServerLiveExitRequest(string Key, string? Reason, decimal? Pnl);

public sealed record ServerLiveStopRequest(string Key, decimal Stop);

/// <summary>The strategy's option SL / target (premium points from the entry) for an open live trade's Dhan legs.</summary>
public sealed record ServerLiveLegsRequest(string Key, decimal? StopLossPoints, decimal? TargetPoints);

/// <summary>Every 2 seconds in market hours: what Dhan did to the open live trades by itself (ServerLiveService.ReconcileAsync
/// - a leg filled, an entry rejected or not filled in time), then the server's own index stop-loss check on them
/// (ServerLiveService.CheckIndexStopsAsync), on the live price of each index - the futures, or the spot for a spot +
/// options strategy's trade (a price older than a minute is not used).</summary>
public sealed class ServerLiveStopWatcher(ServerLiveService live, OptionAnalytics.Server.Services.OrderFlow.OrderFlowService orderFlow, SpotFeedHostedService spotFeed, ILogger<ServerLiveStopWatcher> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(2));
        while (await timer.WaitForNextTickAsync(stoppingToken))
        {
            try
            {
                var now = DateTimeOffset.UtcNow;
                var minute = (int)now.ToOffset(IstClock.Offset).TimeOfDay.TotalMinutes;
                if (minute < 9 * 60 + 15 || minute > 15 * 60 + 30) continue;
                decimal? PriceOf(string u, string basis)
                {
                    if (basis == ServerLiveService.SpotBasis)
                        return spotFeed.States.TryGetValue(u, out var spot) && spot.LastPrice > 0 && now - spot.LastUpdateUtc < TimeSpan.FromMinutes(1) ? spot.LastPrice : null;
                    var (price, at) = orderFlow.EngineFor(u)?.LastTrade() ?? (0, null);
                    return price > 0 && at is { } t && now - t < TimeSpan.FromMinutes(1) ? price : null;
                }
                // First what Dhan did by itself (a leg filled, an entry rejected or never filled), then the index levels.
                await live.ReconcileAsync(now, stoppingToken);
                await live.CheckIndexStopsAsync(PriceOf, now, stoppingToken);
            }
            catch (OperationCanceledException) { throw; }
            catch (Exception ex) { logger.LogWarning(ex, "The server's index stop-loss check failed this time."); }
        }
    }
}

public sealed record ServerLiveSetRequest(bool Live, int? MaxTrades, decimal? MaxLoss);

public sealed record ServerLiveTrade(string Underlying, string Day, string Key, string Strategy, string Contract, List<string> OrderIds,
    int Lots, int? LotSize, decimal? EntryPrice, DateTimeOffset PlacedUtc, DateTimeOffset? ExitedUtc, string? ExitReason, decimal? Pnl, string? Note)
{
    /// <summary>When the server's own time exit closes it (ms), 0 = none.</summary>
    public long ExitAtMs { get; init; }
    /// <summary>The signal's stop-loss on the INDEX (futures price) and its side (LONG / SHORT) - the server exits the
    /// trade itself when the futures price goes through it (CheckIndexStopsAsync); moved only tighter by the trail.</summary>
    public decimal? IndexStop { get; init; }
    public string? IndexSide { get; init; }
    /// <summary>The signal's target on the index - exited there by the server too.</summary>
    public decimal? IndexTarget { get; init; }
    /// <summary>"page" - placed by the Order Flow page and only watched here (not in the server scanner's limits); null - the server scanner's.</summary>
    public string? Source { get; init; }
    /// <summary>"spot" - the index stop / target are SPOT prices (a spot + options strategy) and are checked on the spot;
    /// null - futures prices.</summary>
    public string? PriceBasis { get; init; }
    /// <summary>The option SL / target legs on Dhan (premium points from the entry) - as placed, then as the strategy moved them.</summary>
    public decimal? SlPoints { get; init; }
    public decimal? TargetPoints { get; init; }
    /// <summary>Its entry never traded (rejected, cancelled, not filled in time): no trade - not counted in the max
    /// trades, P&amp;L 0.</summary>
    public bool NotFilled { get; init; }
    /// <summary>Closed by its own stop-loss / target leg on Dhan, Pnl from those fills - kept over the scanner's report.</summary>
    public bool PnlFromFills { get; init; }
    [System.Text.Json.Serialization.JsonIgnore] public string Basis => PriceBasis == ServerLiveService.SpotBasis ? ServerLiveService.SpotBasis : ServerLiveService.FuturesBasis;
    [System.Text.Json.Serialization.JsonIgnore] public bool IsPageTrade => Source == "page";
}

/// <summary>What the Order Flow page sends after it placed a live order: the trade, its Dhan super order ids, and the
/// signal's index stop / target / side - so the server watches them (ServerLiveService.WatchPageTrade).</summary>
public sealed record PageLiveWatchRequest(string Underlying, string Key, IReadOnlyList<string>? OrderIds, decimal? IndexStop, string? IndexSide,
    decimal? IndexTarget = null, string? Strategy = null, string? Contract = null, int Lots = 1, int? LotSize = null, decimal? EntryPrice = null, long ExitAtMs = 0,
    string? PriceBasis = null);

public sealed record PageLiveStopRequest(string Underlying, string Key, decimal Stop);

public sealed record ServerLiveIndexStatus(string Underlying, bool Live, string? LiveDay, int MaxTrades, decimal MaxLoss, int TradesToday,
    int OpenToday, decimal PnlToday, string? ArmedBy, DateTimeOffset? ArmedUtc, List<ServerLiveTrade> Trades);
