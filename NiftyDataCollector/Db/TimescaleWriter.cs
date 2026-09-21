using Npgsql;
using NiftyDataCollector.Dhan;

namespace NiftyDataCollector.Db;

/// <summary>
/// Every write this collector makes to Postgres/TimescaleDB, plus the one-time schema apply on
/// startup. Uses ON CONFLICT DO UPDATE (upsert) on every insert rather than plain INSERT - this
/// collector's own fetch loops can legitimately re-fetch a bar or re-poll a snapshot for a time
/// already written (a retried historical range, a restart resuming mid-session), and an upsert
/// makes that safe to just re-run rather than needing to track "have I already written this row"
/// state separately.
/// </summary>
public sealed class TimescaleWriter
{
    private readonly string _connectionString;
    private readonly ILogger<TimescaleWriter> _logger;

    private readonly SemaphoreSlim _schemaLock = new(1, 1);
    private bool _schemaEnsured;

    public TimescaleWriter(IConfiguration configuration, ILogger<TimescaleWriter> logger)
    {
        _connectionString = configuration.GetConnectionString("Timescale")
            ?? throw new InvalidOperationException("ConnectionStrings:Timescale is not configured - see appsettings.json.");
        _logger = logger;
    }

    /// <summary>Creates the target database (see EnsureDatabaseExistsAsync) if it doesn't exist
    /// yet, then applies Schema.sql against it - the collector's own connection string can point at
    /// a database that has never been created before and this still works, no manual pgAdmin/psql
    /// step required first.
    ///
    /// Guarded to run AT MOST ONCE per process, no matter how many hosted services call it (both
    /// CollectorHostedService and RollingOptionBackfillHostedService do, and both start
    /// concurrently with no ordering guarantee) - without this, two concurrent callers can both run
    /// Schema.sql's own "CREATE EXTENSION IF NOT EXISTS timescaledb" at once and hit Postgres'
    /// own well-known race there (the existence check and the catalog insert aren't atomic
    /// together, so both callers can decide it doesn't exist yet and then collide on
    /// pg_extension's unique index - exactly the "duplicate key value violates unique constraint
    /// pg_extension_name_index" this once threw in practice).</summary>
    public async Task EnsureSchemaAsync(CancellationToken cancellationToken)
    {
        if (_schemaEnsured) return;

        await _schemaLock.WaitAsync(cancellationToken);
        try
        {
            if (_schemaEnsured) return;

            await EnsureDatabaseExistsAsync(cancellationToken);

            var schemaPath = Path.Combine(AppContext.BaseDirectory, "Db", "Schema.sql");
            var sql = await File.ReadAllTextAsync(schemaPath, cancellationToken);

            await using var connection = new NpgsqlConnection(_connectionString);
            await connection.OpenAsync(cancellationToken);
            await using var command = new NpgsqlCommand(sql, connection);
            await command.ExecuteNonQueryAsync(cancellationToken);

            _schemaEnsured = true;
            _logger.LogInformation("TimescaleDB schema is up to date.");
        }
        finally
        {
            _schemaLock.Release();
        }
    }

    /// <summary>Connects to Postgres' own "postgres" maintenance database (never the collector's own
    /// target database, which is exactly the one that might not exist yet) to check for - and if
    /// missing, create - the database named in ConnectionStrings:Timescale. The connecting role
    /// needs CREATEDB privilege for this to succeed (the default "postgres" superuser role
    /// always has it); a role without it gets Postgres' own permission-denied error surfaced
    /// straight through, which is a clearer failure than a confusing "database does not exist"
    /// from the schema-apply step right after.</summary>
    private async Task EnsureDatabaseExistsAsync(CancellationToken cancellationToken)
    {
        var builder = new NpgsqlConnectionStringBuilder(_connectionString);
        var targetDatabase = builder.Database;
        if (string.IsNullOrWhiteSpace(targetDatabase))
            throw new InvalidOperationException("ConnectionStrings:Timescale must specify a Database.");

        builder.Database = "postgres";

        await using var connection = new NpgsqlConnection(builder.ConnectionString);
        await connection.OpenAsync(cancellationToken);

        await using (var checkCommand = new NpgsqlCommand("SELECT 1 FROM pg_database WHERE datname = @name", connection))
        {
            checkCommand.Parameters.AddWithValue("name", targetDatabase);
            if (await checkCommand.ExecuteScalarAsync(cancellationToken) is not null) return; // already exists
        }

        // CREATE DATABASE cannot run inside a transaction, and Postgres has no parameterized way to
        // pass an identifier - NpgsqlConnectionStringBuilder having already accepted this name as a
        // valid Database value doesn't rule out it containing a double-quote, so it is escaped here
        // the standard SQL way (doubling any embedded quote) before being interpolated.
        var quotedName = targetDatabase.Replace("\"", "\"\"");
        await using var createCommand = new NpgsqlCommand($"CREATE DATABASE \"{quotedName}\"", connection);
        await createCommand.ExecuteNonQueryAsync(cancellationToken);

        _logger.LogInformation("Created database \"{Database}\" - it did not exist yet.", targetDatabase);
    }

    /// <summary>The contiguous [From, Through] window this series' historical backfill currently
    /// covers, or null if it has never completed even one chunk - see Schema.sql's own doc comment
    /// on backfill_progress for the forward/backward extension rules this relies on, and for what
    /// a seriesKey is (a plain security_id for a spot/option-contract backfill, or a synthetic
    /// "ROLLING:underlying:expiryFlag:expiryCode:strikeOffset:optionType" key for a rolling-option
    /// series).</summary>
    public async Task<(DateOnly From, DateOnly Through)?> GetBackfillCheckpointAsync(string seriesKey, CancellationToken cancellationToken)
    {
        await using var connection = new NpgsqlConnection(_connectionString);
        await connection.OpenAsync(cancellationToken);

        await using var command = new NpgsqlCommand("SELECT completed_from, completed_through FROM backfill_progress WHERE series_key = @key", connection);
        command.Parameters.AddWithValue("key", seriesKey);

        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        if (!await reader.ReadAsync(cancellationToken)) return null;
        return (DateOnly.FromDateTime(reader.GetDateTime(0)), DateOnly.FromDateTime(reader.GetDateTime(1)));
    }

    /// <summary>Sets (or creates) this series' full checkpoint window - callers always pass BOTH
    /// bounds (not just whichever one moved) since this is a plain overwrite, not an increment; see
    /// Schema.sql's own doc comment on backfill_progress for the different rules callers must
    /// follow for growing completed_through (every successful chunk) vs completed_from (only once
    /// a whole backward-extension range succeeds end to end).</summary>
    public async Task SaveBackfillCheckpointAsync(string seriesKey, string underlying, DateOnly completedFrom, DateOnly completedThrough, CancellationToken cancellationToken)
    {
        await using var connection = new NpgsqlConnection(_connectionString);
        await connection.OpenAsync(cancellationToken);

        const string sql = """
            INSERT INTO backfill_progress (series_key, underlying, completed_from, completed_through, updated_at)
            VALUES (@key, @underlying, @from, @through, now())
            ON CONFLICT (series_key) DO UPDATE SET
                completed_from = EXCLUDED.completed_from, completed_through = EXCLUDED.completed_through,
                underlying = EXCLUDED.underlying, updated_at = now()
            """;

        await using var command = new NpgsqlCommand(sql, connection);
        command.Parameters.AddWithValue("key", seriesKey);
        command.Parameters.AddWithValue("underlying", underlying);
        command.Parameters.Add(new NpgsqlParameter("from", NpgsqlTypes.NpgsqlDbType.Date) { Value = completedFrom.ToDateTime(TimeOnly.MinValue) });
        command.Parameters.Add(new NpgsqlParameter("through", NpgsqlTypes.NpgsqlDbType.Date) { Value = completedThrough.ToDateTime(TimeOnly.MinValue) });
        await command.ExecuteNonQueryAsync(cancellationToken);
    }

    public async Task<int> SaveSpotBarsAsync(string underlying, IReadOnlyList<DhanHistoricalBar> bars, CancellationToken cancellationToken)
    {
        if (bars.Count == 0) return 0;

        await using var connection = new NpgsqlConnection(_connectionString);
        await connection.OpenAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(cancellationToken);

        const string sql = """
            INSERT INTO spot_bars_1m (time, underlying, open, high, low, close, volume)
            VALUES (@time, @underlying, @open, @high, @low, @close, @volume)
            ON CONFLICT (underlying, time) DO UPDATE SET
                open = EXCLUDED.open, high = EXCLUDED.high, low = EXCLUDED.low,
                close = EXCLUDED.close, volume = EXCLUDED.volume
            """;

        await using var command = new NpgsqlCommand(sql, connection, transaction);
        command.Parameters.Add(new NpgsqlParameter("time", NpgsqlTypes.NpgsqlDbType.TimestampTz));
        command.Parameters.Add(new NpgsqlParameter("underlying", NpgsqlTypes.NpgsqlDbType.Text));
        command.Parameters.Add(new NpgsqlParameter("open", NpgsqlTypes.NpgsqlDbType.Numeric));
        command.Parameters.Add(new NpgsqlParameter("high", NpgsqlTypes.NpgsqlDbType.Numeric));
        command.Parameters.Add(new NpgsqlParameter("low", NpgsqlTypes.NpgsqlDbType.Numeric));
        command.Parameters.Add(new NpgsqlParameter("close", NpgsqlTypes.NpgsqlDbType.Numeric));
        command.Parameters.Add(new NpgsqlParameter("volume", NpgsqlTypes.NpgsqlDbType.Bigint));
        await command.PrepareAsync(cancellationToken);

        foreach (var bar in bars)
        {
            command.Parameters["time"].Value = bar.Time;
            command.Parameters["underlying"].Value = underlying;
            command.Parameters["open"].Value = bar.Open;
            command.Parameters["high"].Value = bar.High;
            command.Parameters["low"].Value = bar.Low;
            command.Parameters["close"].Value = bar.Close;
            command.Parameters["volume"].Value = bar.Volume;
            await command.ExecuteNonQueryAsync(cancellationToken);
        }

        await transaction.CommitAsync(cancellationToken);
        return bars.Count;
    }

    public async Task<int> SaveOptionBarsAsync(
        string underlying, DateOnly expiry, decimal strike, bool isCall, long securityId, IReadOnlyList<DhanHistoricalBar> bars, CancellationToken cancellationToken)
    {
        if (bars.Count == 0) return 0;

        await using var connection = new NpgsqlConnection(_connectionString);
        await connection.OpenAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(cancellationToken);

        const string sql = """
            INSERT INTO option_bars_1m (time, underlying, expiry, strike, option_type, security_id, open, high, low, close, volume, open_interest)
            VALUES (@time, @underlying, @expiry, @strike, @optionType, @securityId, @open, @high, @low, @close, @volume, @oi)
            ON CONFLICT (underlying, expiry, strike, option_type, time) DO UPDATE SET
                open = EXCLUDED.open, high = EXCLUDED.high, low = EXCLUDED.low,
                close = EXCLUDED.close, volume = EXCLUDED.volume, open_interest = EXCLUDED.open_interest
            """;

        await using var command = new NpgsqlCommand(sql, connection, transaction);
        command.Parameters.Add(new NpgsqlParameter("time", NpgsqlTypes.NpgsqlDbType.TimestampTz));
        command.Parameters.Add(new NpgsqlParameter("underlying", NpgsqlTypes.NpgsqlDbType.Text));
        command.Parameters.Add(new NpgsqlParameter("expiry", NpgsqlTypes.NpgsqlDbType.Date));
        command.Parameters.Add(new NpgsqlParameter("strike", NpgsqlTypes.NpgsqlDbType.Numeric));
        command.Parameters.Add(new NpgsqlParameter("optionType", NpgsqlTypes.NpgsqlDbType.Text));
        command.Parameters.Add(new NpgsqlParameter("securityId", NpgsqlTypes.NpgsqlDbType.Bigint));
        command.Parameters.Add(new NpgsqlParameter("open", NpgsqlTypes.NpgsqlDbType.Numeric));
        command.Parameters.Add(new NpgsqlParameter("high", NpgsqlTypes.NpgsqlDbType.Numeric));
        command.Parameters.Add(new NpgsqlParameter("low", NpgsqlTypes.NpgsqlDbType.Numeric));
        command.Parameters.Add(new NpgsqlParameter("close", NpgsqlTypes.NpgsqlDbType.Numeric));
        command.Parameters.Add(new NpgsqlParameter("volume", NpgsqlTypes.NpgsqlDbType.Bigint));
        command.Parameters.Add(new NpgsqlParameter("oi", NpgsqlTypes.NpgsqlDbType.Bigint) { IsNullable = true });
        await command.PrepareAsync(cancellationToken);

        foreach (var bar in bars)
        {
            command.Parameters["time"].Value = bar.Time;
            command.Parameters["underlying"].Value = underlying;
            command.Parameters["expiry"].Value = expiry;
            command.Parameters["strike"].Value = strike;
            command.Parameters["optionType"].Value = isCall ? "CE" : "PE";
            command.Parameters["securityId"].Value = securityId;
            command.Parameters["open"].Value = bar.Open;
            command.Parameters["high"].Value = bar.High;
            command.Parameters["low"].Value = bar.Low;
            command.Parameters["close"].Value = bar.Close;
            command.Parameters["volume"].Value = bar.Volume;
            command.Parameters["oi"].Value = (object?)bar.OpenInterest ?? DBNull.Value;
            await command.ExecuteNonQueryAsync(cancellationToken);
        }

        await transaction.CommitAsync(cancellationToken);
        return bars.Count;
    }

    public async Task<int> SaveRollingOptionBarsAsync(
        string underlying, string expiryFlag, int expiryCode, string strikeOffset, bool isCall,
        IReadOnlyList<DhanRollingOptionBar> bars, CancellationToken cancellationToken)
    {
        if (bars.Count == 0) return 0;

        await using var connection = new NpgsqlConnection(_connectionString);
        await connection.OpenAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(cancellationToken);

        const string sql = """
            INSERT INTO rolling_option_bars_1m (
                time, underlying, expiry_flag, expiry_code, strike_offset, option_type,
                strike, spot_price, open, high, low, close, volume, open_interest, implied_volatility)
            VALUES (
                @time, @underlying, @expiryFlag, @expiryCode, @strikeOffset, @optionType,
                @strike, @spotPrice, @open, @high, @low, @close, @volume, @oi, @iv)
            ON CONFLICT (underlying, expiry_flag, expiry_code, strike_offset, option_type, time) DO UPDATE SET
                strike = EXCLUDED.strike, spot_price = EXCLUDED.spot_price,
                open = EXCLUDED.open, high = EXCLUDED.high, low = EXCLUDED.low, close = EXCLUDED.close,
                volume = EXCLUDED.volume, open_interest = EXCLUDED.open_interest, implied_volatility = EXCLUDED.implied_volatility
            """;

        await using var command = new NpgsqlCommand(sql, connection, transaction);
        void AddParam(string name, NpgsqlTypes.NpgsqlDbType type) => command.Parameters.Add(new NpgsqlParameter(name, type) { IsNullable = true });
        AddParam("time", NpgsqlTypes.NpgsqlDbType.TimestampTz);
        AddParam("underlying", NpgsqlTypes.NpgsqlDbType.Text);
        AddParam("expiryFlag", NpgsqlTypes.NpgsqlDbType.Text);
        AddParam("expiryCode", NpgsqlTypes.NpgsqlDbType.Integer);
        AddParam("strikeOffset", NpgsqlTypes.NpgsqlDbType.Text);
        AddParam("optionType", NpgsqlTypes.NpgsqlDbType.Text);
        AddParam("strike", NpgsqlTypes.NpgsqlDbType.Numeric);
        AddParam("spotPrice", NpgsqlTypes.NpgsqlDbType.Numeric);
        AddParam("open", NpgsqlTypes.NpgsqlDbType.Numeric);
        AddParam("high", NpgsqlTypes.NpgsqlDbType.Numeric);
        AddParam("low", NpgsqlTypes.NpgsqlDbType.Numeric);
        AddParam("close", NpgsqlTypes.NpgsqlDbType.Numeric);
        AddParam("volume", NpgsqlTypes.NpgsqlDbType.Bigint);
        AddParam("oi", NpgsqlTypes.NpgsqlDbType.Bigint);
        AddParam("iv", NpgsqlTypes.NpgsqlDbType.Numeric);
        await command.PrepareAsync(cancellationToken);

        foreach (var bar in bars)
        {
            command.Parameters["time"].Value = bar.Time;
            command.Parameters["underlying"].Value = underlying;
            command.Parameters["expiryFlag"].Value = expiryFlag;
            command.Parameters["expiryCode"].Value = expiryCode;
            command.Parameters["strikeOffset"].Value = strikeOffset;
            command.Parameters["optionType"].Value = isCall ? "CE" : "PE";
            command.Parameters["strike"].Value = (object?)bar.Strike ?? DBNull.Value;
            command.Parameters["spotPrice"].Value = (object?)bar.SpotPrice ?? DBNull.Value;
            command.Parameters["open"].Value = (object?)bar.Open ?? DBNull.Value;
            command.Parameters["high"].Value = (object?)bar.High ?? DBNull.Value;
            command.Parameters["low"].Value = (object?)bar.Low ?? DBNull.Value;
            command.Parameters["close"].Value = (object?)bar.Close ?? DBNull.Value;
            command.Parameters["volume"].Value = (object?)bar.Volume ?? DBNull.Value;
            command.Parameters["oi"].Value = (object?)bar.OpenInterest ?? DBNull.Value;
            command.Parameters["iv"].Value = (object?)bar.ImpliedVolatility ?? DBNull.Value;
            await command.ExecuteNonQueryAsync(cancellationToken);
        }

        await transaction.CommitAsync(cancellationToken);
        return bars.Count;
    }
}
