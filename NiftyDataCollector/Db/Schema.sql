-- NiftyDataCollector's TimescaleDB schema. Applied automatically on startup (see
-- SchemaInitializer) - every statement is idempotent (IF NOT EXISTS / ON CONFLICT DO NOTHING at
-- the create_hypertable call), so re-running this against an already-initialized database is a
-- safe no-op.

CREATE EXTENSION IF NOT EXISTS timescaledb;

-- Spot 1-minute OHLC+volume, from Dhan's historical intraday endpoint (INDEX instrument) - real
-- history, backfillable for any past window Dhan still serves.
CREATE TABLE IF NOT EXISTS spot_bars_1m (
    time        TIMESTAMPTZ NOT NULL,
    underlying  TEXT        NOT NULL,
    open        NUMERIC     NOT NULL,
    high        NUMERIC     NOT NULL,
    low         NUMERIC     NOT NULL,
    close       NUMERIC     NOT NULL,
    volume      BIGINT      NOT NULL DEFAULT 0,
    PRIMARY KEY (underlying, time)
);
SELECT create_hypertable('spot_bars_1m', 'time', if_not_exists => TRUE);

-- Option 1-minute OHLC+volume(+open_interest, when Dhan's own "oi":true flag on this endpoint
-- turns out to return real historical values rather than the all-zero placeholder its docs show -
-- see DhanHistoricalDataClient's own doc comment), from the historical intraday endpoint (OPTIDX
-- instrument), one row per (underlying, expiry, strike, option_type, minute). Also real, backfillable
-- history - this is the ONE part of an option's own market data Dhan can genuinely replay.
CREATE TABLE IF NOT EXISTS option_bars_1m (
    time            TIMESTAMPTZ NOT NULL,
    underlying      TEXT        NOT NULL,
    expiry          DATE        NOT NULL,
    strike          NUMERIC     NOT NULL,
    option_type     TEXT        NOT NULL CHECK (option_type IN ('CE', 'PE')),
    security_id     BIGINT      NOT NULL,
    open            NUMERIC     NOT NULL,
    high            NUMERIC     NOT NULL,
    low             NUMERIC     NOT NULL,
    close           NUMERIC     NOT NULL,
    volume          BIGINT      NOT NULL DEFAULT 0,
    open_interest   BIGINT,
    PRIMARY KEY (underlying, expiry, strike, option_type, time)
);
SELECT create_hypertable('option_bars_1m', 'time', if_not_exists => TRUE);
CREATE INDEX IF NOT EXISTS idx_option_bars_1m_lookup ON option_bars_1m (underlying, expiry, strike, option_type, time DESC);

-- Option chain LIVE snapshots - implied_volatility, the greeks, and open_interest/volume as Dhan
-- reports them AT THIS INSTANT (poll cadence, not true 1-minute bars: Dhan's Option Chain API has
-- no history of its own, only ever a live snapshot - see OptionAnalytics.Server's own
-- DhanOptionChainQuotes doc comment, which is what led to OiUnwindStrategy being removed there).
-- One row per (underlying, expiry, strike, option_type) per poll, spot_price carrying the
-- underlying's OWN last_price at that same instant so a snapshot never needs a join to know what
-- spot was doing when it was captured.
CREATE TABLE IF NOT EXISTS option_chain_snapshots (
    time                TIMESTAMPTZ NOT NULL,
    underlying          TEXT        NOT NULL,
    expiry              DATE        NOT NULL,
    strike              NUMERIC     NOT NULL,
    option_type         TEXT        NOT NULL CHECK (option_type IN ('CE', 'PE')),
    security_id         BIGINT      NOT NULL,
    spot_price          NUMERIC,
    last_price          NUMERIC,
    average_price       NUMERIC,
    open_interest       BIGINT,
    previous_open_interest BIGINT,
    volume              BIGINT,
    previous_volume     BIGINT,
    previous_close_price NUMERIC,
    implied_volatility  NUMERIC,
    delta               NUMERIC,
    theta               NUMERIC,
    gamma               NUMERIC,
    vega                NUMERIC,
    top_bid_price       NUMERIC,
    top_bid_quantity    BIGINT,
    top_ask_price       NUMERIC,
    top_ask_quantity    BIGINT,
    PRIMARY KEY (underlying, expiry, strike, option_type, time)
);
SELECT create_hypertable('option_chain_snapshots', 'time', if_not_exists => TRUE);
CREATE INDEX IF NOT EXISTS idx_option_chain_snapshots_lookup ON option_chain_snapshots (underlying, expiry, strike, option_type, time DESC);

-- Backfill CHECKPOINTS - one row per backfilled SERIES, recording the contiguous [completed_from,
-- completed_through] window its own historical backfill currently covers. A series_key is either
-- a plain security_id (spot index or a specific live option contract, from
-- CollectorHostedService's own OHLC backfill) or a synthetic
-- "ROLLING:underlying:expiryFlag:expiryCode:strikeOffset:optionType" key (a rolling-option series,
-- from RollingOptionBackfillHostedService) - one unified table for both. A long backfill is
-- fetched in chunks (Dhan's own per-call cap - 90 days for /charts/intraday, 30 for
-- /charts/rollingoption - see DhanHistoricalDataClient and DhanRollingOptionClient).
--
-- TWO DIRECTIONS this window can grow, handled differently on purpose:
--  - FORWARD (completed_through -> today, the normal "keep today's data current" case): advanced
--    chunk by chunk, immediately after each chunk's own bars are saved, and the whole chunk loop
--    stops at the first failed chunk - so completed_through always means "every bar from scratch
--    up to this date is saved", never "most of them are". The next cycle resumes from
--    completed_through+1, re-fetching only what's missing.
--  - BACKWARD (completed_from moves earlier - happens when you widen how far back a backfill
--    should reach, e.g. raising BackfillDays or moving RollingOption:StartDate earlier, AFTER an
--    initial smaller-range run already completed - the collector's own "first fetch for 30 days,
--    then widen once it looks right" workflow): completed_from is only ever moved once the WHOLE
--    newly-requested older window has fetched successfully end to end, never advanced mid-way -
--    a partial failure here leaves completed_from untouched and simply retries the full extension
--    next cycle (an idempotent, if slightly wasteful, redo - safer than a third watermark to track
--    partial backward progress). This is why completed_from moving backward and
--    completed_through moving forward use different update rules even though they're stored in
--    the same row.
--
-- TO FORCE A RE-FETCH of a specific window (e.g. you spotted bad data and deleted those rows from
-- the bars table): rewind completed_through (or advance completed_from past the bad window) for
-- that series_key - or delete the row entirely to redo the whole backfill range from scratch. The
-- next cycle picks up the change automatically, no restart required.
CREATE TABLE IF NOT EXISTS backfill_progress (
    series_key           TEXT        PRIMARY KEY,
    underlying           TEXT        NOT NULL,
    completed_from        DATE        NOT NULL,
    completed_through    DATE        NOT NULL,
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Rolling-option historical data, from Dhan's own "Rolling Options" API (POST
-- /v2/charts/rollingoption) - a SYNTHETIC continuous series that, for each day in the requested
-- range, resolves "the {expiryCode}-th {expiryFlag} cycle's {strike_offset} strike" fresh (so the
-- underlying absolute strike can and does change day to day as spot moves and expiries roll) and
-- returns that resolved contract's own minute OHLC - critically, ALSO open_interest and
-- implied_volatility, which is genuinely new: OptionAnalytics.Server's OI-is-live-only assumption,
-- and this collector's own earlier open question about /charts/intraday's "oi" flag, are both
-- about a DIFFERENT endpoint - this one documents historical OI/IV directly. strike/spot_price are
-- captured per bar (not just per query) because they can shift within the same requested range.
-- One row per (underlying, expiry_flag, expiry_code, strike_offset, option_type, minute).
CREATE TABLE IF NOT EXISTS rolling_option_bars_1m (
    time                TIMESTAMPTZ NOT NULL,
    underlying          TEXT        NOT NULL,
    expiry_flag         TEXT        NOT NULL CHECK (expiry_flag IN ('WEEK', 'MONTH')),
    expiry_code         INT         NOT NULL,
    strike_offset       TEXT        NOT NULL,
    option_type         TEXT        NOT NULL CHECK (option_type IN ('CE', 'PE')),
    strike              NUMERIC,
    spot_price          NUMERIC,
    open                NUMERIC,
    high                NUMERIC,
    low                 NUMERIC,
    close               NUMERIC,
    volume              BIGINT,
    open_interest       BIGINT,
    implied_volatility  NUMERIC,
    PRIMARY KEY (underlying, expiry_flag, expiry_code, strike_offset, option_type, time)
);
SELECT create_hypertable('rolling_option_bars_1m', 'time', if_not_exists => TRUE);
CREATE INDEX IF NOT EXISTS idx_rolling_option_bars_1m_lookup ON rolling_option_bars_1m (underlying, expiry_flag, expiry_code, strike_offset, option_type, time DESC);

-- Not enabled by default - turn on once you've validated the pipeline and want to keep disk usage
-- down for data older than your active query window. Left commented out deliberately: compressed
-- chunks are read-only for inserts, and this collector may still want to backfill/repair older
-- rows while you're still testing it.
-- ALTER TABLE option_bars_1m SET (timescaledb.compress, timescaledb.compress_segmentby = 'underlying, expiry, strike, option_type');
-- SELECT add_compression_policy('option_bars_1m', INTERVAL '7 days');
