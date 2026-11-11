using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Filters;
using OptionAnalytics.Server.Services;

namespace OptionAnalytics.Server.Controllers;

/// <summary>
/// An endpoint that exists only when the server runs on a developer's own machine (<c>Environment:LocalTools</c> -
/// <see cref="AppEnvironment.LocalTools"/>): the AI analysis of a run (a local model). On a real deployment it answers 404, as if it did not exist, whoever asks.
/// </summary>
[AttributeUsage(AttributeTargets.Class | AttributeTargets.Method)]
public sealed class LocalOnlyAttribute : Attribute, IResourceFilter
{
    public const string Message = "Only available when the server runs locally (Environment:LocalTools, which follows Environment:IsLocal).";

    /// <summary>A RESOURCE filter, so it answers BEFORE the controller is created: on a real deployment a refused request builds nothing - not the
    /// AI client or anything else behind it.</summary>
    public void OnResourceExecuting(ResourceExecutingContext context)
    {
        var environment = context.HttpContext.RequestServices.GetService<AppEnvironment>();
        if (environment is null || !environment.LocalTools) context.Result = new NotFoundObjectResult(new { error = Message });
    }

    public void OnResourceExecuted(ResourceExecutedContext context) { }
}
