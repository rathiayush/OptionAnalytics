using Npgsql;
using OptionAnalytics.Server.Models;

namespace OptionAnalytics.Server.Services;

/// <summary>
/// Reads rolling-option bars from NiftyDataCollector's own TimescaleDB (rolling_option_bars_1m)
/// instead of calling Dhan live - see IRollingOptionDataSource's own doc comment for how
/// ExpiredOptionBacktestService picks between this and DhanRollingOptionDataService per request.
///
/// DELIBERATELY INERT WHEN NOT CONFIGURED: ConnectionStrings:NiftyDataCollectorTimescale is empty
/// in the checked-in appsettings.json and is never set in docker-compose.yml, so a production
/// deployment has NO connection string here at all - by design, since NiftyDataCollector's own
/// database is a local-only, separate project this app has no business trying to reach in
/// production. The constructor treats a missing/blank connection string as "not configured" rather
/// than something to fail on, and GetRollingOptionCandlesAsync returns a clean, ordinary
/// (empty, error-message) result in that case - the exact same shape ExpiredOptionBacktestService
/// already treats as a normal "this source has nothing" outcome (e.g. Dhan's own "not
/// authenticated" case), never an unhandled exception. Any REAL connection failure (the local
/// Postgres instance is simply not running, network hiccup, etc.) is caught the same way, so a
/// stopped local database degrades this one data source gracefully rather than crashing the
/// request or the app.
/// </summary>
public sealed class StoredRollingOptionDataService : IRollingOptionDataSource
{
    private readonly string? _connectionString;
    private readonly ILogger<StoredRollingOptionDataService> _logger;

    public StoredRollingOptionDataService(IConfiguration configuration, ILogger<StoredRollingOptionDataService> logger)
    {
        var raw = configuration.GetConnectionString("NiftyDataCollectorTimescale");
        _connectionString = string.IsNullOrWhiteSpace(raw) ? null : raw;
        _logger = logger;
    }

    /// <summary>True only when a non-blank connection string is configured - does NOT verify the
    /// database is actually reachable (that is only found out, and handled gracefully, at query
    /// time). Exposed so a caller (e.g. a future "is stored data available" status endpoint) can
    /// report this without needing to run a query just to find out.</summary>
    public bool IsConfigured => _connectionString is not null;

    public async Task<(IReadOnlyList<(CandleWithVolume Bar, decimal? Strike, decimal? Spot, long? OpenInterest, decimal? ImpliedVolatility)> Bars, string? Error)> GetRollingOptionCandlesAsync(
        string underlying, uint underlyingSecurityId, string expiryFlag, int expiryCode, string strike, string drvOptionType,
        DateOnly fromDay, DateOnly toDay, int intervalMinutes, CancellationToken cancellationToken, bool interactive = true)
    {
        // interactive is part of IRollingOptionDataSource purely to lane DhanRollingOptionDataService's
        // own rate limiter - this implementation never calls Dhan, so it is unused here by design.
        _ = interactive;
        if (_connectionString is null)
            return (Array.Empty<(CandleWithVolume, decimal?, decimal?, long?, decimal?)>(),
                "Stored data source is not configured on this server (no NiftyDataCollector database connection) - turn off 'Use stored data' to fetch live from Dhan instead.");

        // NiftyDataCollector stores the option type as "CE"/"PE" (Dhan's own convention), while this
        // app's drvOptionType is Dhan's REQUEST-side spelling ("CALL"/"PUT") - translate once here
        // rather than pushing this app's own vocabulary into the shared table.
        var optionType = string.Equals(drvOptionType, "PUT", StringComparison.OrdinalIgnoreCase) ? "PE" : "CE";

        try
        {
            await using var connection = new NpgsqlConnection(_connectionString);
            await connection.OpenAsync(cancellationToken);

            const string sql = """
                SELECT time, open, high, low, close, volume, strike, spot_price, open_interest, implied_volatility
                FROM rolling_option_bars_1m
                WHERE underlying = @underlying AND expiry_flag = @expiryFlag AND expiry_code = @expiryCode
                  AND strike_offset = @strikeOffset AND option_type = @optionType
                  AND time >= @from AND time < @toExclusive
                ORDER BY time
                """;

            await using var command = new NpgsqlCommand(sql, connection);
            command.Parameters.AddWithValue("underlying", underlying);
            command.Parameters.AddWithValue("expiryFlag", expiryFlag);
            command.Parameters.AddWithValue("expiryCode", expiryCode);
            // "ATM"/"ATM+3"/"ATM-3" - the SAME string format both DhanRollingOptionDataService's own
            // `strike` request parameter and NiftyDataCollector's own strike_offset column already
            // use (ExpiredOptionBacktestService.StrikeToken / NiftyDataCollector's BuildStrikeOffsets
            // both produce it identically) - passed straight through, no translation needed.
            command.Parameters.AddWithValue("strikeOffset", strike);
            command.Parameters.AddWithValue("optionType", optionType);
            command.Parameters.Add(new NpgsqlParameter("from", NpgsqlTypes.NpgsqlDbType.Date) { Value = fromDay.ToDateTime(TimeOnly.MinValue) });
            // Exclusive upper bound (toDay + 1) - same inclusive-toDay contract this app's other
            // date ranges use, translated to the half-open range a plain "time < x" comparison needs.
            command.Parameters.Add(new NpgsqlParameter("toExclusive", NpgsqlTypes.NpgsqlDbType.Date) { Value = toDay.AddDays(1).ToDateTime(TimeOnly.MinValue) });

            var bars = new List<(CandleWithVolume, decimal?, decimal?, long?, decimal?)>();
            await using var reader = await command.ExecuteReaderAsync(cancellationToken);
            while (await reader.ReadAsync(cancellationToken))
            {
                var time = reader.GetDateTime(0);
                var open = reader.IsDBNull(1) ? 0m : reader.GetDecimal(1);
                var high = reader.IsDBNull(2) ? 0m : reader.GetDecimal(2);
                var low = reader.IsDBNull(3) ? 0m : reader.GetDecimal(3);
                var close = reader.IsDBNull(4) ? 0m : reader.GetDecimal(4);
                var volume = reader.IsDBNull(5) ? 0L : reader.GetInt64(5);
                var resolvedStrike = reader.IsDBNull(6) ? (decimal?)null : reader.GetDecimal(6);
                var resolvedSpot = reader.IsDBNull(7) ? (decimal?)null : reader.GetDecimal(7);
                var openInterest = reader.IsDBNull(8) ? (long?)null : reader.GetInt64(8);
                var impliedVolatility = reader.IsDBNull(9) ? (decimal?)null : reader.GetDecimal(9);

                bars.Add((new CandleWithVolume(new DateTimeOffset(time, TimeSpan.Zero), open, high, low, close, volume), resolvedStrike, resolvedSpot, openInterest, impliedVolatility));
            }

            return (bars, null);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _logger.LogWarning(ex,
                "Could not read stored rolling-option data for {Underlying} {ExpiryFlag}+{ExpiryCode} {Strike} {Side} ({From}..{To}) - the database may be unreachable.",
                underlying, expiryFlag, expiryCode, strike, drvOptionType, fromDay, toDay);
            return (Array.Empty<(CandleWithVolume, decimal?, decimal?, long?, decimal?)>(), $"Could not read stored data: {ex.Message}");
        }
    }
}
