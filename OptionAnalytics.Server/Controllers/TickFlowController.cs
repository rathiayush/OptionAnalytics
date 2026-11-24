using Microsoft.AspNetCore.Mvc;
using OptionAnalytics.Server.TrueData;

namespace OptionAnalytics.Server.Controllers;

/// <summary>The Tick Flow page's data (TrueData's real-time ticks - TrueDataLiveFeed / TickBook): the exact footprint, the bubbles and
/// the best bid / ask trail per index. Its own - nothing of the Order Flow page's. Only registered while TrueData:Live:Enabled.
/// Admin / User; the External account never reaches it (deny by default).</summary>
[ApiController]
[Route("api/tick-flow")]
public sealed class TickFlowController : ControllerBase
{
    private readonly TrueDataLiveFeed? _feed;

    public TickFlowController(IServiceProvider services) => _feed = services.GetService<TrueDataLiveFeed>();

    [HttpGet("status")]
    public ActionResult Status() =>
        _feed is null
            ? Ok(new { enabled = false, state = "off", note = "TrueData:Live:Enabled is off or the TrueData login is not set (TrueData__UserId / TrueData__Password)." })
            : Ok(new { enabled = true, status = _feed.Snapshot() });

    /// <param name="rowSize">Price points per footprint row (0 = the contract's tick).</param>
    /// <param name="minBubbleLots">The smallest bubble returned, in lots (1 = every print; the page asks for more when a day is busy).</param>
    [HttpGet("{underlying}")]
    public ActionResult<TickDay> Get(string underlying, [FromQuery] decimal rowSize = 1, [FromQuery] int minBubbleLots = 1, [FromQuery] int maxBubbles = 6000)
    {
        if (_feed is null) return NotFound(new { error = "The TrueData live feed is off (TrueData:Live:Enabled)." });
        var book = _feed.BookFor(underlying);
        if (book is null) return NotFound(new { error = $"{underlying.ToUpperInvariant()} is not streamed (TrueData:Live:Instruments)." });
        return book.Snapshot(Math.Clamp(rowSize, 0, 1000), Math.Max(1, minBubbleLots) * (long)book.LotSize, Math.Clamp(maxBubbles, 100, 20000));
    }
}
