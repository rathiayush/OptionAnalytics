using System.Net;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using OptionAnalytics.Server.Services;
using OptionAnalytics.Server.Telegram;

namespace OptionAnalytics.Server.Controllers;

/// <summary>GET /api/alerts - recent spot+ATM-option confluence alerts (see
/// ConfluenceAlertService), most recent first. Not underlying-scoped since the frontend shows one
/// combined feed across NIFTY and BANKNIFTY; a page load or Refresh click needs this to see
/// anything that fired before the tab was open, since SignalR's "confluenceAlert" push only
/// reaches a tab that's already connected.</summary>
[ApiController]
[Route("api/alerts")]
public sealed class AlertsController : ControllerBase
{
    private readonly ConfluenceAlertService _alerts;
    private readonly TelegramAlertService _telegram;

    public AlertsController(ConfluenceAlertService alerts, TelegramAlertService telegram)
    {
        _alerts = alerts;
        _telegram = telegram;
    }

    [HttpGet]
    public IActionResult GetRecent() => Ok(_alerts.GetRecentAlerts());

    /// <summary>Every underlying's CURRENT spot/ATM-CE/ATM-PE bias right now (see
    /// ConfluenceAlertService.GetCurrentStates) - a live snapshot, not history.</summary>
    [HttpGet("state")]
    public IActionResult GetState() => Ok(_alerts.GetCurrentStates());

    /// <summary>POST /api/alerts/telegram - the Order Flow strategy scanner's own messages (a trade
    /// punched on paper or placed live, and its exit) to the same Telegram chat as the other alerts.
    /// Plain text: HTML-escaped (the bot sends with parse_mode HTML) and capped.</summary>
    [HttpPost("telegram")]
    [Authorize]
    public async Task<IActionResult> SendTelegram([FromBody] TelegramMessageRequest request, CancellationToken cancellationToken)
    {
        var text = request?.Text?.Trim();
        if (string.IsNullOrEmpty(text)) return BadRequest(new { error = "No text." });
        if (text.Length > 1500) text = text[..1500];
        if (!_telegram.IsConfigured) return Ok(new { sent = false, reason = "Telegram is not configured on the server." });
        await _telegram.SendAsync(WebUtility.HtmlEncode(text), cancellationToken);
        return Ok(new { sent = true });
    }
}

public sealed record TelegramMessageRequest(string? Text);
