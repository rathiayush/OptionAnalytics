using System.Net;
using System.Text;
using System.Text.Json.Nodes;
using Microsoft.Extensions.Configuration;
using OptionAnalytics.Server.Services;

namespace OptionAnalytics.Server.Tests;

/// <summary>AI analysis of a report by a local model (LlmAnalysisService) - against a fake Ollama.</summary>
public class LlmAnalysisServiceTests
{
    private sealed class FakeOllama : HttpMessageHandler
    {
        public List<(string Path, string? Body)> Calls { get; } = [];
        public string[] Models { get; set; } = ["qwen2.5:14b", "gemma3:27b"];
        public HttpStatusCode ChatStatus { get; set; } = HttpStatusCode.OK;
        public string Reply { get; set; } = "It holds on both halves.";
        public bool Down { get; set; }
        public bool DropChat { get; set; }
        public int Delay { get; set; }

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            if (Down) throw new HttpRequestException("connection refused");
            var path = request.RequestUri!.AbsolutePath;
            Calls.Add((path, request.Content is null ? null : await request.Content.ReadAsStringAsync(ct)));
            if (path == "/api/tags")
                return Json(new JsonObject { ["models"] = new JsonArray(Models.Select(m => (JsonNode)new JsonObject { ["name"] = m }).ToArray()) }.ToJsonString());
            if (DropChat) throw new HttpRequestException("The response ended prematurely.", new IOException("ResponseEnded"));
            if (Delay > 0) await Task.Delay(Delay, ct);
            return new HttpResponseMessage(ChatStatus)
            {
                Content = new StringContent(ChatStatus == HttpStatusCode.OK
                    ? new JsonObject { ["message"] = new JsonObject { ["role"] = "assistant", ["content"] = Reply } }.ToJsonString()
                    : "model exploded", Encoding.UTF8, "application/json"),
            };
        }
        private static HttpResponseMessage Json(string s) => new(HttpStatusCode.OK) { Content = new StringContent(s, Encoding.UTF8, "application/json") };
    }

    private static LlmAnalysisService Make(FakeOllama fake, Dictionary<string, string?>? config = null) =>
        new(new HttpClient(fake), new ConfigurationBuilder().AddInMemoryCollection(config ?? []).Build());

    [Fact]
    public async Task The_status_lists_the_installed_models_and_the_default()
    {
        var status = await Make(new FakeOllama()).GetStatusAsync(default);
        Assert.True(status.Enabled);
        Assert.True(status.Available);
        Assert.Equal("qwen2.5:14b", status.DefaultModel);
        Assert.Equal(["gemma3:27b", "qwen2.5:14b"], status.Models);
    }

    [Fact]
    public async Task A_model_server_that_is_not_running_says_so_and_is_not_an_error()
    {
        var status = await Make(new FakeOllama { Down = true }).GetStatusAsync(default);
        Assert.False(status.Available);
        Assert.Contains("start Ollama", status.Reason);
    }

    [Fact]
    public async Task A_report_is_sent_with_the_prompt_that_forbids_inventing_numbers_and_the_answer_comes_back()
    {
        var fake = new FakeOllama();
        var answer = await Make(fake).AnalyseAsync("REPORT-TEXT 123", "Why did it lose on Tuesdays?", null, default);

        Assert.Equal("It holds on both halves.", answer.Text);
        Assert.Equal("qwen2.5:14b", answer.Model);
        var chat = JsonNode.Parse(fake.Calls.Single(c => c.Path == "/api/chat").Body!)!;
        Assert.False(chat["stream"]!.GetValue<bool>());
        var messages = chat["messages"]!.AsArray();
        Assert.Contains("Never invent a number", messages[0]!["content"]!.GetValue<string>());
        var user = messages[1]!["content"]!.GetValue<string>();
        Assert.Contains("REPORT-TEXT 123", user);
        Assert.Contains("Why did it lose on Tuesdays?", user);
    }

    [Fact]
    public async Task Only_an_installed_model_can_be_picked()
    {
        var fake = new FakeOllama();
        var ok = await Make(fake).AnalyseAsync("r", null, "gemma3:27b", default);
        Assert.Equal("gemma3:27b", ok.Model);

        var e = await Assert.ThrowsAsync<LlmException>(() => Make(fake).AnalyseAsync("r", null, "evil:1b", default));
        Assert.Equal(400, e.Status);
        Assert.DoesNotContain(fake.Calls, c => c.Body?.Contains("evil:1b") == true);
    }

    [Fact]
    public async Task An_empty_report_a_switched_off_service_and_a_missing_server_are_refused_with_a_reason()
    {
        Assert.Equal(400, (await Assert.ThrowsAsync<LlmException>(() => Make(new FakeOllama()).AnalyseAsync("  ", null, null, default))).Status);
        Assert.Equal(503, (await Assert.ThrowsAsync<LlmException>(() => Make(new FakeOllama(), new() { ["Llm:Enabled"] = "false" }).AnalyseAsync("r", null, null, default))).Status);
        Assert.Equal(503, (await Assert.ThrowsAsync<LlmException>(() => Make(new FakeOllama { Down = true }).AnalyseAsync("r", null, null, default))).Status);
    }

    [Fact]
    public async Task A_model_error_is_passed_on_as_a_bad_gateway()
    {
        var e = await Assert.ThrowsAsync<LlmException>(() => Make(new FakeOllama { ChatStatus = HttpStatusCode.InternalServerError }).AnalyseAsync("r", null, null, default));
        Assert.Equal(502, e.Status);
        Assert.Contains("model exploded", e.Message);
    }

    [Fact]
    public async Task A_connection_the_model_server_drops_part_way_is_a_bad_gateway_not_a_crash()
    {
        var e = await Assert.ThrowsAsync<LlmException>(() => Make(new FakeOllama { DropChat = true }).AnalyseAsync("r", null, null, default));
        Assert.Equal(504, e.Status);
        Assert.Contains("stopped answering", e.Message);
    }

    [Fact]
    public async Task A_caller_that_gave_up_is_a_cancellation_not_a_model_error()
    {
        using var cts = new CancellationTokenSource();
        var task = Make(new FakeOllama { Delay = 5000 }).AnalyseAsync("r", null, null, cts.Token);
        await Task.Delay(200);
        cts.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => task);
    }

    [Fact]
    public async Task A_long_report_is_cut_and_the_model_is_told()
    {
        var fake = new FakeOllama();
        await Make(fake, new() { ["Llm:MaxChars"] = "2000" }).AnalyseAsync(new string('x', 5000), null, null, default);
        var user = JsonNode.Parse(fake.Calls.Single(c => c.Path == "/api/chat").Body!)!["messages"]![1]!["content"]!.GetValue<string>();
        Assert.True(user.Length < 2300);
        Assert.Contains("cut to its first 2000", user);
    }

    [Fact]
    public async Task One_analysis_runs_at_a_time_and_a_crowd_is_turned_away()
    {
        var fake = new FakeOllama { Delay = 400 };
        var llm = Make(fake);
        var tasks = Enumerable.Range(0, 6).Select(_ => Task.Run(async () =>
        {
            try { await llm.AnalyseAsync("r", null, null, default); return 200; }
            catch (LlmException e) { return e.Status; }
        })).ToArray();
        var results = await Task.WhenAll(tasks);
        Assert.Contains(429, results);
        Assert.Contains(200, results);
        // Never two at once: the fake saw the chats one after another.
        Assert.Equal(results.Count(r => r == 200), fake.Calls.Count(c => c.Path == "/api/chat"));
    }
}
