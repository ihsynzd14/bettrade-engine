-- Scalpy v2 — Phase 1 (safety brakes) schema migration.
-- Run once in the Supabase SQL editor BEFORE restarting the engine with the new code.
-- Until this is applied: the kill-switch runs in-memory only and DRY_RUN bets are blocked
-- at claim-before-place (fail-closed). No real money is at risk either way.

-- 1) Control / kill-switch singleton row -------------------------------------
CREATE TABLE IF NOT EXISTS scalpy_control (
  id                  TEXT PRIMARY KEY DEFAULT 'singleton',
  killed              BOOLEAN     NOT NULL DEFAULT false,
  kill_reason         TEXT,
  killed_at           TIMESTAMPTZ,
  killed_by           TEXT,
  tracking_paused     BOOLEAN     NOT NULL DEFAULT false,
  trading_day         DATE,
  realized_pnl_today  NUMERIC     NOT NULL DEFAULT 0,
  consecutive_losses  INTEGER     NOT NULL DEFAULT 0,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2) scalpy_trades: claim-before-place idempotency --------------------------
ALTER TABLE scalpy_trades ADD COLUMN IF NOT EXISTS dedupe_key TEXT;

-- At most ONE bet row per fixture-market, ever (the cross-process idempotency backstop).
CREATE UNIQUE INDEX IF NOT EXISTS scalpy_trades_dedupe_key_uniq
  ON scalpy_trades (dedupe_key) WHERE dedupe_key IS NOT NULL;

-- 3) Allow the new 'CLAIMED' status ----------------------------------------
-- (The inline CHECK created with the table is named scalpy_trades_status_check.)
ALTER TABLE scalpy_trades DROP CONSTRAINT IF EXISTS scalpy_trades_status_check;
ALTER TABLE scalpy_trades ADD CONSTRAINT scalpy_trades_status_check
  CHECK (status IN ('CLAIMED','PENDING','MATCHED','SETTLED','SKIPPED','FAILED'));
