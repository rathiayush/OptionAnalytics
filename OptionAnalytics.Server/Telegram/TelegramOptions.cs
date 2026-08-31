namespace OptionAnalytics.Server.Telegram;

/// <summary>Bound from the "Telegram" config section - same field names as LiveSpreadCalculator's
/// Telegram options, so an existing bot's credentials can be copied across unchanged. BotToken is
/// a secret (anyone holding it can post as your bot) - set it in appsettings.Local.json (gitignored),
/// never committed.</summary>
public sealed class TelegramOptions
{
    public const string SectionName = "Telegram";

    public bool Enabled { get; set; }
    public string BotToken { get; set; } = "";
    public string ChatId { get; set; } = "";
    public string ApiBaseUrl { get; set; } = "https://api.telegram.org";

    public bool IsConfigured => Enabled && !string.IsNullOrWhiteSpace(BotToken) && !string.IsNullOrWhiteSpace(ChatId);
}
