namespace OptionAnalytics.Server.Services;

/// <summary>Bound from the "Postgres" config section - where ExpiredOptionDataStore and
/// HistoricalSpotDataStore persist their data, replacing the CSV-per-underlying/CSV-per-contract
/// files they used before ("i do not need db okay" - that decision has since been reversed in favor
/// of a real database for the full 1-year NIFTY/BANKNIFTY option+spot backfill). Individual fields
/// rather than one connection-string setting, matching how every other external credential in this
/// app (Dhan__ClientId, Dhan__Pin, ...) is supplied as separate double-underscore env vars rather
/// than one opaque string - and it sidesteps a real footgun a single URI would have here: a
/// password containing '@' is ambiguous inside a "postgresql://user:pass@host" URI unless the
/// parser is careful to split on the LAST '@', not the first.</summary>
public sealed class PostgresOptions
{
    public const string SectionName = "Postgres";

    public string Host { get; set; } = "";
    public int Port { get; set; } = 5432;
    public string Database { get; set; } = "";
    public string Username { get; set; } = "";
    public string Password { get; set; } = "";

    public bool IsConfigured =>
        !string.IsNullOrWhiteSpace(Host) && !string.IsNullOrWhiteSpace(Database) && !string.IsNullOrWhiteSpace(Username);

    public string BuildConnectionString() => new Npgsql.NpgsqlConnectionStringBuilder
    {
        Host = Host,
        Port = Port,
        Database = Database,
        Username = Username,
        Password = Password,
    }.ConnectionString;
}
