using System.Text.Json;
using OptionAnalytics.Server.Telegram;

namespace OptionAnalytics.Server.Services;

/// <summary>What placing / closing a live trade needs (LiveTradingService) - a seam for the tests.</summary>
public interface IServerLiveOrders
{
    Task<ManualOrderResult> PlaceAsync(ManualOrderRequest request, CancellationToken cancellationToken);
    Task<ManualOrderResult> ExitTradeAsync(IReadOnlyList<string> orderIds, decimal slippagePoints, CancellationToken cancellationToken, bool onlyWithWorkingLegs);
}

/// <summary>
/// LIVE trading by the server scanner, per index. An admin switches an index to Live (the Trade settings page or the
/// Order Flow page) for TODAY only - the next day it is back to paper until switched on again. While it is Live, an
/// alert of the server scanner on that index places a real Dhan super order, but only through here and only when:
///  - the index is Live today, it is 09:15 - 14:45 IST, and the scanner has not already placed this signal;
///  - no other live trade of the index is still open (one at a time);
///  - the index's live trades today are under its max count and its live loss today is under its max loss;
///  - the account's own daily loss limit / kill switch does not block it (LiveTradingService checks that itself).
/// The lots, slippage and trailing stop are the index's Trade settings - the scanner only names the option; its
/// SL / target are the ones the paper trade uses (the strategy's tuned plan or Trade settings), checked here.
/// Every trade is kept in {data}/server-live.json with what the scanner reported when it closed, so the limits hold
/// across restarts. The scanner's "Runner" role reaches only this, never the manual live-trading API.
/// </summary>
public sealed class ServerLiveService
{
    public const int EntryFromMinute = 9 * 60 + 15;
    public const int LastEntryMinute = 14 * 60 + 45;
    private readonly TradeSettingsStore _trade;
    private readonly IServerLiveOrders _orders;
    private readonly ILogger<ServerLiveService> _logger;
    private readonly TelegramAlertService? _telegram;
    private readonly string _path;
    private readonly object _lock = new();
    private readonly SemaphoreSlim _placing = new(1, 1);
    private State _state;
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { WriteIndented = true };

    public ServerLiveService(TradeSettingsStore trade, LiveTradingService trading, IHostEnvironment environment, IConfiguration configuration,
        ILogger<ServerLiveService> logger, TelegramAlertService telegram)
        : this(trade, new Live(trading), PathOf(environment, configuration), logger, telegram) { }

    internal ServerLiveService(TradeSettingsStore trade, IServerLiveOrders orders, string path, ILogger<ServerLiveService> logger, TelegramAlertService? telegram = null)
    {
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
                var s = _state.Indices.GetValueOrDefault(u) ?? new IndexSettings();
                var trades = _state.Trades.Where(t => t.Underlying == u && t.Day == today).ToList();
                return new ServerLiveIndexStatus(u, s.LiveDay == today, s.LiveDay, s.MaxTrades, s.MaxLoss, trades.Count,
                    trades.Count(t => t.ExitedUtc is null && (t.ExitAtMs <= 0 || now.ToUnixTimeMilliseconds() < t.ExitAtMs)), trades.Sum(t => t.Pnl ?? 0), s.ArmedBy, s.ArmedUtc, trades);
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
            var s = _state.Indices.GetValueOrDefault(u) ?? new IndexSettings();
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
            var sl = request.StopLossPoints is > 0 and <= 5000 ? request.StopLossPoints.Value : t.SlPoints;
            var target = request.TargetPoints is > 0 and <= 5000 ? request.TargetPoints.Value : t.TargetPoints;
            if (sl <= 0 || target <= 0) return new ServerLiveOrderResult(false, "a live trade is a Dhan super order - the index's SL and target must both be above 0", null);
            var order = new ManualOrderRequest(u, request.Expiry, request.Strike, request.Side.ToUpperInvariant(), request.Action.ToUpperInvariant(), t.Lots,
                t.SlippagePoints, sl, target, t.TrailGap > 0 ? t.TrailStart : 0, t.TrailGap,
                request.ExitAtMs, request.ExitReason ?? "server scanner time stop");
            _logger.LogWarning("Server scanner LIVE {Action} {Underlying} {Strike}{Side} x{Lots} for {Key}.", order.Direction, u, order.Strike, order.Side, order.Lots, request.Key);
            var result = await _orders.PlaceAsync(order, CancellationToken.None);
            // Taken (all of it, or the slices before a rejection): recorded, so its exit closes it and it counts.
            if (result.OrderIds.Count > 0)
            {
                lock (_lock)
                {
                    _state.Trades.Add(new ServerLiveTrade(u, today, request.Key, request.Strategy ?? "", $"{order.Direction} {order.Strike} {order.Side}",
                        result.OrderIds.ToList(), order.Lots, result.LotSize, result.Prices?.Limit, now, null, null, null, result.Success ? null : $"partly placed - {result.Message}")
                    { ExitAtMs = request.ExitAtMs });
                    Save();
                }
            }
            return new ServerLiveOrderResult(result.OrderIds.Count > 0, result.Message, result);
        }
        finally { _placing.Release(); }
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
            var trades = _state.Trades.Where(t => t.Underlying == u && t.Day == today).ToList();
            if (trades.Any(t => t.Key == request.Key)) return "this signal was already placed";
            // Open = no exit reported yet and its time stop (the server's own time exit closes it) not passed.
            if (trades.Any(t => t.ExitedUtc is null && (t.ExitAtMs <= 0 || now.ToUnixTimeMilliseconds() < t.ExitAtMs))) return $"a live {u} trade is still open - one at a time";
            if (trades.Count >= s.MaxTrades) return $"the day's limit of {s.MaxTrades} live {u} trade(s) is reached";
            var pnl = trades.Sum(t => t.Pnl ?? 0);
            if (pnl <= -s.MaxLoss) return $"{u}'s live loss today (₹{-pnl:N0}) reached its limit of ₹{s.MaxLoss:N0}";
        }
        if (request.Strike <= 0 || request.Side.ToUpperInvariant() is not ("CE" or "PE") || request.Action.ToUpperInvariant() is not ("BUY" or "SELL"))
            return "not an option order (strike, CE / PE, BUY / SELL)";
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
                _state.Trades[i] = t with { ExitedUtc = t.ExitedUtc ?? (result.Success ? now : null), ExitReason = reason ?? t.ExitReason, Pnl = pnl ?? t.Pnl,
                    Note = result.Success ? t.Note : $"exit failed - {result.Message}" };
                Save();
            }
        }
        if (!result.Success && _telegram is not null)
            await _telegram.SendAsync($"[Server] LIVE exit FAILED for {u} {trade.Contract}: {result.Message} - check the Dhan panel.", CancellationToken.None);
        return result;
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
    }
}

/// <summary>What the scanner sends for one alert: the option and the signal's key (strategy-time-side).</summary>
public sealed record ServerLiveOrderRequest(string Key, string? Strategy, DateOnly Expiry, decimal Strike, string Side, string Action,
    decimal? StopLossPoints = null, decimal? TargetPoints = null, long ExitAtMs = 0, string? ExitReason = null);

public sealed record ServerLiveOrderResult(bool Placed, string Message, ManualOrderResult? Order);

public sealed record ServerLiveExitRequest(string Key, string? Reason, decimal? Pnl);

public sealed record ServerLiveSetRequest(bool Live, int? MaxTrades, decimal? MaxLoss);

public sealed record ServerLiveTrade(string Underlying, string Day, string Key, string Strategy, string Contract, List<string> OrderIds,
    int Lots, int? LotSize, decimal? EntryPrice, DateTimeOffset PlacedUtc, DateTimeOffset? ExitedUtc, string? ExitReason, decimal? Pnl, string? Note)
{
    /// <summary>When the server's own time exit closes it (ms), 0 = none.</summary>
    public long ExitAtMs { get; init; }
}

public sealed record ServerLiveIndexStatus(string Underlying, bool Live, string? LiveDay, int MaxTrades, decimal MaxLoss, int TradesToday,
    int OpenToday, decimal PnlToday, string? ArmedBy, DateTimeOffset? ArmedUtc, List<ServerLiveTrade> Trades);
