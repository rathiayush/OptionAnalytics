using System.Text.Json;
using Microsoft.Extensions.Options;

namespace OptionAnalytics.Server.Telegram;

/// <summary>Sends alert messages to a Telegram chat via the Bot API's sendMessage endpoint. A
/// thin wrapper, not a queue or retry pipeline - an alert is a "nice to know", not a trading
/// action, so a failed send is logged and dropped rather than retried (an EMA crossover alert
/// that arrives late or twice is far less useful than one dropped silently after a transient
/// network blip).</summary>
public sealed class TelegramAlertService
{
    private readonly HttpClient _httpClient;
    private readonly TelegramOptions _options;
    private readonly ILogger<TelegramAlertService> _logger;

    public TelegramAlertService(HttpClient httpClient, IOptions<TelegramOptions> options, ILogger<TelegramAlertService> logger)
    {
        _httpClient = httpClient;
        _options = options.Value;
        _logger = logger;
    }

    public async Task SendAsync(string message, CancellationToken cancellationToken)
    {
        if (!_options.IsConfigured)
        {
            _logger.LogDebug("Telegram alert skipped (Telegram:Enabled/BotToken/ChatId not configured): {Message}", message);
            return;
        }

        try
        {
            var url = $"{_options.ApiBaseUrl}/bot{_options.BotToken}/sendMessage";
            var payload = new { chat_id = _options.ChatId, text = message, parse_mode = "HTML" };

            using var response = await _httpClient.PostAsync(url, JsonContent(payload), cancellationToken);
            if (!response.IsSuccessStatusCode)
            {
                var body = await response.Content.ReadAsStringAsync(cancellationToken);
                _logger.LogWarning("Telegram alert failed (HTTP {Status}): {Body}", (int)response.StatusCode, Truncate(body));
            }
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _logger.LogWarning(ex, "Telegram alert failed to send.");
        }
    }

    private static HttpContent JsonContent(object payload) =>
        new StringContent(JsonSerializer.Serialize(payload), System.Text.Encoding.UTF8, "application/json");

    private static string Truncate(string value) => value.Length <= 300 ? value : value[..300] + "...";
}
