using System.Text.Json;
using OptionAnalytics.Server.Services;
using Xunit;

namespace OptionAnalytics.Server.Tests;

public class LoadProgressTests
{
    private static JsonElement Snap(LoadProgress p, int since = 0) => JsonSerializer.SerializeToElement(p.Snapshot(since), new JsonSerializerOptions(JsonSerializerDefaults.Web));

    [Fact]
    public async Task What_a_load_does_is_recorded_from_every_task_it_starts_and_nothing_outside_it()
    {
        var store = new LoadProgressStore();
        var progress = store.Start("abc");
        LoadProgress.Info("before"); // outside the load: not recorded
        using (LoadProgress.Use(progress))
        {
            LoadProgress.AddTotal(3);
            await Task.WhenAll(Enumerable.Range(0, 3).Select(i => Task.Run(() =>
            {
                LoadProgress.DhanCall();
                if (i == 0) { LoadProgress.RateLimited(); LoadProgress.Warn("rate limited"); }
                LoadProgress.Done(failed: i == 2);
            })));
            LoadProgress.Recovered();
        }
        LoadProgress.Info("after");
        progress.Finish(null);

        var s = Snap(progress);
        Assert.Equal((3, 3, 0, 3, 1), (s.GetProperty("total").GetInt32(), s.GetProperty("done").GetInt32(), s.GetProperty("failed").GetInt32(),
            s.GetProperty("dhanCalls").GetInt32(), s.GetProperty("rateLimited").GetInt32()));
        Assert.True(s.GetProperty("finished").GetBoolean());
        var texts = s.GetProperty("entries").EnumerateArray().Select(e => e.GetProperty("text").GetString()).ToList();
        Assert.Contains("rate limited", texts);
        Assert.DoesNotContain("before", texts);
        Assert.DoesNotContain("after", texts);
        Assert.Same(progress, store.Get("abc"));
    }

    [Fact]
    public void The_page_reads_only_the_entries_it_has_not_seen()
    {
        var progress = new LoadProgress("x");
        for (var i = 0; i < 5; i++) progress.Add("info", $"e{i}");
        var first = Snap(progress);
        Assert.Equal(5, first.GetProperty("next").GetInt32());
        progress.Add("info", "e5");
        var next = Snap(progress, since: 5);
        Assert.Equal(new[] { "e5" }, next.GetProperty("entries").EnumerateArray().Select(e => e.GetProperty("text").GetString()));
        // Past the 400 kept, the oldest drop off but the cursor still lands right.
        for (var i = 6; i < 500; i++) progress.Add("info", $"e{i}");
        var late = Snap(progress, since: 498);
        Assert.Equal(new[] { "e498", "e499" }, late.GetProperty("entries").EnumerateArray().Select(e => e.GetProperty("text").GetString()));
    }
}
