using Npgsql;
using OptionAnalytics.Server.Models;

namespace OptionAnalytics.Server.Services;

/// <summary>
/// Reads spot 1-minute candles from NiftyDataCollector's own TimescaleDB (spot_bars_1m) instead of
/// calling Dhan live - the spot-side counterpart to StoredRollingOptionDataService (which already
/// does this for the option-premium side). Shares that class's own connection string
/// (ConnectionStrings:NiftyDataCollectorTimescale) and the same "deliberately inert when not
/// configured" contract: a missing/blank connection string, or any real connection failure, degrades
/// this to a clean (empty, error-message) result rather than throwing - the exact shape
/// ExpiredOptionBacktestService.GetSpotCandlesAsync already falls back from onto its own on-disk
/// cache / live Dhan call.
///
/// Added because "Use stored data" previously only ever reached the option-premium fetch
/// (FetchStrikeBandAsync/FetchAcrossSegmentsAsync) - GetSpotCandlesAsync had no useStoredData
/// parameter at all, so a run with the toggle ON still called Dhan's own /charts/intraday live for
/// spot on every window the on-disk HistoricalSpotDataStore cache didn't already fully cover (its
/// own prefetch only holds roughly the last year - see HistoricalSpotDataPrefetchHostedService).
/// That is exactly the gap a real run surfaced: dozens of live /charts/intraday calls in the log with
/// the toggle checked. NiftyDataCollector already collects spot_bars_1m for both underlyings this
/// page supports, so it can close that gap the same way it already does for options.
/// </summary>
public sealed class StoredSpotDataService
{
    private readonly string? _connectionString;
    private readonly ILogger<StoredSpotDataService> _logger;

    public StoredSpotDataService(IConfiguration configuration, ILogger<StoredSpotDataService> logger)
    {
        var raw = configuration.GetConnectionString("NiftyDataCollectorTimescale");
        _connectionString = string.IsNullOrWhiteSpace(raw) ? null : raw;
        _logger = logger;
    }

    /// <summary>True only when a non-blank connection string is configured - mirrors
    /// StoredRollingOptionDataService.IsConfigured; does not verify the database is actually
    /// reachable.</summary>
    public bool IsConfigured => _connectionString is not null;

    /// <summary>Every stored bar for [fromDay,toDay] (IST calendar dates, both inclusive) - empty
    /// (with an explanatory error) when not configured, or on any real connection failure. Callers
    /// should treat empty as "nothing usable here", the same as a Dhan-side miss, not proof the
    /// window has no data at all - a caller falling back to the on-disk cache / live Dhan on empty is
    /// the expected composition.</summary>
    public async Task<(IReadOnlyList<CandleWithVolume> Bars, string? Error)> GetSpotCandlesAsync(
        string underlying, DateOnly fromDay, DateOnly toDay, CancellationToken cancellationToken)
    {
        if (_connectionString is null)
            return (Array.Empty<CandleWithVolume>(),
                "Stored data source is not configured on this server (no NiftyDataCollector database connection) - turn off 'Use stored data' to fetch live from Dhan instead.");

        try
        {
            await using var connection = new NpgsqlConnection(_connectionString);
            await connection.OpenAsync(cancellationToken);

            const string sql = """
                SELECT time, open, high, low, close, volume
                FROM spot_bars_1m
                WHERE underlying = @underlying AND time >= @from AND time < @toExclusive
                ORDER BY time
                """;

            await using var command = new NpgsqlCommand(sql, connection);
            command.Parameters.AddWithValue("underlying", underlying);
            command.Parameters.Add(new NpgsqlParameter("from", NpgsqlTypes.NpgsqlDbType.Date) { Value = fromDay.ToDateTime(TimeOnly.MinValue) });
            // Exclusive upper bound (toDay + 1) - same inclusive-toDay contract this app's other
            // date ranges use, translated to the half-open range a plain "time < x" comparison needs
            // (same convention as StoredRollingOptionDataService's own toExclusive).
            command.Parameters.Add(new NpgsqlParameter("toExclusive", NpgsqlTypes.NpgsqlDbType.Date) { Value = toDay.AddDays(1).ToDateTime(TimeOnly.MinValue) });

            var bars = new List<CandleWithVolume>();
            await using var reader = await command.ExecuteReaderAsync(cancellationToken);
            while (await reader.ReadAsync(cancellationToken))
            {
                var time = reader.GetDateTime(0);
                var open = reader.IsDBNull(1) ? 0m : reader.GetDecimal(1);
                var high = reader.IsDBNull(2) ? 0m : reader.GetDecimal(2);
                var low = reader.IsDBNull(3) ? 0m : reader.GetDecimal(3);
                var close = reader.IsDBNull(4) ? 0m : reader.GetDecimal(4);
                var volume = reader.IsDBNull(5) ? 0L : reader.GetInt64(5);

                bars.Add(new CandleWithVolume(new DateTimeOffset(time, TimeSpan.Zero), open, high, low, close, volume));
            }

            return (bars, null);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _logger.LogWarning(ex,
                "Could not read stored spot data for {Underlying} ({From}..{To}) - the database may be unreachable.",
                underlying, fromDay, toDay);
            return (Array.Empty<CandleWithVolume>(), $"Could not read stored spot data: {ex.Message}");
        }
    }
}
