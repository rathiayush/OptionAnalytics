using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Abstractions;
using Microsoft.AspNetCore.Mvc.Filters;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Options;
using OptionAnalytics.Server.Controllers;
using OptionAnalytics.Server.Services;

namespace OptionAnalytics.Server.Tests;

/// <summary>The LOCAL TOOLS (the AI analysis of a run - LlmController): they exist only when the server says it runs locally
/// (<c>Environment:LocalTools</c>, which follows <c>Environment:IsLocal</c>); a real deployment has them off and answers 404 before anything is built.</summary>
public sealed class LocalToolsTests
{
    private sealed class Env : IHostEnvironment
    {
        public string EnvironmentName { get; set; } = "Test";
        public string ApplicationName { get; set; } = "Tests";
        public string ContentRootPath { get; set; } = "";
        public IFileProvider ContentRootFileProvider { get; set; } = null!;
    }

    private static ResourceExecutingContext Context(bool? isLocal, bool? localTools = null)
    {
        var services = new ServiceCollection();
        if (isLocal is { } l) services.AddSingleton(new AppEnvironment(new Env { EnvironmentName = l ? "Development" : "Production" }, Options.Create(new AppEnvironmentOptions { IsLocal = l, LocalTools = localTools })));
        var http = new DefaultHttpContext { RequestServices = services.BuildServiceProvider() };
        return new ResourceExecutingContext(new ActionContext(http, new RouteData(), new ActionDescriptor()), [], []);
    }

    [Theory]
    [InlineData(true, null, false)]     // IsLocal on: the tools follow it
    [InlineData(false, null, true)]     // a deployment (IsLocal off / unset): refused
    [InlineData(false, true, false)]    // a developer's machine with no database: IsLocal off, the tools on
    [InlineData(true, false, true)]     // the tools switched off even on a local machine
    [InlineData(null, null, true)]      // no environment at all: refused
    public void The_local_tools_exist_only_when_they_are_on_otherwise_they_answer_404_before_a_controller_is_built(bool? isLocal, bool? localTools, bool refused)
    {
        var ctx = Context(isLocal, localTools);
        new LocalOnlyAttribute().OnResourceExecuting(ctx);
        Assert.Equal(refused, ctx.Result is NotFoundObjectResult);
    }

    [Theory]
    [InlineData("Production", null, null, false)]       // a real deployment, nothing set: off
    [InlineData("Development", null, null, true)]       // a plain `dotnet run`: on (IsLocal auto-detects)
    [InlineData("Production", false, null, false)]
    [InlineData("Production", true, null, true)]
    [InlineData("Development", false, true, true)]      // IsLocal off, tools on
    [InlineData("Development", true, false, false)]
    public void The_local_tools_follow_IsLocal_unless_set_themselves_and_a_deployment_has_them_off(string host, bool? isLocal, bool? tools, bool expected)
    {
        var env = new AppEnvironment(new Env { EnvironmentName = host }, Options.Create(new AppEnvironmentOptions { IsLocal = isLocal, LocalTools = tools }));
        Assert.Equal(expected, env.LocalTools);
    }

    [Fact]
    public void The_ai_answer_is_marked_local_only()
    {
        Assert.NotNull(Attribute.GetCustomAttribute(typeof(LlmController).GetMethod(nameof(LlmController.Analyse))!, typeof(LocalOnlyAttribute)));
    }
}
