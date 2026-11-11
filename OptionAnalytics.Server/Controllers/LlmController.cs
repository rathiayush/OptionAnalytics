using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using OptionAnalytics.Server.Auth;
using OptionAnalytics.Server.Services;

namespace OptionAnalytics.Server.Controllers;

/// <summary>AI analysis of a run's report by a local model (LlmAnalysisService). Admin and User accounts only - the External
/// account and the scanner's Runner key never reach it (ExternalAccess denies by default).</summary>
[ApiController]
[Route("api/llm")]
[Authorize(Roles = AuthRoles.Admin + "," + AuthRoles.User)]
public sealed class LlmController : ControllerBase
{
    private readonly LlmAnalysisService _llm;
    private readonly AppEnvironment _environment;

    public LlmController(LlmAnalysisService llm, AppEnvironment environment)
    {
        _llm = llm;
        _environment = environment;
    }

    /// <summary>GET /api/llm/status - { enabled, available, defaultModel, models, reason }. Asked once by the page, not polled.</summary>
    [HttpGet("status")]
    public async Task<LlmAnalysisService.Status> GetStatus(CancellationToken ct) =>
        // Off the developer's own machine the page just sees "not available" and shows no button.
        _environment.LocalTools ? await _llm.GetStatusAsync(ct) : new LlmAnalysisService.Status(false, false, "", [], LocalOnlyAttribute.Message);

    public sealed record AnalyseRequest(string? Text, string? Ask, string? Model);

    /// <summary>POST /api/llm/analyse - { text (the report), ask (optional question), model (optional, installed) } to { text, model, seconds }.</summary>
    [HttpPost("analyse")]
    [LocalOnly]
    public async Task<IActionResult> Analyse([FromBody] AnalyseRequest request, CancellationToken ct)
    {
        try
        {
            return Ok(await _llm.AnalyseAsync(request.Text, request.Ask, request.Model, ct));
        }
        catch (LlmException e)
        {
            return StatusCode(e.Status, new { error = e.Message });
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            // The page closed the dialog or went away: nobody is waiting for an answer.
            return StatusCode(499);
        }
    }
}
