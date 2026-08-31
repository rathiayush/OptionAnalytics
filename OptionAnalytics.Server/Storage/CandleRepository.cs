using Microsoft.Extensions.Options;
using Npgsql;
using OptionAnalytics.Server.Models;

namespace OptionAnalytics.Server.Storage;

/// <summary>
/// Archival storage for closed 1-minute bars, backed by TimescaleDB (a Postgres extension - see
/// docker-compose.yml / README for how to run it locally). A hypertable partitioned on bar_time is
/// what TimescaleDB actually adds over plain Postgres here: transparent time-based partitioning
/// and compression for a table this app expects to grow by roughly (375 bars/trading day) x
/// (2 underlyings) forever - a few hundred rows a day is nothing today, but the schema is the part
/// that's expensive to change later, not the row count now.
///
/// Every write is a fire-and-forget best-effort: this table is a growing archive for
/// backtesting/analysis, not part of the live path anything currently on-screen depends on (the
/// chart and CDV both run entirely off SpotUnderlyingState's in-memory bars, exactly as before
/// this was added). If CandleStorage:Enabled is false, or the database is unreachable, every
/// method here becomes a no-op after logging once - the app runs exactly as it did with no
/// persistence at all, never blocked or degraded by a database problem.
///
/// Schema initialization is lazy and self-contained (EnsureInitializedAsync, called internally by
/// every other method) rather than requiring some other service to have called it first - two
/// independent hosted services (SpotFeedHostedService's backfill and CandlePersistenceService's
/// writes) both use this repository, and neither should have to know about or wait on the other's
/// startup ordering.
/// </summary>
public sealed class CandleRepository
{
    private readonly CandleStorageOptions _options;
    private readonly ILogger<CandleRepository> _logger;
    private readonly SemaphoreSlim _initLock = new(1, 1);
    private bool _schemaReady;
    private bool _loggedUnavailable;

    public CandleRepository(IOptions<CandleStorageOptions> options, ILogger<CandleRepository> logger)
    {
        _options = options.Value;
        _logger = logger;
    }

    public bool IsConfigured => _options.Enabled && !string.IsNullOrWhiteSpace(_options.ConnectionString);

    /// <summary>Upserts one closed bar. ON CONFLICT DO NOTHING because a closed bar is immutable
    /// once written - a duplicate write (e.g. after a reconnect) is a no-op, not an update.</summary>
    public async Task SaveCandleAsync(string underlying, Candle candle, CancellationToken cancellationToken)
    {
        if (!await EnsureInitializedAsync(cancellationToken)) return;

        try
        {
            await using var connection = new NpgsqlConnection(_options.ConnectionString);
            await connection.OpenAsync(cancellationToken);

            await using var cmd = connection.CreateCommand();
            cmd.CommandText = """
                INSERT INTO candles (underlying, bar_time, open, high, low, close)
                VALUES (@underlying, @bar_time, @open, @high, @low, @close)
                ON CONFLICT (underlying, bar_time) DO NOTHING
                """;
            cmd.Parameters.AddWithValue("underlying", underlying);
            cmd.Parameters.AddWithValue("bar_time", candle.Time);
            cmd.Parameters.AddWithValue("open", candle.Open);
            cmd.Parameters.AddWithValue("high", candle.High);
            cmd.Parameters.AddWithValue("low", candle.Low);
            cmd.Parameters.AddWithValue("close", candle.Close);
            await cmd.ExecuteNonQueryAsync(cancellationToken);
        }
        catch (Exception ex)
        {
            LogUnavailableOnce(ex, $"save a candle for {underlying}");
        }
    }

    /// <summary>All stored bars for one underlying within [fromUtc, toUtc], ascending. Used to
    /// warm SpotUnderlyingState on startup before falling back to a live Dhan REST backfill call -
    /// see SpotFeedHostedService.BackfillAsync.</summary>
    public async Task<IReadOnlyList<Candle>> GetCandlesAsync(string underlying, DateTimeOffset fromUtc, DateTimeOffset toUtc, CancellationToken cancellationToken)
    {
        if (!await EnsureInitializedAsync(cancellationToken)) return Array.Empty<Candle>();

        try
        {
            await using var connection = new NpgsqlConnection(_options.ConnectionString);
            await connection.OpenAsync(cancellationToken);

            await using var cmd = connection.CreateCommand();
            cmd.CommandText = """
                SELECT bar_time, open, high, low, close
                FROM candles
                WHERE underlying = @underlying AND bar_time >= @from_time AND bar_time <= @to_time
                ORDER BY bar_time ASC
                """;
            cmd.Parameters.AddWithValue("underlying", underlying);
            cmd.Parameters.AddWithValue("from_time", fromUtc);
            cmd.Parameters.AddWithValue("to_time", toUtc);

            var results = new List<Candle>();
            await using var reader = await cmd.ExecuteReaderAsync(cancellationToken);
            while (await reader.ReadAsync(cancellationToken))
            {
                results.Add(new Candle(
                    Time: reader.GetFieldValue<DateTimeOffset>(0),
                    Open: reader.GetDecimal(1),
                    High: reader.GetDecimal(2),
                    Low: reader.GetDecimal(3),
                    Close: reader.GetDecimal(4)));
            }
            return results;
        }
        catch (Exception ex)
        {
            LogUnavailableOnce(ex, $"read stored candles for {underlying}");
            return Array.Empty<Candle>();
        }
    }

    /// <summary>Creates the table/hypertable/index if they don't already exist (idempotent) the
    /// first time any method here is actually used, guarded by a lock so concurrent callers (the
    /// backfill path and the persistence path can both start around the same moment at boot)
    /// don't race to initialize twice. Returns false - meaning "give up, storage isn't usable" -
    /// without throwing, so a database that's down never stops the rest of the app.</summary>
    private async Task<bool> EnsureInitializedAsync(CancellationToken cancellationToken)
    {
        if (_schemaReady) return true;
        if (!IsConfigured) return false;

        await _initLock.WaitAsync(cancellationToken);
        try
        {
            if (_schemaReady) return true;

            await using var connection = new NpgsqlConnection(_options.ConnectionString);
            await connection.OpenAsync(cancellationToken);

            await using (var cmd = connection.CreateCommand())
            {
                cmd.CommandText = """
                    CREATE EXTENSION IF NOT EXISTS timescaledb;

                    CREATE TABLE IF NOT EXISTS candles (
                        underlying TEXT NOT NULL,
                        bar_time TIMESTAMPTZ NOT NULL,
                        open NUMERIC NOT NULL,
                        high NUMERIC NOT NULL,
                        low NUMERIC NOT NULL,
                        close NUMERIC NOT NULL,
                        PRIMARY KEY (underlying, bar_time)
                    );

                    SELECT create_hypertable('candles', 'bar_time', if_not_exists => TRUE);

                    CREATE INDEX IF NOT EXISTS ix_candles_underlying_time ON candles (underlying, bar_time DESC);
                    """;
                await cmd.ExecuteNonQueryAsync(cancellationToken);
            }

            _schemaReady = true;
            _logger.LogInformation("Candle storage schema ready (TimescaleDB hypertable 'candles').");
            return true;
        }
        catch (Exception ex)
        {
            LogUnavailableOnce(ex, "initialize the candle storage schema");
            return false;
        }
        finally
        {
            _initLock.Release();
        }
    }

    private void LogUnavailableOnce(Exception ex, string context)
    {
        if (_loggedUnavailable)
        {
            _logger.LogDebug(ex, "Candle storage still unavailable while trying to {Context}.", context);
            return;
        }

        _loggedUnavailable = true;
        _logger.LogWarning(ex, "Candle storage unavailable while trying to {Context} - continuing without persistence (in-memory/Dhan-backfill behaviour is unaffected).", context);
    }
}
