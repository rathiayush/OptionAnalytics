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

    [Fact]
    public void ALabJob_CanGiveEachStrategyItsOwnSetting_ForTheListedOnes_AndOnlyTheTunedSettings()
    {
        StrategyTuningController.RunRequest ById(JsonObject byId) => new("NIFTY", new JsonArray("weakWall", "squeeze"), What: "lab", ParamsById: byId);
        var (job, error) = StrategyTuningController.BuildJob(ById(new JsonObject { ["weakWall"] = new JsonObject { ["tradeSide"] = "long" }, ["squeeze"] = new JsonObject { ["optLeg"] = "buy", ["optSlPct"] = 30 } }), "NIFTY");
        Assert.Null(error);
        Assert.Equal("long", job!.ParamsById!["weakWall"]!["tradeSide"]!.GetValue<string>());
        Assert.Equal(30, job.ParamsById["squeeze"]!["optSlPct"]!.GetValue<int>());
        // The runner reads it as paramsById.
        Assert.Contains("\"paramsById\":{\"weakWall\"", System.Text.Json.JsonSerializer.Serialize(job, new System.Text.Json.JsonSerializerOptions(System.Text.Json.JsonSerializerDefaults.Web)));
        Assert.Contains("not one of the strategies listed", StrategyTuningController.BuildJob(ById(new JsonObject { ["cumFlip"] = new JsonObject() }), "NIFTY").Error);
        Assert.Contains("only set the tuned settings", StrategyTuningController.BuildJob(ById(new JsonObject { ["weakWall"] = new JsonObject { ["lots"] = 3 } }), "NIFTY").Error);
        Assert.Contains("must be a setting", StrategyTuningController.BuildJob(ById(new JsonObject { ["weakWall"] = 3 }), "NIFTY").Error);
        // Not sent: none.
        Assert.Null(StrategyTuningController.BuildJob(Lab(new JsonArray("weakWall")), "NIFTY").Job!.ParamsById);
    }

    [Fact]
    public void A_tuning_job_carries_the_fewest_trades_a_month_held_to_0_30_4_when_not_sent()
    {
        StrategyTuningController.RunRequest Tune(int? perMonth) => perMonth is int n
            ? new("NIFTY", new JsonArray("weakWall"), MinPerMonth: n)
            : new("NIFTY", new JsonArray("weakWall"));
        Assert.Equal(4, StrategyTuningController.BuildJob(Tune(null), "NIFTY").Job!.MinPerMonth);
        Assert.Equal(0, StrategyTuningController.BuildJob(Tune(0), "NIFTY").Job!.MinPerMonth);
        Assert.Equal(30, StrategyTuningController.BuildJob(Tune(99), "NIFTY").Job!.MinPerMonth);
        Assert.Equal(0, StrategyTuningController.BuildJob(Tune(-3), "NIFTY").Job!.MinPerMonth);
        // The runner reads it as minPerMonth; a job saved before it existed reads as 4.
        var json = System.Text.Json.JsonSerializer.Serialize(StrategyTuningController.BuildJob(Tune(6), "NIFTY").Job, new System.Text.Json.JsonSerializerOptions(System.Text.Json.JsonSerializerDefaults.Web));
        Assert.Contains("\"minPerMonth\":6", json);
        var old = System.Text.Json.JsonSerializer.Deserialize<OptionAnalytics.Server.Services.TuningJob>("{\"underlying\":\"NIFTY\",\"days\":30,\"minTrades\":8}", new System.Text.Json.JsonSerializerOptions(System.Text.Json.JsonSerializerDefaults.Web));
        Assert.Equal(4, old!.MinPerMonth);
        // Walk-forward folds: off when not sent, held to 0-5.
        StrategyTuningController.RunRequest Wf(int n) => new("NIFTY", new JsonArray("weakWall"), WalkForward: n);
        Assert.Equal(0, StrategyTuningController.BuildJob(Tune(null), "NIFTY").Job!.WalkForward);
        Assert.Equal(3, StrategyTuningController.BuildJob(Wf(3), "NIFTY").Job!.WalkForward);
        Assert.Equal(5, StrategyTuningController.BuildJob(Wf(50), "NIFTY").Job!.WalkForward);
        Assert.Equal(0, StrategyTuningController.BuildJob(Wf(-1), "NIFTY").Job!.WalkForward);
        Assert.Equal(0, old.WalkForward);
    }
}
