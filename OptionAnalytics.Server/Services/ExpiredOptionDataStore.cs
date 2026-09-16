using Microsoft.Extensions.Options;
using Npgsql;
using OptionAnalytics.Server.Models;

namespace OptionAnalytics.Server.Services;

/// <summary>
/// Postgres-backed cache of raw rolling-option bars (see ExpiredOptionDataPrefetchHostedService for
/// what fills it) - the option-premium counterpart to HistoricalSpotDataStore's own cache. Used to
/// hold a plain CSV per contract instead ("i do not need db okay"); that decision was reversed in
/// favor of a real database once the scope grew to a full 1-year NIFTY/BANKNIFTY backfill.
///
/// ONE "CONTRACT" ROW GROUP PER (underlying, expiryFlag, expiryDate) - not per strike/side - covering
/// every token in the fetched band (ATM+-FlowChainRadius) and both CALL/PUT sides together,
/// distinguished by the StrikeToken/OptionType columns. This is deliberately the SAME granularity
/// ExpiredOptionBacktestService.FetchAcrossSegmentsAsync fetches at (one whole contract's worth of
/// data per token/side), so a cache hit there is a straight read with no re-assembly.
///
/// WHAT "one contract's own data" MEANS, and why a cache keyed this way covers any narrower live
/// request for the same contract: every FetchSegment ExpiredOptionBacktestService.BuildFetchSegments
/// produces has a `.To` that IS the real expiry date the segment's data belongs to (segment 1's own
/// `.To` is always the target expiry itself; segment 2's is always the PRIOR same-cadence expiry) -
/// so caching this class's own [FromDay,ToDay] range as "that contract's entire natural single-
/// segment life" (from just after the previous same-cadence expiry through this one) is a strict
/// superset of any live segment's own narrower [From,To] window for the same target, and multiple
/// contracts compose to cover a multi-segment request the exact same way FetchAcrossSegmentsAsync's
/// own segment loop does live.
///
/// expired_option_contracts is the small "is this contract cached, and what window does it cover"
/// marker table (mirrors the old CSV cache's ".meta.json" sidecar); expired_option_bars holds the
/// actual bars, one row per (contract, strike token, side, bar time). A contract's rows are only
/// ever written together, inside one transaction, right before its own marker row is upserted - a
/// process killed mid-save leaves neither behind, the same completeness guarantee the old
/// write-CSV-then-write-meta ordering gave.
///
/// NEVER LETS A POSTGRES FAILURE TAKE THE APP DOWN. HasContract/Read/SaveAsync each catch and log
/// rather than throw - HasContract/Read are called on EVERY expired-backtest request regardless of
/// whether the one-time prefetch job is enabled (see ExpiredOptionBacktestService.
/// FetchAcrossSegmentsAsync), so an unhandled exception here would break that whole page the moment
/// Postgres is briefly unreachable. Schema creation is attempted once at construction and ALSO
/// wrapped - this class is a singleton background services depend on, constructed eagerly at app
/// startup, and an unhandled exception there crashes the entire process before it ever serves a
/// request (the exact failure mode this guard exists to prevent). A failed connection anywhere
/// simply behaves as "nothing cached yet" - the same graceful fallback a live Dhan call already has
/// (FetchAcrossSegmentsAsync's own cache-then-live path), never a crash.
/// </summary>
public sealed class ExpiredOptionDataStore
{
    private readonly string _connectionString;
    private readonly ILogger<ExpiredOptionDataStore> _logger;

    public ExpiredOptionDataStore(IOptions<PostgresOptions> postgresOptions, ILogger<ExpiredOptionDataStore> logger)
    {
        _connectionString = postgresOptions.Value.BuildConnectionString();
        _logger = logger;

        try
        {
            EnsureSchemaCreated();
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Could not reach Postgres to ensure the expired-option-data schema exists - the app will keep starting, but this cache will behave as empty until Postgres is reachable.");
        }
    }

    private void EnsureSchemaCreated()
    {
        using var connection = new NpgsqlConnection(_connectionString);
        connection.Open();

        using var command = connection.CreateCommand();
        command.CommandText = """
            CREATE TABLE IF NOT EXISTS expired_option_contracts (
                underlying     TEXT NOT NULL,
                expiry_flag    TEXT NOT NULL,
                expiry_date    DATE NOT NULL,
                from_day       DATE NOT NULL,
                to_day         DATE NOT NULL,
                fetched_at_utc TIMESTAMPTZ NOT NULL,
                PRIMARY KEY (underlying, expiry_flag, expiry_date)
            );

            CREATE TABLE IF NOT EXISTS expired_option_bars (
                underlying    TEXT NOT NULL,
                expiry_flag   TEXT NOT NULL,
                expiry_date   DATE NOT NULL,
                strike_token  TEXT NOT NULL,
                option_type   TEXT NOT NULL,
                bar_time      TIMESTAMPTZ NOT NULL,
                open          NUMERIC NOT NULL,
                high          NUMERIC NOT NULL,
                low           NUMERIC NOT NULL,
                close         NUMERIC NOT NULL,
                volume        BIGINT NOT NULL,
                strike        NUMERIC NULL,
                PRIMARY KEY (underlying, expiry_flag, expiry_date, strike_token, option_type, bar_time)
            );
            """;
        command.ExecuteNonQuery();
    }

    /// <summary>True when a previous prefetch already saved this exact contract - the guard
    /// ExpiredOptionDataPrefetchHostedService uses to skip a contract it already has, and
    /// ExpiredOptionBacktestService.FetchAcrossSegmentsAsync uses to decide whether a given segment
    /// can be served from the cache instead of a live Dhan call. False (never cached) if Postgres
    /// itself can't be reached - see this class's own doc comment.</summary>
    public bool HasContract(string underlying, string expiryFlag, DateOnly expiryDate)
    {
        try
        {
            using var connection = new NpgsqlConnection(_connectionString);
            connection.Open();

            using var command = connection.CreateCommand();
            command.CommandText = "SELECT 1 FROM expired_option_contracts WHERE underlying = @underlying AND expiry_flag = @expiryFlag AND expiry_date = @expiryDate LIMIT 1";
            AddContractKeyParameters(command, underlying, expiryFlag, expiryDate);

            return command.ExecuteScalar() is not null;
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Could not reach Postgres to check the expired-option-data cache for {Underlying} {ExpiryFlag} {ExpiryDate} - treating it as not cached.", underlying, expiryFlag, expiryDate);
            return false;
        }
    }

    /// <summary>Every cached bar for one token/side within a contract, clipped to [fromDay,toDay]
    /// (IST calendar dates, both inclusive) - the same clipping DhanRollingOptionDataService.
    /// ClipToRange applies to a live fetch, so a cache hit behaves identically to the live call it
    /// replaces. Callers should check HasContract first; this returns empty if the contract itself
    /// was never saved, OR if Postgres itself can't be reached - see this class's own doc
    /// comment.</summary>
    public IReadOnlyList<(CandleWithVolume Bar, decimal? Strike, decimal? Spot)> Read(
        string underlying, string expiryFlag, DateOnly expiryDate, string strikeToken, string optionType, DateOnly fromDay, DateOnly toDay)
    {
        try
        {
            using var connection = new NpgsqlConnection(_connectionString);
            connection.Open();

            using var command = connection.CreateCommand();
            command.CommandText = """
                SELECT bar_time, open, high, low, close, volume, strike
                FROM expired_option_bars
                WHERE underlying = @underlying AND expiry_flag = @expiryFlag AND expiry_date = @expiryDate
                  AND strike_token = @strikeToken AND option_type = @optionType
                  AND bar_time >= @fromInclusiveUtc AND bar_time < @toExclusiveUtc
                ORDER BY bar_time
                """;
            AddContractKeyParameters(command, underlying, expiryFlag, expiryDate);
            command.Parameters.AddWithValue("strikeToken", strikeToken);
            command.Parameters.AddWithValue("optionType", optionType);
            // Both boundaries in UTC, converted from the requested IST calendar-day window - IST has
            // no DST, so a fixed +5:30 offset is exact for any date.
            command.Parameters.AddWithValue("fromInclusiveUtc", IstClock.AtIstTime(fromDay, 0).UtcDateTime);
            command.Parameters.AddWithValue("toExclusiveUtc", IstClock.AtIstTime(toDay.AddDays(1), 0).UtcDateTime);

            var result = new List<(CandleWithVolume Bar, decimal? Strike, decimal? Spot)>();
            using var reader = command.ExecuteReader();
            while (reader.Read())
            {
                var time = new DateTimeOffset(reader.GetDateTime(0), TimeSpan.Zero);
                var bar = new CandleWithVolume(time, reader.GetDecimal(1), reader.GetDecimal(2), reader.GetDecimal(3), reader.GetDecimal(4), reader.GetInt64(5));
                var strike = reader.IsDBNull(6) ? (decimal?)null : reader.GetDecimal(6);
                // Spot is intentionally not persisted (see SaveAsync's own doc comment) - callers
                // that need it fall back to null exactly like a live bar whose own response omitted
                // it does.
                result.Add((bar, strike, null));
            }

            return result;
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Could not reach Postgres to read the expired-option-data cache for {Underlying} {ExpiryFlag} {ExpiryDate} {StrikeToken} {OptionType} - returning empty.", underlying, expiryFlag, expiryDate, strikeToken, optionType);
            return Array.Empty<(CandleWithVolume, decimal?, decimal?)>();
        }
    }

    /// <summary>Replaces this contract's whole row set with every token/side member's own bars, and
    /// only then upserts the marker row recording [fromDay,toDay] as covered - all inside one
    /// transaction, so a process killed mid-save can never leave a marker claiming coverage the bars
    /// themselves don't have (same guarantee the old write-CSV-then-write-meta ordering gave). If
    /// Postgres can't be reached, this contract is simply not cached this run - the prefetch job
    /// retries it on the next one (see this class's own doc comment), rather than the save
    /// throwing.
    ///
    /// Spot is deliberately NOT persisted, only Strike: FilterToExpectedStrike (the one reader of a
    /// bar's own Spot) already falls back to matching against a separately fetched spot series when
    /// Spot is null, exactly the behavior a cached bar gets here - and dropping it keeps this store
    /// roughly a third smaller across the sheer volume it holds (a full year across every expiry and
    /// the whole ATM+-10 band) for a value nothing else in this app ever reads back out.</summary>
    public async Task SaveAsync(
        string underlying, string expiryFlag, DateOnly expiryDate, DateOnly fromDay, DateOnly toDay,
        IReadOnlyList<(string StrikeToken, string OptionType, IReadOnlyList<(CandleWithVolume Bar, decimal? Strike, decimal? Spot)> Bars)> members,
        CancellationToken cancellationToken)
    {
        try
        {
            await using var connection = new NpgsqlConnection(_connectionString);
            await connection.OpenAsync(cancellationToken);
            await using var transaction = await connection.BeginTransactionAsync(cancellationToken);

            await using (var delete = connection.CreateCommand())
            {
                delete.Transaction = transaction;
                delete.CommandText = "DELETE FROM expired_option_bars WHERE underlying = @underlying AND expiry_flag = @expiryFlag AND expiry_date = @expiryDate";
                AddContractKeyParameters(delete, underlying, expiryFlag, expiryDate);
                await delete.ExecuteNonQueryAsync(cancellationToken);
            }

            await using (var importer = await connection.BeginBinaryImportAsync(
                "COPY expired_option_bars (underlying, expiry_flag, expiry_date, strike_token, option_type, bar_time, open, high, low, close, volume, strike) FROM STDIN (FORMAT BINARY)",
                cancellationToken))
            {
                foreach (var member in members)
                {
                    foreach (var (bar, strike, _) in member.Bars)
                    {
                        await importer.StartRowAsync(cancellationToken);
                        await importer.WriteAsync(underlying.ToUpperInvariant(), NpgsqlTypes.NpgsqlDbType.Text, cancellationToken);
                        await importer.WriteAsync(expiryFlag.ToUpperInvariant(), NpgsqlTypes.NpgsqlDbType.Text, cancellationToken);
                        await importer.WriteAsync(expiryDate, NpgsqlTypes.NpgsqlDbType.Date, cancellationToken);
                        await importer.WriteAsync(member.StrikeToken, NpgsqlTypes.NpgsqlDbType.Text, cancellationToken);
                        await importer.WriteAsync(member.OptionType, NpgsqlTypes.NpgsqlDbType.Text, cancellationToken);
                        await importer.WriteAsync(bar.Time.UtcDateTime, NpgsqlTypes.NpgsqlDbType.TimestampTz, cancellationToken);
                        await importer.WriteAsync(bar.Open, NpgsqlTypes.NpgsqlDbType.Numeric, cancellationToken);
                        await importer.WriteAsync(bar.High, NpgsqlTypes.NpgsqlDbType.Numeric, cancellationToken);
                        await importer.WriteAsync(bar.Low, NpgsqlTypes.NpgsqlDbType.Numeric, cancellationToken);
                        await importer.WriteAsync(bar.Close, NpgsqlTypes.NpgsqlDbType.Numeric, cancellationToken);
                        await importer.WriteAsync(bar.Volume, NpgsqlTypes.NpgsqlDbType.Bigint, cancellationToken);
                        if (strike is { } value) await importer.WriteAsync(value, NpgsqlTypes.NpgsqlDbType.Numeric, cancellationToken);
                        else await importer.WriteNullAsync(cancellationToken);
                    }
                }
                await importer.CompleteAsync(cancellationToken);
            }

            await using (var upsert = connection.CreateCommand())
            {
                upsert.Transaction = transaction;
                upsert.CommandText = """
                    INSERT INTO expired_option_contracts (underlying, expiry_flag, expiry_date, from_day, to_day, fetched_at_utc)
                    VALUES (@underlying, @expiryFlag, @expiryDate, @fromDay, @toDay, @fetchedAtUtc)
                    ON CONFLICT (underlying, expiry_flag, expiry_date)
                    DO UPDATE SET from_day = EXCLUDED.from_day, to_day = EXCLUDED.to_day, fetched_at_utc = EXCLUDED.fetched_at_utc
                    """;
                AddContractKeyParameters(upsert, underlying, expiryFlag, expiryDate);
                upsert.Parameters.AddWithValue("fromDay", fromDay);
                upsert.Parameters.AddWithValue("toDay", toDay);
                upsert.Parameters.AddWithValue("fetchedAtUtc", DateTime.UtcNow);
                await upsert.ExecuteNonQueryAsync(cancellationToken);
            }

            await transaction.CommitAsync(cancellationToken);

            var totalBars = members.Sum(m => m.Bars.Count);
            _logger.LogInformation("Saved {Count} cached rolling-option bar(s) across {Members} token/side member(s) for {Underlying} {ExpiryFlag} {ExpiryDate} ({From}..{To}).",
                totalBars, members.Count, underlying, expiryFlag, expiryDate, fromDay, toDay);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _logger.LogWarning(ex, "Could not reach Postgres to save the expired-option-data cache for {Underlying} {ExpiryFlag} {ExpiryDate} - it will retry on the next prefetch run.", underlying, expiryFlag, expiryDate);
        }
    }

    private static void AddContractKeyParameters(NpgsqlCommand command, string underlying, string expiryFlag, DateOnly expiryDate)
    {
        command.Parameters.AddWithValue("underlying", underlying.ToUpperInvariant());
        command.Parameters.AddWithValue("expiryFlag", expiryFlag.ToUpperInvariant());
        command.Parameters.AddWithValue("expiryDate", expiryDate);
    }
}
