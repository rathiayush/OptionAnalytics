namespace OptionAnalytics.Server.Storage;

/// <summary>Bound from the "CandleStorage" config section. Persistence is entirely optional - the
/// app runs exactly as before (in-memory only, Dhan REST backfill on every restart) if this is
/// left disabled or the database is unreachable; see CandleRepository's graceful-degradation
/// handling. ConnectionString is a secret in the same sense as the Dhan/Telegram credentials -
/// keep it in appsettings.Local.json (gitignored), never committed.</summary>
public sealed class CandleStorageOptions
{
    public const string SectionName = "CandleStorage";

    public bool Enabled { get; set; }
    public string ConnectionString { get; set; } = "";
}
