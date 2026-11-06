using System.Globalization;
using System.Net;
using System.Text.Json.Nodes;
using OptionAnalytics.Server.Telegram;

namespace OptionAnalytics.Server.Services.SignalStrategies;

/// <summary>What a saved strategy's live orders need of Dhan - LiveTradingService's own super-order path (the OI Replay
/// panel's): the tests put a fake Dhan behind it.</summary>
public interface ISignalOrderGateway
{
    Task<ManualOrderResult> PlaceAsync(ManualOrderRequest request, CancellationToken cancellationToken);
    Task<ManualOrderResult> ExitTradeAsync(IReadOnlyList<string> orderIds, decimal slippagePoints, CancellationToken cancellationToken, bool onlyWithWorkingLegs);
    DateTimeOffset? SetTimeExit(IReadOnlyList<string> orderIds, DateTimeOffset exitAt, decimal slippagePoints, string reason);
    void ClearTimeExit(IReadOnlyList<string> orderIds);
}

/// <summary>The real gateway: LiveTradingService (the kill switch, the max-lots cap, the freeze-quantity slices, the time
/// exits and their retries are all its own).</summary>
public sealed class LiveTradingOrderGateway(LiveTradingService trading) : ISignalOrderGateway
{
    public Task<ManualOrderResult> PlaceAsync(ManualOrderRequest request, CancellationToken cancellationToken) => trading.PlaceAsync(request, cancellationToken);
    public Task<ManualOrderResult> ExitTradeAsync(IReadOnlyList<string> orderIds, decimal slippagePoints, CancellationToken cancellationToken, bool onlyWithWorkingLegs) =>
        trading.ExitTradeAsync(orderIds, slippagePoints, cancellationToken, onlyWithWorkingLegs);
    public DateTimeOffset? SetTimeExit(IReadOnlyList<string> orderIds, DateTimeOffset exitAt, decimal slippagePoints, string reason) =>
        trading.SetTimeExit(orderIds, exitAt, slippagePoints, reason);
    public void ClearTimeExit(IReadOnlyList<string> orderIds) => trading.ClearTimeExit(orderIds);
}

/// <summary>
/// LIVE DHAN ORDERS for a saved strategy (asked for - "wire these strategies to actual trading on Dhan"): only for one an
/// ADMIN armed with its "Live orders" switch (SignalStrategy.LiveOrders - off by default, confirmed on the page), from the
/// entries / exits its live scan posts (SignalLiveHostedService's process - the Runner key, which still reaches no
/// live-trading endpoint: the SERVER decides here, for armed strategies only). Each event is acted on ONCE - only the
/// events new to the store (SignalStrategyStore.KeepEventsAsync), so a repeat, a retry or a restart never places twice.
/// <list type="bullet">
/// <item>ENTRY: a Dhan SUPER ORDER (LiveTradingService.PlaceAsync - LIMIT at the live ask / bid +- the Trade settings'
/// slippage) of the TRADED index's option (the strategy's "Trade in"), the rule's and the mirror's alike; QUANTITY = the
/// traded index's Trade settings lots; its stop-loss / target legs = the strategy's own SL / target in premium points from
/// its entry (the Trade settings' where the strategy has none - a super order needs both); the server's time exit at 15:10
/// IST behind it (a safety net should the scan stop). NOT placed - kept with why and sent to Telegram - when it was seen
/// LATE (over 3 minutes after its signal minute, as the scan's "seen late": a restart), it had already exited when seen,
/// another live trade of the strategy has no exit yet (the engine trades one at a time - a second open would be a scan
/// gone wrong), the strategy's Max trades are placed already today, it is past 15:10, or Dhan / the kill switch refused.</item>
/// <item>EXIT (the strategy's own - its trailing stop, cost SL on spot / premium, time stop, the day's limits, SL / target,
/// the 15:10 square-off): LiveTradingService.ExitTradeAsync on the entry's orders - the super order's working legs (or an
/// entry still pending) CANCELLED, then the filled quantity exited at a LIMIT; nothing when Dhan's own leg already closed
/// it. Done even when Live orders was turned off since the entry. A failed exit is handed to the server's time-exit loop at
/// once (retried every 10 s, Telegram on the result).</item>
/// </list>
/// Every order, placed or not, is a row of history/{id}-orders.csv (with Dhan's order ids) and a Telegram message.
/// </summary>
public sealed class SignalLiveOrders
{
    /// <summary>An entry first seen this long after its signal minute's START is late: the minute (1) + the live scan's
    /// "seen late" (3).</summary>
    public static readonly TimeSpan LateAfter = TimeSpan.FromMinutes(4);

    private readonly SignalStrategyStore _store;
    private readonly TradeSettingsStore _tradeSettings;
    private readonly ISignalOrderGateway _gateway;
    private readonly TelegramAlertService? _telegram;
    private readonly ILogger<SignalLiveOrders> _logger;
    // One batch at a time: a strategy's "open trade" / "trades today" checks always see the orders before them.
    private readonly SemaphoreSlim _gate = new(1, 1);

    internal Func<DateTimeOffset> UtcNow { get; set; } = () => DateTimeOffset.UtcNow;
    /// <summary>Tests: what a Telegram message would do.</summary>
    internal Func<string, Task>? NotifyOverride { get; set; }

    public SignalLiveOrders(SignalStrategyStore store, TradeSettingsStore tradeSettings, ISignalOrderGateway gateway, ILogger<SignalLiveOrders> logger,
        TelegramAlertService? telegram = null)
    {
        _store = store;
        _tradeSettings = tradeSettings;
        _gateway = gateway;
        _logger = logger;
        _telegram = telegram;
    }

    /// <summary>Acts on a strategy's NEW events of <paramref name="date"/>, in their order: an armed strategy's entries placed,
    /// exits of trades with a live order closed.</summary>
    public async Task HandleAsync(SignalStrategy strategy, string date, IReadOnlyList<SignalLiveEvent> fresh, CancellationToken cancellationToken)
    {
        var relevant = fresh.Where(e => e.Trade?.Key is { Length: > 0 } && e.Kind is "entry" or "exit").ToList();
        if (relevant.Count == 0) return;
        // Nothing to do for a strategy that is not armed and has no live order today (the common, paper case).
        if (!strategy.LiveOrders && _store.Orders(strategy.Id, date).Count == 0) return;
        await _gate.WaitAsync(cancellationToken);
        try
        {
            // A trade whose exit is in this same batch had already ended when the scan saw it.
            var exited = relevant.Where(e => e.Kind == "exit").Select(e => e.Trade!.Key!).ToHashSet();
            foreach (var e in relevant)
            {
                try
                {
                    if (e.Kind == "entry") await EntryAsync(strategy, date, e.Trade!, exited.Contains(e.Trade!.Key!), cancellationToken);
                    else await ExitAsync(strategy, date, e.Trade!, cancellationToken);
                }
                catch (Exception ex) when (ex is not OperationCanceledException)
                {
                    _logger.LogError(ex, "Saved strategy {Name}: the live order for {Trade} failed.", strategy.Name, e.Trade!.Key);
                    await NotifyAsync($"⚠️ LIVE order error · {strategy.Name}: {ex.Message} - check Dhan.");
                }
            }
        }
        finally { _gate.Release(); }
    }

    private static string OptionOf(SignalLiveTrade t) =>
        $"{(t.Underlying ?? "").ToUpperInvariant()} {t.Strike?.ToString("0.##", CultureInfo.InvariantCulture)} {(t.Side ?? "").ToUpperInvariant()}".Trim();

    private async Task EntryAsync(SignalStrategy strategy, string date, SignalLiveTrade t, bool exitedAlready, CancellationToken cancellationToken)
    {
        if (!strategy.LiveOrders) return;
        var now = UtcNow();
        var orders = _store.Orders(strategy.Id, date);
        var underlying = (t.Underlying ?? "").Trim().ToUpperInvariant();
        var side = (t.Side ?? "").Trim().ToUpperInvariant();
        var action = (t.Action ?? "").Trim().ToUpperInvariant();
        var option = OptionOf(t);
        var maxTrades = MaxTradesPerDay(strategy.Settings);
        var placedToday = orders.Count(r => r.Kind == "entry" && r.OrderIds.Count > 0);
        var open = orders.FirstOrDefault(r => r.Kind == "entry" && r.OrderIds.Count > 0 && !orders.Any(x => x.Kind == "exit" && x.Trade == r.Trade));
        var hasExpiry = DateOnly.TryParseExact(t.Expiry, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var expiry);
        string? skip =
            date != SignalStrategyStore.TodayIst(now) ? "not today's"
            : exitedAlready ? "it had already exited when the live scan saw it"
            : t.EntryTime is not { } entryMs || now > DateTimeOffset.FromUnixTimeMilliseconds(entryMs) + LateAfter
                ? "seen late (over 3 min after its signal minute) - a live order goes only on a fresh signal"
            : IstClock.MinutesOfDay(now) >= LiveTradingService.TimeExitCutoffMinute ? "past 15:10 - the square-off"
            : open is not null ? $"the strategy's live trade {open.Option} ({open.Trade}) has no exit yet"
            : placedToday >= maxTrades ? $"{maxTrades} live trade{(maxTrades == 1 ? "" : "s")} placed today already (the strategy's Max trades)"
            : !TradeSettingsStore.Underlyings.Contains(underlying) || side is not ("CE" or "PE") || action is not ("BUY" or "SELL")
              || t.Strike is not > 0 || !hasExpiry ? "the trade's option could not be read (index, strike, CE / PE, BUY / SELL, expiry)"
            : null;
        if (skip is not null)
        {
            _store.RecordOrder(strategy.Id, new SignalOrderRow(now, date, t.Key!, "entry", "skipped", underlying, option, action, 0, Array.Empty<string>(), "") { Reason = skip });
            await NotifyAsync($"⚪ LIVE order NOT placed · {strategy.Name}: {action} {option} - {skip}");
            return;
        }

        var ts = _tradeSettings.Get(underlying);
        var stopLoss = t.StopLossPoints is > 0 ? Math.Round(t.StopLossPoints.Value, 2) : ts.SlPoints;
        var target = t.TargetPoints is > 0 ? Math.Round(t.TargetPoints.Value, 2) : ts.TargetPoints;
        var exitAt = IstClock.AtIstTime(IstClock.IstDate(now), LiveTradingService.TimeExitCutoffMinute);
        var request = new ManualOrderRequest(underlying, expiry, t.Strike!.Value, side, action, ts.Lots, ts.SlippagePoints, stopLoss, target,
            ExitAtMs: exitAt.ToUnixTimeMilliseconds(), ExitReason: $"{strategy.Name}: 15:10 square-off");
        _logger.LogWarning("Saved strategy {Name}: LIVE {Action} {Option} {Expiry:yyyy-MM-dd} x{Lots} lots (SL {Sl}, target {Target}, slippage {Slippage}) - trade {Trade}.",
            strategy.Name, action, option, expiry, ts.Lots, stopLoss, target, ts.SlippagePoints, t.Key);
        var result = await _gateway.PlaceAsync(request, cancellationToken);
        var status = result.Success ? "placed" : result.OrderIds.Count > 0 ? "partly placed" : "not placed";
        // What was sent: the entry's LIMIT and its super order's stop-loss / target prices (Dhan's fill comes on its own feed).
        _store.RecordOrder(strategy.Id, new SignalOrderRow(UtcNow(), date, t.Key!, "entry", status, underlying, option, action, ts.Lots, result.OrderIds, result.Message)
        {
            Price = result.Prices?.Limit, Sl = result.Prices?.StopLoss, Target = result.Prices?.Target, Reason = result.Success ? "" : result.Message,
        });
        await NotifyAsync(result.Success
            ? $"🟢 LIVE order placed · {strategy.Name}{Mirror(t)}: {result.Message}"
            : $"⚠️ LIVE order {status.ToUpperInvariant()} · {strategy.Name}{Mirror(t)}: {action} {option} x{ts.Lots} lot{(ts.Lots == 1 ? "" : "s")} - {result.Message}");
    }

    private async Task ExitAsync(SignalStrategy strategy, string date, SignalLiveTrade t, CancellationToken cancellationToken)
    {
        var orders = _store.Orders(strategy.Id, date);
        var entry = orders.LastOrDefault(r => r.Kind == "entry" && r.Trade == t.Key && r.OrderIds.Count > 0);
        if (entry is null || orders.Any(r => r.Kind == "exit" && r.Trade == t.Key)) return;   // no live order for it / closed already
        var ts = _tradeSettings.Get(entry.Underlying);
        var reason = string.IsNullOrWhiteSpace(t.ExitReason) ? "the strategy's exit" : t.ExitReason.Trim();
        _logger.LogWarning("Saved strategy {Name}: LIVE exit of {Option} ({Reason}) - orders {Orders}.", strategy.Name, entry.Option, reason, string.Join(",", entry.OrderIds));
        var result = await _gateway.ExitTradeAsync(entry.OrderIds, ts.SlippagePoints, cancellationToken, onlyWithWorkingLegs: true);
        string status, text;
        if (result.Success)
        {
            _gateway.ClearTimeExit(entry.OrderIds);
            // Closed already by the super order's own leg (Dhan's target / stop-loss, at its price), else out at the LIMIT sent.
            status = result.ClosedBy is { } leg ? $"closed by Dhan's {leg}" : "exited";
            text = $"🔴 LIVE exit · {strategy.Name}{Mirror(t)}: {entry.Option} ({reason}) - {result.Message}";
        }
        else
        {
            // Handed to the server's time-exit loop now: tried again every 10 s (up to 30 times), Telegram on how it ends.
            var retry = _gateway.SetTimeExit(entry.OrderIds, UtcNow().AddSeconds(2), ts.SlippagePoints, $"{strategy.Name}: exit ({reason}) retried");
            status = "exit failed";
            text = $"⚠️ LIVE exit FAILED · {strategy.Name}{Mirror(t)}: {entry.Option} ({reason}) - {result.Message}"
                + (retry is null ? " - check Dhan." : " - the server tries it again every 10 s; check Dhan.");
        }
        _store.RecordOrder(strategy.Id, new SignalOrderRow(UtcNow(), date, t.Key!, "exit", status, entry.Underlying, entry.Option, entry.Action, entry.Lots, result.OrderIds,
            result.Message) { Price = result.ExitPrice, Reason = reason });
        await NotifyAsync(text);
    }

    private static string Mirror(SignalLiveTrade t) => t.Strategy == "mirror" ? " (mirror)" : "";

    /// <summary>The strategy's own Max trades a day (the backtest's maxTradesPerDay - 2 by default, 1 - 20).</summary>
    internal static int MaxTradesPerDay(JsonObject settings)
    {
        var v = settings["maxTradesPerDay"] is JsonValue j && j.TryGetValue<double>(out var d) && double.IsFinite(d) ? (int)Math.Round(d) : 2;
        return Math.Clamp(v, 1, 20);
    }

    private async Task NotifyAsync(string text)
    {
        var html = WebUtility.HtmlEncode(text);
        try
        {
            if (NotifyOverride is { } notify) await notify(html);
            else if (_telegram is not null) await _telegram.SendAsync(html, CancellationToken.None);
        }
        catch (Exception ex) { _logger.LogWarning(ex, "Saved strategy live order: the Telegram message could not be sent."); }
    }
}
