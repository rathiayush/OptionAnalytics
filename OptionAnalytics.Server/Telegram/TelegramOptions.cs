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

    /// <summary>The Telegram signals page READS the channel through a Telegram USER account (the Bot API cannot read a
    /// chat's history): its api_id / api_hash from my.telegram.org. Optional - an admin can enter them on the page instead
    /// (TelegramChannelReader). ApiHash is a secret: config / environment only, never committed.</summary>
    public int ApiId { get; set; }
    public string ApiHash { get; set; } = "";

    public bool IsConfigured => Enabled && !string.IsNullOrWhiteSpace(BotToken) && !string.IsNullOrWhiteSpace(ChatId);
}
