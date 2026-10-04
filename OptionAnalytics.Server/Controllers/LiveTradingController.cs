using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using OptionAnalytics.Server.Auth;
using OptionAnalytics.Server.Services;

namespace OptionAnalytics.Server.Controllers;

/// <summary>Real-money manual trading for the OI Replay trade panel's Live mode - see
/// LiveTradingService. Admin only: these place and close actual Dhan orders.</summary>
[ApiController]
[Route("api/live-trading")]
[Authorize(Roles = AuthRoles.Admin)]
public sealed class LiveTradingController : ControllerBase
{
    private readonly LiveTradingService _trading;
    private readonly ILogger<LiveTradingController> _logger;

    public LiveTradingController(LiveTradingService trading, ILogger<LiveTradingController> logger)
    {
        _trading = trading;
        _logger = logger;
    }

    /// <summary>The current positions/orders snapshot - what the panel paints first, before the
    /// "livePositions" pushes take over. Refreshes from Dhan first when asked (the panel's Refresh).</summary>
    [HttpGet("positions")]
    public async Task<LivePositionsSnapshot> Positions([FromQuery] bool refresh, CancellationToken cancellationToken)
    {
        if (refresh || _trading.Snapshot().RefreshedUtc is null) await _trading.RefreshAsync(cancellationToken);
        return _trading.Snapshot();
    }

    [HttpPost("orders")]
    public async Task<ActionResult<ManualOrderResult>> Place([FromBody] ManualOrderRequest request, CancellationToken cancellationToken)
    {
        _logger.LogWarning("{User} requested a LIVE {Direction} {Underlying} {Strike}{Side} {Expiry:yyyy-MM-dd} x{Lots} lots (slippage {Slippage}, SL {Sl}, target {Target}).",
            User.Identity?.Name, request.Direction, request.Underlying, request.Strike, request.Side, request.Expiry, request.Lots,
            request.SlippagePoints, request.StopLossPoints, request.TargetPoints);
        var result = await _trading.PlaceAsync(request, CancellationToken.None);
        return result.Success ? Ok(result) : UnprocessableEntity(result);
    }

    public sealed record CloseRequest(decimal SlippagePoints);

    [HttpPost("positions/{securityId}/close")]
    public async Task<ActionResult<ManualOrderResult>> Close(string securityId, [FromBody] CloseRequest request, CancellationToken cancellationToken)
    {
        _logger.LogWarning("{User} requested closing LIVE position {SecurityId} (slippage {Slippage}).", User.Identity?.Name, securityId, request.SlippagePoints);
        var result = await _trading.CloseAsync(securityId, request.SlippagePoints, CancellationToken.None);
        return result.Success ? Ok(result) : UnprocessableEntity(result);
    }

    public sealed record PartialExitRequest(int Lots, decimal SlippagePoints);

    /// <summary>Exits some lots of a position and keeps the rest protected - see LiveTradingService.PartialExitAsync.</summary>
    [HttpPost("positions/{securityId}/partial-exit")]
    public async Task<ActionResult<ManualOrderResult>> PartialExit(string securityId, [FromBody] PartialExitRequest request)
    {
        _logger.LogWarning("Manual LIVE partial exit requested by {User}: {SecurityId} {Lots} lot(s).", User.Identity?.Name, securityId, request.Lots);
        var result = await _trading.PartialExitAsync(securityId, request.Lots, request.SlippagePoints, CancellationToken.None);
        return result.Success ? Ok(result) : UnprocessableEntity(result);
    }

    /// <param name="exit">true for a working exit order (a plain order), false for an unfilled entry (super order).</param>
    [HttpDelete("orders/{orderId}")]
    public async Task<ActionResult<ManualOrderResult>> Cancel(string orderId, [FromQuery] bool exit, CancellationToken cancellationToken)
    {
        var result = await _trading.CancelAsync(orderId, exit, CancellationToken.None);
        return result.Success ? Ok(result) : UnprocessableEntity(result);
    }

    [HttpPost("exit-all")]
    public async Task<ActionResult<ManualOrderResult>> ExitAll([FromBody] CloseRequest request, CancellationToken cancellationToken)
    {
        _logger.LogWarning("{User} requested EXIT ALL live positions (slippage {Slippage}).", User.Identity?.Name, request.SlippagePoints);
        var result = await _trading.ExitAllAsync(request.SlippagePoints, CancellationToken.None);
        return result.Success ? Ok(result) : UnprocessableEntity(result);
    }

    /// <summary>Dhan's account-wide exit of every position and cancel of every open order.</summary>
    [HttpPost("emergency-exit-all")]
    public async Task<ActionResult<ManualOrderResult>> EmergencyExitAll(CancellationToken cancellationToken)
    {
        _logger.LogWarning("{User} requested the EMERGENCY account-wide exit-all.", User.Identity?.Name);
        var result = await _trading.EmergencyExitAllAsync(CancellationToken.None);
        return result.Success ? Ok(result) : UnprocessableEntity(result);
    }
}
