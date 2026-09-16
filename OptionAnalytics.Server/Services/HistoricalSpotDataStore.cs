using Microsoft.Extensions.Options;
using Npgsql;
using OptionAnalytics.Server.Models;

namespace OptionAnalytics.Server.Services;

/// <summary>
/// Postgres-backed cache of a year's worth of spot 1-minute candles per underlying (see
/// HistoricalSpotDataPrefetchHostedService for what actually fills it) - the one thing in this app
/// that IS persisted across a redeploy. Used to be a plain CSV per underlying, at the user's own
/// explicit request ("i do not need db okay"); that decision was reversed in favor of a real
/// database once the scope grew to a full 1-year NIFTY/BANKNIFTY backfill.
///
/// spot_data_ranges is the small "what window is covered" marker table (mirrors the old CSV cache's
/// ".meta.json" sidecar) - what HasCompleteData uses to decide "already fetched, skip" without
/// scanning spot_bars itself. spot_bars holds the actual candles. An underlying's rows are only ever
/// (re)written together, inside one transaction, right before its own marker row is upserted - a
/// process killed mid-save leaves neither behind, the same completeness guarantee the old
/// write-CSV-then-write-meta ordering gave.
///
/// NEVER LETS A POSTGRES FAILURE TAKE THE APP DOWN - HasCompleteData/Read/SaveAsync each catch and
/// log rather than throw, and schema creation at construction is wrapped too: this class is a
/// singleton a background service depends on, constructed eagerly at app startup, so an unhandled
/// exception there would crash the entire process before it ever serves a request. A failed
/// connection anywhere simply behaves as "nothing cached yet" rather than a crash.
/// </summary>
public sealed class HistoricalSpotDataStore
{
    private readonly string _connectionString;
    private readonly ILogger<HistoricalSpotDataStore> _logger;

    public HistoricalSpotDataStore(IOptions<PostgresOptions> postgresOptions, ILogger<HistoricalSpotDataStore> logger)
    {
        _connectionString = postgresOptions.Value.BuildConnectionString();
        _logger = logger;

        try
        {
            EnsureSchemaCreated();
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Could not reach Postgres to ensure the historical-spot-data schema exists - the app will keep starting, but this cache will behave as empty until Postgres is reachable.");
        }
    }

    private void EnsureSchemaCreated()
    {
        using var connection = new NpgsqlConnection(_connectionString);
        connection.Open();

        using var command = connection.CreateCommand();
        command.CommandText = """
            CREATE TABLE IF NOT EXISTS spot_data_ranges (
                underlying     TEXT PRIMARY KEY,
                from_day       DATE NOT NULL,
                to_day         DATE NOT NULL,
                fetched_at_utc TIMESTAMPTZ NOT NULL
            );

            CREATE TABLE IF NOT EXISTS spot_bars (
                underlying TEXT NOT NULL,
                bar_time   TIMESTAMPTZ NOT NULL,
                open       NUMERIC NOT NULL,
                high       NUMERIC NOT NULL,
                low        NUMERIC NOT NULL,
                close      NUMERIC NOT NULL,
                volume     BIGINT NOT NULL,
                PRIMARY KEY (underlying, bar_time)
            );
            """;
        command.ExecuteNonQuery();
    }

    /// <summary>True when a previous prefetch already saved data covering at least
    /// [requiredFromDay, requiredToDay] - the guard that makes the background prefetch a genuine
    /// one-time job rather than something that re-fetches a whole year from Dhan on every
    /// restart.</summary>
    public bool HasCompleteData(string underlying, DateOnly requiredFromDay, DateOnly requiredToDay)
    {
        try
        {
            using var connection = new NpgsqlConnection(_connectionString);
            connection.Open();

            using var command = connection.CreateCommand();
            command.CommandText = "SELECT from_day, to_day FROM spot_data_ranges WHERE underlying = @underlying";
            command.Parameters.AddWithValue("underlying", underlying.ToUpperInvariant());

            using var reader = command.ExecuteReader();
            if (!reader.Read()) return false;

            var fromDay = DateOnly.FromDateTime(reader.GetDateTime(0));
            var toDay = DateOnly.FromDateTime(reader.GetDateTime(1));
            return fromDay <= requiredFromDay && toDay >= requiredToDay;
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Could not reach Postgres to check the historical-spot-data cache for {Underlying} - treating it as not cached.", underlying);
            return false;
        }
    }

    /// <summary>Every cached candle for [fromDay,toDay] (IST calendar dates, both inclusive) -
    /// callers should check HasCompleteData first; this just returns whatever is saved in that
    /// window, empty if nothing was ever saved for this underlying.</summary>
    public IReadOnlyList<CandleWithVolume> Read(string underlying, DateOnly fromDay, DateOnly toDay)
    {
        try
        {
            using var connection = new NpgsqlConnection(_connectionString);
            connection.Open();

            using var command = connection.CreateCommand();
            command.CommandText = """
                SELECT bar_time, open, high, low, close, volume
                FROM spot_bars
                WHERE underlying = @underlying AND bar_time >= @fromInclusiveUtc AND bar_time < @toExclusiveUtc
                ORDER BY bar_time
                """;
            command.Parameters.AddWithValue("underlying", underlying.ToUpperInvariant());
            // Both boundaries in UTC, converted from the requested IST calendar-day window - IST has
            // no DST, so a fixed +5:30 offset is exact for any date.
            command.Parameters.AddWithValue("fromInclusiveUtc", IstClock.AtIstTime(fromDay, 0).UtcDateTime);
            command.Parameters.AddWithValue("toExclusiveUtc", IstClock.AtIstTime(toDay.AddDays(1), 0).UtcDateTime);

            var result = new List<CandleWithVolume>();
            using var reader = command.ExecuteReader();
            while (reader.Read())
            {
                var time = new DateTimeOffset(reader.GetDateTime(0), TimeSpan.Zero);
                result.Add(new CandleWithVolume(time, reader.GetDecimal(1), reader.GetDecimal(2), reader.GetDecimal(3), reader.GetDecimal(4), reader.GetInt64(5)));
            }

            return result;
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Could not reach Postgres to read the historical-spot-data cache for {Underlying} - returning empty.", underlying);
            return Array.Empty<CandleWithVolume>();
        }
    }

    /// <summary>Replaces this underlying's whole row set with <paramref name="candles"/> (assumed
    /// already time-ascending), and only then upserts the marker row recording [fromDay,toDay] as
    /// covered - all inside one transaction, so a process killed mid-save can never leave a marker
    /// claiming coverage the bars themselves don't have (same guarantee the old write-CSV-then-
    /// write-meta ordering gave).</summary>
    public async Task SaveAsync(string underlying, DateOnly fromDay, DateOnly toDay, IReadOnlyList<CandleWithVolume> candles, CancellationToken cancellationToken)
    {
        var normalizedUnderlying = underlying.ToUpperInvariant();

        try
        {
            await using var connection = new NpgsqlConnection(_connectionString);
            await connection.OpenAsync(cancellationToken);
            await using var transaction = await connection.BeginTransactionAsync(cancellationToken);

            await using (var delete = connection.CreateCommand())
            {
                delete.Transaction = transaction;
                delete.CommandText = "DELETE FROM spot_bars WHERE underlying = @underlying";
                delete.Parameters.AddWithValue("underlying", normalizedUnderlying);
                await delete.ExecuteNonQueryAsync(cancellationToken);
            }

            await using (var importer = await connection.BeginBinaryImportAsync(
                "COPY spot_bars (underlying, bar_time, open, high, low, close, volume) FROM STDIN (FORMAT BINARY)", cancellationToken))
            {
                foreach (var c in candles)
                {
                    await importer.StartRowAsync(cancellationToken);
                    await importer.WriteAsync(normalizedUnderlying, NpgsqlTypes.NpgsqlDbType.Text, cancellationToken);
                    await importer.WriteAsync(c.Time.UtcDateTime, NpgsqlTypes.NpgsqlDbType.TimestampTz, cancellationToken);
                    await importer.WriteAsync(c.Open, NpgsqlTypes.NpgsqlDbType.Numeric, cancellationToken);
                    await importer.WriteAsync(c.High, NpgsqlTypes.NpgsqlDbType.Numeric, cancellationToken);
                    await importer.WriteAsync(c.Low, NpgsqlTypes.NpgsqlDbType.Numeric, cancellationToken);
                    await importer.WriteAsync(c.Close, NpgsqlTypes.NpgsqlDbType.Numeric, cancellationToken);
                    await importer.WriteAsync(c.Volume, NpgsqlTypes.NpgsqlDbType.Bigint, cancellationToken);
                }
                await importer.CompleteAsync(cancellationToken);
            }

            await using (var upsert = connection.CreateCommand())
            {
                upsert.Transaction = transaction;
                upsert.CommandText = """
                    INSERT INTO spot_data_ranges (underlying, from_day, to_day, fetched_at_utc)
                    VALUES (@underlying, @fromDay, @toDay, @fetchedAtUtc)
                    ON CONFLICT (underlying)
                    DO UPDATE SET from_day = EXCLUDED.from_day, to_day = EXCLUDED.to_day, fetched_at_utc = EXCLUDED.fetched_at_utc
                    """;
                upsert.Parameters.AddWithValue("underlying", normalizedUnderlying);
                upsert.Parameters.AddWithValue("fromDay", fromDay);
                upsert.Parameters.AddWithValue("toDay", toDay);
                upsert.Parameters.AddWithValue("fetchedAtUtc", DateTime.UtcNow);
                await upsert.ExecuteNonQueryAsync(cancellationToken);
            }

            await transaction.CommitAsync(cancellationToken);

            _logger.LogInformation("Saved {Count} cached spot candle(s) for {Underlying} ({From}..{To}).", candles.Count, underlying, fromDay, toDay);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _logger.LogWarning(ex, "Could not reach Postgres to save the historical-spot-data cache for {Underlying} - it will retry on the next prefetch run.", underlying);
        }
    }
}
