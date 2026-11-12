using System.Globalization;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using OptionAnalytics.Server.Auth;
using OptionAnalytics.Server.Services;
using OptionAnalytics.Server.Telegram;

namespace OptionAnalytics.Server.Controllers;

/// <summary>GET /api/telegram-log?from=yyyy-MM-dd&amp;to=yyyy-MM-dd - every Telegram message the app sent on those IST days
/// (TelegramMessageLog - the exact text, how it went), oldest first: the Telegram signals page reads them and shows how the
/// price moved after each one. Admin and User (the External account and the runner key never reach it - ExternalAccess is
/// deny by default). Read only; no Dhan call.</summary>
[ApiController]
[Route("api/telegram-log")]
[Authorize(Roles = $"{AuthRoles.Admin},{AuthRoles.User}")]
public sealed class TelegramLogController : ControllerBase
{
    private readonly TelegramMessageLog _log;

    public TelegramLogController(TelegramMessageLog log) => _log = log;

    [HttpGet]
    public IActionResult Get([FromQuery] string? from, [FromQuery] string? to)
    {
        var today = IstClock.Today();
        var end = ParseDay(to) ?? today;
        var start = ParseDay(from) ?? end.AddDays(-6);
        if (end > today) end = today;
        if (start > end) (start, end) = (end, start);
        var messages = _log.Read(start, end);
        return Ok(new { from = start, to = end, maxDays = TelegramMessageLog.MaxDaysRead, messages });
    }

    private static DateOnly? ParseDay(string? value) =>
        DateOnly.TryParseExact(value ?? "", "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var day) ? day : null;
}
