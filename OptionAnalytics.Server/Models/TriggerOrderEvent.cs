namespace OptionAnalytics.Server.Models;

/// <summary>One outcome in a live trigger's order pipeline - a placement, fill, re-price, cancel,
/// failure, or skip. This is the exact same text StrategyTriggerHostedService.NotifyFollowUpAsync
/// already sends to Telegram, persisted alongside it so the Triggers page can show "what actually
/// happened to this order" without depending on catching that one Telegram message. Status is the
/// message's own leading [TAG] with the brackets stripped (ORDER PLACED, ORDER FAILED,
/// NO ORDER PLACED, ORDER FILLED, and so on - see NotifyFollowUpAsync's call sites for the full
/// set) so the page can badge it without re-parsing free text on every render.</summary>
public sealed record TriggerOrderEvent(
    string Id,
    string TriggerId,
    string TriggerName,
    DateTimeOffset TimestampUtc,
    string Status,
    string Message);
