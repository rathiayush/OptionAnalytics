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

-- Backfill CHECKPOINTS - one row per security (spot index or option contract), recording the last
-- calendar day its own historical OHLC backfill has contiguously reached. A long backfill
-- (BackfillDays=500 by default) is fetched in ~90-day chunks (Dhan's own per-call cap - see
-- DhanHistoricalDataClient); this row is only advanced to a chunk's own end date AFTER that
-- chunk's bars are saved, and the whole chunk loop stops at the first failed chunk rather than
-- skipping ahead - so completed_through always means "every bar from scratch up to this date is
-- saved", never "most of them are". The next cycle resumes from completed_through+1, re-fetching
-- only what's missing rather than redoing the whole range from day one.
--
-- TO FORCE A RE-FETCH of a specific window (e.g. you spotted bad data and deleted those rows from
-- spot_bars_1m/option_bars_1m): rewind this row's completed_through to the day before the bad
-- window (or delete the row entirely, to redo the full BackfillDays range) for that security_id -
-- the next cycle picks it up automatically, no restart required.
CREATE TABLE IF NOT EXISTS backfill_progress (
    security_id         BIGINT      PRIMARY KEY,
    underlying           TEXT        NOT NULL,
    completed_through    DATE        NOT NULL,
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Not enabled by default - turn on once you've validated the pipeline and want to keep disk usage
-- down for data older than your active query window. Left commented out deliberately: compressed
-- chunks are read-only for inserts, and this collector may still want to backfill/repair older
-- rows while you're still testing it.
-- ALTER TABLE option_bars_1m SET (timescaledb.compress, timescaledb.compress_segmentby = 'underlying, expiry, strike, option_type');
-- SELECT add_compression_policy('option_bars_1m', INTERVAL '7 days');
