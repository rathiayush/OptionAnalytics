using OptionAnalytics.Server.Services;

namespace OptionAnalytics.Server.Tests;

/// <summary>The Postgres instance ExpiredOptionDataStoreTests/HistoricalSpotDataStoreTests run
/// against - reads the same env var names a developer or CI runner would set (POSTGRES_HOST etc.),
/// defaulting to the local Postgres a dev box or this environment already runs for
/// appsettings.json's own local-dev defaults. There is no in-memory fake for these stores: they are
/// thin wrappers over real SQL (schema creation, upsert, COPY), so the only test worth having runs
/// that SQL for real - a fake would just be re-testing the fake's own logic.</summary>
internal static class PostgresTestConfig
{
    public static PostgresOptions Load() => new()
    {
        Host = Environment.GetEnvironmentVariable("POSTGRES_HOST") ?? "localhost",
        Port = int.TryParse(Environment.GetEnvironmentVariable("POSTGRES_PORT"), out var port) ? port : 5432,
        Database = Environment.GetEnvironmentVariable("POSTGRES_DATABASE") ?? "optionanalytics",
        Username = Environment.GetEnvironmentVariable("POSTGRES_USERNAME") ?? "postgres",
        Password = Environment.GetEnvironmentVariable("POSTGRES_PASSWORD") ?? "postgres",
    };
}
