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

    public TimescaleWriter(IConfiguration configuration, ILogger<TimescaleWriter> logger)
    {
        _connectionString = configuration.GetConnectionString("Timescale")
            ?? throw new InvalidOperationException("ConnectionStrings:Timescale is not configured - see appsettings.json.");
        _logger = logger;
    }

    public async Task EnsureSchemaAsync(CancellationToken cancellationToken)
    {
        var schemaPath = Path.Combine(AppContext.BaseDirectory, "Db", "Schema.sql");
        var sql = await File.ReadAllTextAsync(schemaPath, cancellationToken);

        await using var connection = new NpgsqlConnection(_connectionString);
        await connection.OpenAsync(cancellationToken);
        await using var command = new NpgsqlCommand(sql, connection);
        await command.ExecuteNonQueryAsync(cancellationToken);

        _logger.LogInformation("TimescaleDB schema is up to date.");
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

    public async Task<int> SaveOptionChainSnapshotAsync(
        string underlying, DateOnly expiry, DateTimeOffset capturedAt, decimal? spotPrice, IReadOnlyList<DhanOptionChainStrikeSnapshot> strikes, CancellationToken cancellationToken)
    {
        if (strikes.Count == 0) return 0;

        await using var connection = new NpgsqlConnection(_connectionString);
        await connection.OpenAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(cancellationToken);

        const string sql = """
            INSERT INTO option_chain_snapshots (
                time, underlying, expiry, strike, option_type, security_id, spot_price,
                last_price, average_price, open_interest, previous_open_interest, volume, previous_volume,
                previous_close_price, implied_volatility, delta, theta, gamma, vega,
                top_bid_price, top_bid_quantity, top_ask_price, top_ask_quantity)
            VALUES (
                @time, @underlying, @expiry, @strike, @optionType, @securityId, @spotPrice,
                @lastPrice, @avgPrice, @oi, @prevOi, @volume, @prevVolume,
                @prevClose, @iv, @delta, @theta, @gamma, @vega,
                @bidPrice, @bidQty, @askPrice, @askQty)
            ON CONFLICT (underlying, expiry, strike, option_type, time) DO UPDATE SET
                spot_price = EXCLUDED.spot_price, last_price = EXCLUDED.last_price, average_price = EXCLUDED.average_price,
                open_interest = EXCLUDED.open_interest, previous_open_interest = EXCLUDED.previous_open_interest,
                volume = EXCLUDED.volume, previous_volume = EXCLUDED.previous_volume,
                previous_close_price = EXCLUDED.previous_close_price, implied_volatility = EXCLUDED.implied_volatility,
                delta = EXCLUDED.delta, theta = EXCLUDED.theta, gamma = EXCLUDED.gamma, vega = EXCLUDED.vega,
                top_bid_price = EXCLUDED.top_bid_price, top_bid_quantity = EXCLUDED.top_bid_quantity,
                top_ask_price = EXCLUDED.top_ask_price, top_ask_quantity = EXCLUDED.top_ask_quantity
            """;

        await using var command = new NpgsqlCommand(sql, connection, transaction);
        void AddParam(string name, NpgsqlTypes.NpgsqlDbType type) => command.Parameters.Add(new NpgsqlParameter(name, type) { IsNullable = true });
        AddParam("time", NpgsqlTypes.NpgsqlDbType.TimestampTz);
        AddParam("underlying", NpgsqlTypes.NpgsqlDbType.Text);
        AddParam("expiry", NpgsqlTypes.NpgsqlDbType.Date);
        AddParam("strike", NpgsqlTypes.NpgsqlDbType.Numeric);
        AddParam("optionType", NpgsqlTypes.NpgsqlDbType.Text);
        AddParam("securityId", NpgsqlTypes.NpgsqlDbType.Bigint);
        AddParam("spotPrice", NpgsqlTypes.NpgsqlDbType.Numeric);
        AddParam("lastPrice", NpgsqlTypes.NpgsqlDbType.Numeric);
        AddParam("avgPrice", NpgsqlTypes.NpgsqlDbType.Numeric);
        AddParam("oi", NpgsqlTypes.NpgsqlDbType.Bigint);
        AddParam("prevOi", NpgsqlTypes.NpgsqlDbType.Bigint);
        AddParam("volume", NpgsqlTypes.NpgsqlDbType.Bigint);
        AddParam("prevVolume", NpgsqlTypes.NpgsqlDbType.Bigint);
        AddParam("prevClose", NpgsqlTypes.NpgsqlDbType.Numeric);
        AddParam("iv", NpgsqlTypes.NpgsqlDbType.Numeric);
        AddParam("delta", NpgsqlTypes.NpgsqlDbType.Numeric);
        AddParam("theta", NpgsqlTypes.NpgsqlDbType.Numeric);
        AddParam("gamma", NpgsqlTypes.NpgsqlDbType.Numeric);
        AddParam("vega", NpgsqlTypes.NpgsqlDbType.Numeric);
        AddParam("bidPrice", NpgsqlTypes.NpgsqlDbType.Numeric);
        AddParam("bidQty", NpgsqlTypes.NpgsqlDbType.Bigint);
        AddParam("askPrice", NpgsqlTypes.NpgsqlDbType.Numeric);
        AddParam("askQty", NpgsqlTypes.NpgsqlDbType.Bigint);
        await command.PrepareAsync(cancellationToken);

        var rowCount = 0;
        foreach (var strike in strikes)
        {
            foreach (var (isCall, leg) in new[] { (true, strike.Ce), (false, strike.Pe) })
            {
                if (leg is null) continue;

                command.Parameters["time"].Value = capturedAt;
                command.Parameters["underlying"].Value = underlying;
                command.Parameters["expiry"].Value = expiry;
                command.Parameters["strike"].Value = strike.Strike;
                command.Parameters["optionType"].Value = isCall ? "CE" : "PE";
                command.Parameters["securityId"].Value = leg.SecurityId;
                command.Parameters["spotPrice"].Value = (object?)spotPrice ?? DBNull.Value;
                command.Parameters["lastPrice"].Value = (object?)leg.LastPrice ?? DBNull.Value;
                command.Parameters["avgPrice"].Value = (object?)leg.AveragePrice ?? DBNull.Value;
                command.Parameters["oi"].Value = (object?)leg.OpenInterest ?? DBNull.Value;
                command.Parameters["prevOi"].Value = (object?)leg.PreviousOpenInterest ?? DBNull.Value;
                command.Parameters["volume"].Value = (object?)leg.Volume ?? DBNull.Value;
                command.Parameters["prevVolume"].Value = (object?)leg.PreviousVolume ?? DBNull.Value;
                command.Parameters["prevClose"].Value = (object?)leg.PreviousClosePrice ?? DBNull.Value;
                command.Parameters["iv"].Value = (object?)leg.ImpliedVolatility ?? DBNull.Value;
                command.Parameters["delta"].Value = (object?)leg.Delta ?? DBNull.Value;
                command.Parameters["theta"].Value = (object?)leg.Theta ?? DBNull.Value;
                command.Parameters["gamma"].Value = (object?)leg.Gamma ?? DBNull.Value;
                command.Parameters["vega"].Value = (object?)leg.Vega ?? DBNull.Value;
                command.Parameters["bidPrice"].Value = (object?)leg.TopBidPrice ?? DBNull.Value;
                command.Parameters["bidQty"].Value = (object?)leg.TopBidQuantity ?? DBNull.Value;
                command.Parameters["askPrice"].Value = (object?)leg.TopAskPrice ?? DBNull.Value;
                command.Parameters["askQty"].Value = (object?)leg.TopAskQuantity ?? DBNull.Value;
                await command.ExecuteNonQueryAsync(cancellationToken);
                rowCount++;
            }
        }

        await transaction.CommitAsync(cancellationToken);
        return rowCount;
    }
}
