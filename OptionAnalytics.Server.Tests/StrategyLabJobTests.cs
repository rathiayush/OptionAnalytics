using System.Text.Json.Nodes;
using OptionAnalytics.Server.Controllers;

namespace OptionAnalytics.Server.Tests;

/// <summary>A Strategy lab job as the page sends it (StrategyTuningController.BuildJob): one or several strategies, the
/// setting tried and what it goes on top of - checked before anything runs.</summary>
public sealed class StrategyLabJobTests
{
    private static StrategyTuningController.RunRequest Lab(JsonNode? strategies, string? labBase = null, JsonObject? @params = null) =>
        new("NIFTY", strategies, What: "lab", Params: @params, LabBase: labBase);

    [Fact]
    public void SeveralStrategies_InOneLabJob_FromAsWrittenByDefault_OrFromAsApplied()
    {
        var (job, error) = StrategyTuningController.BuildJob(Lab(new JsonArray("weakWall", "squeeze"), @params: new JsonObject { ["tradeTargetX"] = 2 }), "SENSEX");
        Assert.Null(error);
        Assert.Equal(("SENSEX", "lab", "written", 2), (job!.Underlying, job.What, job.LabBase, ((JsonArray)job.Strategies!).Count));
        Assert.Equal(2, job.Params!["tradeTargetX"]!.GetValue<int>());

        var (applied, _) = StrategyTuningController.BuildJob(Lab(new JsonArray("weakWall"), "Applied", new JsonObject { ["optLeg"] = "none" }), "NIFTY");
        Assert.Equal("applied", applied!.LabBase);
    }

    [Fact]
    public void ALabJob_NeedsItsStrategiesListed_AKnownStart_AndOnlyTheTunedSettings()
    {
        Assert.Contains("strategies listed", StrategyTuningController.BuildJob(Lab(JsonValue.Create("top3")), "NIFTY").Error);
        Assert.Contains("LabBase", StrategyTuningController.BuildJob(Lab(new JsonArray("weakWall"), "tuned"), "NIFTY").Error);
        Assert.Contains("only set the tuned settings", StrategyTuningController.BuildJob(Lab(new JsonArray("weakWall"), @params: new JsonObject { ["lots"] = 4 }), "NIFTY").Error);
        // Another kind of job carries no lab start.
        var (tune, _) = StrategyTuningController.BuildJob(new StrategyTuningController.RunRequest("NIFTY", new JsonArray("weakWall")), "NIFTY");
        Assert.Null(tune!.LabBase);
    }
}
