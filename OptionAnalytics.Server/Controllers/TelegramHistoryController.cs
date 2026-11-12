using System.Globalization;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using OptionAnalytics.Server.Auth;
using OptionAnalytics.Server.Telegram;

namespace OptionAnalytics.Server.Controllers;

public sealed record TelegramConnectRequest(int? ApiId, string? ApiHash, string? Phone);
public sealed record TelegramCodeRequest(string? Value);

/// <summary>
/// The Telegram signals page's reading of the bot's channel, straight from Telegram (TelegramChannelReader - nothing of the
/// messages is kept on the server). GET status and GET messages: Admin and User; the sign-in (connect, code / password, log
/// out): Admin only. The External account and the runner key never reach it (ExternalAccess is deny by default). A click
/// on the page - nothing polls; no Dhan call.
/// </summary>
[ApiController]
[Route("api/telegram-history")]
[Authorize(Roles = $"{AuthRoles.Admin},{AuthRoles.User}")]
public sealed class TelegramHistoryController : ControllerBase
{
    private readonly TelegramChannelReader _reader;
    private readonly TelegramSignalMessages _signals;

    public TelegramHistoryController(TelegramChannelReader reader, TelegramSignalMessages signals)
    {
        _reader = reader;
        _signals = signals;
    }

    [HttpGet("status")]
    public async Task<IActionResult> Status(CancellationToken cancellationToken) => Ok(await _reader.StatusAsync(cancellationToken));

    /// <summary>The channel's messages on the IST days from .. to (yyyy-MM-dd; the last 7 days by default, at most
    /// TelegramChannelReader.MaxDays), oldest first: { from, to, maxDays, messages: [{ id, time, text }] }.</summary>
    [HttpGet("messages")]
    public async Task<IActionResult> Messages([FromQuery] string? from, [FromQuery] string? to, CancellationToken cancellationToken)
    {
        var today = IstClock.Today();
        var end = ParseDay(to) ?? today;
        if (end > today) end = today;
        var start = ParseDay(from) ?? end.AddDays(-6);
        if (start > end) (start, end) = (end, start);
        if (end.DayNumber - start.DayNumber >= TelegramChannelReader.MaxDays) start = end.AddDays(-(TelegramChannelReader.MaxDays - 1));
        try
        {
            var messages = await _reader.ReadAsync(start, end, cancellationToken);
            return Ok(new { from = start, to = end, maxDays = TelegramChannelReader.MaxDays, messages });
        }
        catch (TelegramReaderException ex)
        {
            return Conflict(new { error = ex.Message });
        }
    }

    /// <summary>The Telegram signals page's load: the IST days from .. to (the last 7 by default, at most
    /// TelegramSignalMessages.MaxDays) SERVER FIRST - each day from the server's log when it holds the whole day, else the
    /// days fetched from Telegram before, else fetched from Telegram now (and kept): { from, to, days: [{ date, source, count,
    /// note }], messages: [{ time, text, status, source }] }.</summary>
    [HttpGet("signals")]
    public async Task<IActionResult> Signals([FromQuery] string? from, [FromQuery] string? to, CancellationToken cancellationToken)
    {
        var today = IstClock.Today();
        var end = ParseDay(to) ?? today;
        var start = ParseDay(from) ?? end.AddDays(-6);
        var read = await _signals.ReadAsync(start, end, cancellationToken);
        return Ok(new { from = read.From, to = read.To, maxDays = TelegramSignalMessages.MaxDays, days = read.Days, messages = read.Messages });
    }

    [HttpPost("connect")]
    [Authorize(Roles = AuthRoles.Admin)]
    public Task<IActionResult> Connect([FromBody] TelegramConnectRequest request, CancellationToken cancellationToken) =>
        Step(() => _reader.ConnectAsync(request.ApiId, request.ApiHash, request.Phone, cancellationToken));

    [HttpPost("code")]
    [Authorize(Roles = AuthRoles.Admin)]
    public Task<IActionResult> Code([FromBody] TelegramCodeRequest request, CancellationToken cancellationToken) =>
        Step(() => _reader.ContinueAsync(request.Value, cancellationToken));

    [HttpPost("logout")]
    [Authorize(Roles = AuthRoles.Admin)]
    public Task<IActionResult> Logout(CancellationToken cancellationToken) => Step(() => _reader.LogOutAsync(cancellationToken));

    private async Task<IActionResult> Step(Func<Task<TelegramReaderStatus>> step)
    {
        try { return Ok(await step()); }
        catch (TelegramReaderException ex) { return BadRequest(new { error = ex.Message }); }
    }

    private static DateOnly? ParseDay(string? value) =>
        DateOnly.TryParseExact(value ?? "", "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var day) ? day : null;
}
