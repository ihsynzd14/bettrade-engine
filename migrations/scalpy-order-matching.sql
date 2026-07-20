-- Live order matching — schema migration.
-- Run once in the Supabase SQL editor BEFORE restarting the engine with the live-matching code.
--
-- Captures the actual match result of a Betfair order so the engine can log and settle on the
-- REAL matched amount/price instead of assuming every bet is fully matched (the dry-run fiction).
--
-- Until this is applied: the engine's schema self-check refuses to start in LIVE mode (fail-closed),
-- and in DRY_RUN it keeps running with the old "fully matched" assumption for visibility.

-- 1) Match result columns on scalpy_trades -----------------------------------
ALTER TABLE scalpy_trades ADD COLUMN IF NOT EXISTS matched_size     NUMERIC;
ALTER TABLE scalpy_trades ADD COLUMN IF NOT EXISTS size_matched_at  TIMESTAMPTZ;
ALTER TABLE scalpy_trades ADD COLUMN IF NOT EXISTS bet_status       TEXT;

-- matched_size: actual GBP amount that matched (0 = unmatched, partial = partial, = stake = full).
--               NULL = unknown (legacy rows, or order not yet placed/placed before this migration).
-- size_matched_at: when the matched portion was confirmed (set when matched_size first goes > 0).
-- bet_status: Betfair order status — EXECUTABLE (open/unmatched), EXECUTION_COMPLETE (fully matched),
--             EXPIRED, CANCELLED. Lets the operator see at a glance why a trade is still open.

-- 2) Add PARTIALLY_MATCHED to the status CHECK --------------------------------
-- (The inline CHECK created with the table is named scalpy_trades_status_check.)
-- PARTIALLY_MATCHED sits between PENDING (order sent, awaiting match) and MATCHED (fully filled).
ALTER TABLE scalpy_trades DROP CONSTRAINT IF EXISTS scalpy_trades_status_check;
ALTER TABLE scalpy_trades ADD CONSTRAINT scalpy_trades_status_check
  CHECK (status IN ('CLAIMED','PENDING','PARTIALLY_MATCHED','MATCHED','SETTLED','SKIPPED','FAILED'));

-- 3) Helpful index for the live-settlement poller -----------------------------
-- The poller scans for open LIVE trades every SCALPY_LIVE_SETTLE_MS; this filters the common case.
CREATE INDEX IF NOT EXISTS scalpy_trades_open_live_idx
  ON scalpy_trades (dry_run, status)
  WHERE dry_run = false AND status IN ('PENDING', 'PARTIALLY_MATCHED', 'MATCHED');
