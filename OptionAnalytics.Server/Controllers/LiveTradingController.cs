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

    [HttpDelete("orders/{orderId}")]
    public async Task<ActionResult<ManualOrderResult>> Cancel(string orderId, CancellationToken cancellationToken)
    {
        var result = await _trading.CancelAsync(orderId, CancellationToken.None);
        return result.Success ? Ok(result) : UnprocessableEntity(result);
    }
}
