using Microsoft.AspNetCore.Mvc;
using OptionAnalytics.Server.Dhan;
using OptionAnalytics.Server.Services;

namespace OptionAnalytics.Server.Controllers;

[ApiController]
[Route("api/spot")]
public sealed class SpotController : ControllerBase
{
    private readonly SpotFeedHostedService _feed;
    private readonly DhanSession _session;
    private readonly DhanOptionChainMaster _optionChainMaster;
    private readonly CdvHostedService _cdv;

    public SpotController(SpotFeedHostedService feed, DhanSession session, DhanOptionChainMaster optionChainMaster, CdvHostedService cdv)
    {
        _feed = feed;
        _session = session;
        _optionChainMaster = optionChainMaster;
        _cdv = cdv;
    }

    /// <summary>Why there is no data, in one call. "Nothing is showing" has several very different
    /// causes that look identical from the dashboard - the Dhan token expired, an underlying's
    /// instrument never resolved, backfill came back empty for one exchange but not another, the
    /// scrip master parsed to nothing - and none of them are distinguishable without reading the
    /// container logs. This reports all of them at once so the answer is a URL rather than an
    /// investigation.
    ///
    /// Deliberately exposes NO token or client id, only whether one is present: this is a
    /// diagnostic, not a credential dump.</summary>
    [HttpGet("diagnostics")]
    public IActionResult GetDiagnostics()
    {
        var (contractCount, loadedAt, underlyings) = _optionChainMaster.Status();

        return Ok(new
        {
            dhanAuthenticated = _session.IsAuthenticated,
            optionChain = new
            {
                contractCount,
                loadedAt,
                underlyings,
            },
            spot = _feed.States.Values.Select(s =>
            {
                var candles = s.GetCandles();
                return new
                {
                    underlying = s.Underlying,
                    step = s.Step,
                    resolved = s.Instrument is not null,
                    securityId = s.Instrument?.SecurityId,
                    segment = s.Instrument?.DhanSegment,
                    tradingSymbol = s.Instrument?.TradingSymbol,
                    candleCount = candles.Count,
                    firstCandle = candles.Count > 0 ? candles[0].Time : (DateTimeOffset?)null,
                    lastCandle = candles.Count > 0 ? candles[^1].Time : (DateTimeOffset?)null,
                    lastPrice = s.LastPrice,
                };
            }),
            // A tracked strike with no candles got no backfill - a whole expiry of them means the
            // option history fetch is failing for that underlying, not that the market was quiet.
            options = _cdv.GetOptionCoverage().Select(c => new
            {
                underlying = c.Underlying,
                expiry = c.Expiry,
                trackedStrikes = c.TrackedStrikes,
                strikesWithCandles = c.StrikesWithCandles,
            }),
        });
    }

    /// <summary>The underlyings this app charts, and the strike step each one's spot price is
    /// rounded to - drives the dropdown on the frontend.</summary>
    [HttpGet("underlyings")]
    public IActionResult GetUnderlyings() =>
        Ok(_feed.States.Values.Select(s => new { underlying = s.Underlying, step = s.Step }));

    [HttpGet("{underlying}/candles")]
    public IActionResult GetCandles(string underlying)
    {
        if (!_feed.States.TryGetValue(underlying.ToUpperInvariant(), out var state))
            return NotFound(new { error = $"Unknown underlying '{underlying}'." });

        return Ok(state.GetCandles());
    }

    [HttpGet("{underlying}/snapshot")]
    public IActionResult GetSnapshot(string underlying)
    {
        if (!_feed.States.TryGetValue(underlying.ToUpperInvariant(), out var state))
            return NotFound(new { error = $"Unknown underlying '{underlying}'." });

        return Ok(state.ToSnapshot());
    }
}
