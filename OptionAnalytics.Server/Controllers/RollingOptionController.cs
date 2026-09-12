using Microsoft.AspNetCore.Mvc;
using OptionAnalytics.Server.Dhan;
using OptionAnalytics.Server.Models;

namespace OptionAnalytics.Server.Controllers;

/// <summary>
/// Backs the Expired Options page: backtesting against Dhan's rolling/expired-option history
/// rather than this app's own live-tracked strikes, so a strategy (or just a human eyeballing the
/// chart) can compare how a NEAR expiry reacted to a move against how a FAR one did, over any past
/// date range - the live dashboard/Backtrack pages can only ever see the CURRENTLY listed
/// contracts, which is no help for that comparison once an expiry has passed.
///
/// Scoped to NIFTY/BANKNIFTY only - Dhan's rolling-option docs only ever show "NSE_FNO" as the
/// exchange segment, never a BSE one, so SENSEX is left out rather than guessed at.
/// </summary>
[ApiController]
[Route("api/rolling-option")]
public sealed class RollingOptionController : ControllerBase
{
    private static readonly HashSet<string> SupportedUnderlyings = new(StringComparer.OrdinalIgnoreCase) { "NIFTY", "BANKNIFTY" };
    private static readonly HashSet<int> SupportedIntervals = new() { 1, 5, 15, 25, 60 };

    private readonly DhanSpotInstrumentMaster _instrumentMaster;
    private readonly DhanRollingOptionDataService _rollingOption;

    public RollingOptionController(DhanSpotInstrumentMaster instrumentMaster, DhanRollingOptionDataService rollingOption)
    {
        _instrumentMaster = instrumentMaster;
        _rollingOption = rollingOption;
    }

    public sealed record SideResult(IReadOnlyList<RollingOptionCandle> Candles, string? Error);
    public sealed record SeriesResponse(string Underlying, string ExpiryFlag, int ExpiryCode, string Strike, SideResult Ce, SideResult Pe);

    /// <summary>CE and PE together for one relative contract (expiryFlag/expiryCode/strikeOffset)
    /// over [fromDate,toDate] - one page load, two Dhan calls (chunked internally, see
    /// DhanRollingOptionDataService), so the page can chart/compare both sides without a second
    /// round trip.</summary>
    [HttpGet("{underlying}/series")]
    public async Task<IActionResult> GetSeries(
        string underlying,
        [FromQuery] string? expiryFlag,
        [FromQuery] int expiryCode,
        [FromQuery] int strikeOffset,
        [FromQuery] string? fromDate,
        [FromQuery] string? toDate,
        [FromQuery] int interval,
        CancellationToken cancellationToken)
    {
        if (!SupportedUnderlyings.Contains(underlying))
            return BadRequest(new { error = $"'{underlying}' is not supported - Dhan's rolling-option API only documents NSE_FNO index options, so only NIFTY and BANKNIFTY are offered." });

        var normalizedFlag = expiryFlag?.Trim().ToUpperInvariant();
        if (normalizedFlag is not ("WEEK" or "MONTH"))
            return BadRequest(new { error = "'expiryFlag' must be WEEK or MONTH." });

        if (expiryCode is < 0 or > 10)
            return BadRequest(new { error = "'expiryCode' must be between 0 and 10." });

        if (strikeOffset is < -10 or > 10)
            return BadRequest(new { error = "'strikeOffset' must be between -10 and 10." });

        var intervalMinutes = interval > 0 ? interval : 5;
        if (!SupportedIntervals.Contains(intervalMinutes))
            return BadRequest(new { error = $"'interval' must be one of {string.Join(", ", SupportedIntervals.OrderBy(i => i))} minutes." });

        if (!DateOnly.TryParse(fromDate, out var fromDay) || !DateOnly.TryParse(toDate, out var toDay))
            return BadRequest(new { error = "'fromDate' and 'toDate' must both be valid dates." });

        var instrument = _instrumentMaster.FindSpot(underlying.ToUpperInvariant());
        if (instrument is null)
            return BadRequest(new { error = $"Could not resolve {underlying}'s Dhan security id yet - the scrip master may still be loading. Try again shortly." });

        var strike = strikeOffset == 0 ? "ATM" : $"ATM{(strikeOffset > 0 ? "+" : "")}{strikeOffset}";

        var ceTask = _rollingOption.GetRollingOptionCandlesAsync(instrument.SecurityId, normalizedFlag, expiryCode, strike, "CALL", fromDay, toDay, intervalMinutes, cancellationToken);
        var peTask = _rollingOption.GetRollingOptionCandlesAsync(instrument.SecurityId, normalizedFlag, expiryCode, strike, "PUT", fromDay, toDay, intervalMinutes, cancellationToken);
        await Task.WhenAll(ceTask, peTask);

        var (ceCandles, ceError) = ceTask.Result;
        var (peCandles, peError) = peTask.Result;

        return Ok(new SeriesResponse(
            underlying.ToUpperInvariant(), normalizedFlag, expiryCode, strike,
            new SideResult(ceCandles, ceError),
            new SideResult(peCandles, peError)));
    }
}
