using OptionAnalytics.Server.Services;

namespace OptionAnalytics.Server.Tests;

/// <summary>The learning report: a condition at the signal is suggested only when it wins clearly AND steadily (on the
/// older and the newer signals), with enough signals each side; turned to the trade's side; one signal counted once.</summary>
public sealed class LearningReportTests
{
    private static Dictionary<string, string> S(int i, string side, double r, double? tape, double? big = null, string u = "NIFTY") => new()
    {
        ["underlying"] = u, ["strategy_id"] = "trap", ["strategy_no"] = "17", ["strategy"] = "Breakout trap", ["side"] = side,
        ["time_ist"] = $"2026-09-{1 + i / 4:00} 10:{i % 60:00}:00", ["status"] = r > 0 ? "win" : "loss", ["r"] = r.ToString(System.Globalization.CultureInfo.InvariantCulture),
        ["mkt_tape60"] = tape?.ToString(System.Globalization.CultureInfo.InvariantCulture) ?? "", ["mkt_big_net"] = big?.ToString(System.Globalization.CultureInfo.InvariantCulture) ?? "",
    };

    [Fact]
    public void ATapeEdge_HeldOnOlderAndNewerSignals_IsSuggested_OnTheTradesSide()
    {
        // 40 signals: tape with the trade (LONG bought 62% / SHORT sold 62%) wins 1.5R, against it loses 1R - all along.
        var rows = Enumerable.Range(0, 40).Select(i =>
        {
            var side = i % 2 == 0 ? "LONG" : "SHORT";
            var with = i % 4 < 2;
            var tape = with ? (side == "LONG" ? 62 : 38) : (side == "LONG" ? 40 : 60);
            return S(i, side, with ? 1.5 : -1, tape);
        }).ToList();
        var s = Assert.Single(LearningReport.Build(rows));
        Assert.Equal((40, 50.0, 0.25), (s.Signals, s.WinPct!.Value, s.AvgR!.Value));
        var tape = s.Findings.Single(f => f.Condition == "tape");
        Assert.True(tape.Suggested, tape.Why);
        Assert.Equal(("tradeTape", "with"), (tape.Filter, tape.Mode));
        Assert.Equal((20, 100.0, 1.5), (tape.Met.Signals, tape.Met.WinPct!.Value, tape.Met.AvgR!.Value));
        Assert.Equal(2.5, tape.LiftR!.Value, 6);
        Assert.True(tape.HeldOlder && tape.HeldNewer);
        Assert.Equal("tape", s.Findings[0].Condition); // suggested first
    }

    [Fact]
    public void AnEdgeOfOneStretchOnly_OrTooFewSignals_IsNotSuggested()
    {
        // The tape "worked" only on the older half; on the newer half it did not.
        var rows = Enumerable.Range(0, 40).Select(i => S(i, "LONG", i < 20 ? (i % 2 == 0 ? 1.5 : -1) : (i % 2 == 0 ? -1 : 1.5), i % 2 == 0 ? 62 : 40)).ToList();
        var tape = LearningReport.Build(rows).Single().Findings.Single(f => f.Condition == "tape");
        Assert.False(tape.Suggested);
        // Few signals.
        var few = Enumerable.Range(0, 10).Select(i => S(i, "LONG", i % 2 == 0 ? 2 : -1, i % 2 == 0 ? 62 : 40)).ToList();
        var f2 = LearningReport.Build(few).Single().Findings.Single(f => f.Condition == "tape");
        Assert.False(f2.Suggested);
        Assert.Contains("too few", f2.Why);
    }

    [Fact]
    public void BlankNumbers_AreLeftOut_OpenSignalsIgnored_AndASignalInBothRecordsCountsOnce()
    {
        var rows = new List<Dictionary<string, string>> { S(1, "LONG", 1, 62, 10), S(2, "LONG", -1, null, -5), S(1, "LONG", 1, 62, 10) };
        rows.Add(new Dictionary<string, string>(S(3, "LONG", 1, 62)) { ["status"] = "open" });
        var s = Assert.Single(LearningReport.Build(rows));
        Assert.Equal(2, s.Signals);                       // the duplicate once, the open one out
        var tape = s.Findings.Single(f => f.Condition == "tape");
        Assert.Equal(1, tape.Met.Signals + tape.NotMet.Signals); // the blank tape left out
        Assert.Equal(2, s.Findings.Single(f => f.Condition == "big").Met.Signals + s.Findings.Single(f => f.Condition == "big").NotMet.Signals);
    }
}
