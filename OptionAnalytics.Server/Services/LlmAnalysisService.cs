using System.Diagnostics;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace OptionAnalytics.Server.Services;

/// <summary>
/// AI analysis of a run's report by a LOCAL language model (Ollama - <c>Llm:BaseUrl</c>, default http://localhost:11434;
/// nothing leaves the machine). Asked for - "integrate everything into our system, we should be able to analyse every run".
/// The page builds a compact TEXT of a report (Signal backtest, Feature finder, Compare all - <c>llmAnalysis.js</c>) and sends it
/// here; the model only INTERPRETS the numbers it is given (the prompt forbids inventing any), never computes them, and its
/// answer is a lead to backtest, not a signal. It feeds no strategy, alert or order.
/// One analysis at a time (a 14 - 27B model fills the machine's memory); a request waits its turn or is refused when the
/// queue is full. The model is picked from the ones installed (<c>GET /api/tags</c>) - never an arbitrary name.
/// </summary>
public sealed class LlmAnalysisService
{
    public const int DefaultMaxChars = 60_000;
    public const int MaxAsk = 1_000;

    internal const string SystemPrompt =
        "You are a careful quantitative analyst reading a report from an index-options backtest tool (NIFTY / BANKNIFTY / SENSEX). " +
        "Use ONLY the numbers in the report. Never invent a number, a reading or a result; if something is not in the report, say so. " +
        "Be skeptical: a result counts only if it holds across the earlier AND the later days; few days or trades means a hint, not proof. " +
        "Remember charges and slippage, and that many minute rows on one day are not independent. Past results do not promise future ones. " +
        "Answer in this order: 1) what the report is, 2) what looks real and why, 3) what looks like noise or overfitting, " +
        "4) ONE concrete rule or setting to backtest next, using only the readings named in the report, 5) what would make you drop it. " +
        "Keep it under 400 words. This is research, not a trading signal or financial advice.";

    private readonly HttpClient _http;
    private readonly string _defaultModel;
    private readonly bool _enabled;
    private readonly int _maxChars;
    private readonly SemaphoreSlim _one = new(1, 1);
    private int _waiting;

    public LlmAnalysisService(HttpClient http, IConfiguration configuration)
    {
        _http = http;
        var baseUrl = configuration["Llm:BaseUrl"];
        _http.BaseAddress = new Uri(string.IsNullOrWhiteSpace(baseUrl) ? "http://localhost:11434" : baseUrl.TrimEnd('/') + "/");
        // A 27B model on a laptop answers in a minute or two; the first call also loads it into memory.
        _http.Timeout = TimeSpan.FromSeconds(int.TryParse(configuration["Llm:TimeoutSeconds"], out var t) && t > 0 ? t : 600);
        _defaultModel = string.IsNullOrWhiteSpace(configuration["Llm:Model"]) ? "qwen2.5:14b" : configuration["Llm:Model"]!;
        _enabled = !string.Equals(configuration["Llm:Enabled"], "false", StringComparison.OrdinalIgnoreCase);
        _maxChars = int.TryParse(configuration["Llm:MaxChars"], out var m) && m > 1000 ? m : DefaultMaxChars;
    }

    public record Status(bool Enabled, bool Available, string DefaultModel, IReadOnlyList<string> Models, string? Reason);
    public record Answer(string Text, string Model, double Seconds);

    /// <summary>Whether analysis is on and the model server answers, and which models it has installed.</summary>
    public async Task<Status> GetStatusAsync(CancellationToken ct)
    {
        if (!_enabled) return new Status(false, false, _defaultModel, [], "AI analysis is switched off (Llm:Enabled).");
        try
        {
            using var linked = CancellationTokenSource.CreateLinkedTokenSource(ct);
            linked.CancelAfter(TimeSpan.FromSeconds(5));
            var tags = await _http.GetFromJsonAsync<JsonNode>("api/tags", linked.Token);
            var models = tags?["models"]?.AsArray().Select(n => n?["name"]?.GetValue<string>()).OfType<string>().OrderBy(n => n).ToList() ?? [];
            var reason = models.Count == 0 ? "The model server has no model installed (ollama pull qwen2.5:14b)." : null;
            return new Status(true, models.Count > 0, models.Contains(_defaultModel) ? _defaultModel : models.FirstOrDefault() ?? _defaultModel, models, reason);
        }
        catch (Exception e) when (e is HttpRequestException or IOException or TaskCanceledException or JsonException or InvalidOperationException)
        {
            if (ct.IsCancellationRequested) throw;
            return new Status(true, false, _defaultModel, [], $"The model server is not running at {_http.BaseAddress} - start Ollama.");
        }
    }

    /// <summary>The analysis of <paramref name="text"/>. Throws <see cref="LlmException"/> with a message for the page.</summary>
    public async Task<Answer> AnalyseAsync(string? text, string? ask, string? model, CancellationToken ct)
    {
        if (!_enabled) throw new LlmException("AI analysis is switched off (Llm:Enabled).", 503);
        if (string.IsNullOrWhiteSpace(text)) throw new LlmException("Nothing to analyse - the report is empty.", 400);
        var cut = text.Length > _maxChars;
        if (cut) text = text[.._maxChars];
        ask = string.IsNullOrWhiteSpace(ask) ? null : ask.Trim()[..Math.Min(ask.Trim().Length, MaxAsk)];

        var status = await GetStatusAsync(ct);
        if (!status.Available) throw new LlmException(status.Reason ?? "The model server is not available.", 503);
        var chosen = string.IsNullOrWhiteSpace(model) ? status.DefaultModel : model.Trim();
        if (!status.Models.Contains(chosen)) throw new LlmException($"Model '{chosen}' is not installed. Installed: {string.Join(", ", status.Models)}.", 400);

        if (Interlocked.Increment(ref _waiting) > 3)
        {
            Interlocked.Decrement(ref _waiting);
            throw new LlmException("Another analysis is already running (and others are waiting) - try again in a minute.", 429);
        }
        try
        {
            await _one.WaitAsync(ct);
            try
            {
                var watch = Stopwatch.StartNew();
                var user = (ask is null ? "" : ask + "\n\n") + "Report:\n\n" + text +
                           (cut ? $"\n\n[The report was cut to its first {_maxChars} characters.]" : "");
                var body = new JsonObject
                {
                    ["model"] = chosen,
                    ["stream"] = false,
                    ["options"] = new JsonObject { ["num_ctx"] = 16384, ["temperature"] = 0.2 },
                    ["messages"] = new JsonArray
                    {
                        new JsonObject { ["role"] = "system", ["content"] = SystemPrompt },
                        new JsonObject { ["role"] = "user", ["content"] = user },
                    },
                };
                using var response = await _http.PostAsJsonAsync("api/chat", body, ct);
                var raw = await response.Content.ReadAsStringAsync(ct);
                if (!response.IsSuccessStatusCode)
                    throw new LlmException($"The model server answered {(int)response.StatusCode}: {Trim(raw)}", 502);
                var content = JsonNode.Parse(raw)?["message"]?["content"]?.GetValue<string>();
                if (string.IsNullOrWhiteSpace(content)) throw new LlmException("The model sent an empty answer.", 502);
                return new Answer(content.Trim(), chosen, Math.Round(watch.Elapsed.TotalSeconds, 1));
            }
            finally { _one.Release(); }
        }
        catch (Exception e) when (e is HttpRequestException or IOException or TaskCanceledException && !ct.IsCancellationRequested)
        {
            // The model server closed the connection part way (restarted, out of memory) or timed out. A caller that gave up
            // (ct cancelled) is NOT this - that passes through as a cancellation.
            throw new LlmException($"The model server stopped answering ({Describe(e)}) - it may have restarted or run out of memory. Try again.", 504);
        }
        finally { Interlocked.Decrement(ref _waiting); }
    }

    private static string Describe(Exception e) => (e.InnerException ?? e).Message;

    private static string Trim(string s) => s.Length <= 300 ? s : s[..300];
}

/// <summary>A refusal the page can show: the message and the HTTP status to send.</summary>
public sealed class LlmException(string message, int status) : Exception(message)
{
    public int Status { get; } = status;
}
