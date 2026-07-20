# Live Order Matching & Logging — Implementation Plan

**Goal:** Transition Scalpy from dry-run to live trading. The trading strategy itself stays unchanged. The critical change is **logging**: in dry-run every bet was treated as fully matched, but in live mode a Betfair order can be unmatched, partially matched, or fully matched at a different (often better) price. We must capture and log the actual match result for every bet.

**Context:** Dry-run finished +80 GBP over 10 days (8 up, 2 down). Now moving to real money. Stake starts at 2 GBP (partial matches rare at this size; will become common as stake scales to 50-100 GBP).

**Architecture:** Betfair's `placeOrders` response already returns `sizeMatched` and `averagePriceMatched`, but the engine discards them in dry-run. We add DB columns to persist the match result, capture it on placement, poll for changes via the existing live-settlement loop, surface it through SSE + the decision log, and display it in the frontend.

**Tech Stack:** Node.js (ES modules), Express, Supabase, Next.js 16, TypeScript, Tailwind v4

---

## Why this matters

In dry-run, `placeOrder()` returns `{ matchedSize: 0, averagePrice: null }` and settlement uses `requested_price` × `stake` as if fully matched. In live:

- A £2 BACK @ 1.20 order can return **unmatched** (no liquidity), **partial** (e.g. £1.35 matched), or **full**.
- The matched price can differ from requested: asking 1.20 with the board showing 1.22 fills at 1.22 (better for BACK).
- P&L must be calculated on the **matched** portion at the **matched** price, not the requested values.

Without logging this, the operator has no visibility into whether bets are actually being taken by the market.

---

## Phase 1: DB Schema — Match Result Columns

**Files:**
- Create: `migrations/scalpy-order-matching.sql`
- Edit: `src/repositories/trade.repository.js` (update `checkSchema`)

- [ ] **Step 1: Create `migrations/scalpy-order-matching.sql`**

Add columns to `scalpy_trades`:
- `matched_size NUMERIC` — actual GBP amount that matched (0 = unmatched, partial = partial, equal to stake = full)
- `size_matched_at TIMESTAMPTZ` — when the matched portion was confirmed
- `bet_status TEXT` — Betfair order status: `EXECUTABLE` (open/unmatched), `EXECUTION_COMPLETE` (fully matched), `EXPIRED`, `CANCELLED`

Update the status CHECK constraint to add `PARTIALLY_MATCHED`:
```
CHECK (status IN ('CLAIMED','PENDING','PARTIALLY_MATCHED','MATCHED','SETTLED','SKIPPED','FAILED'))
```

Note: `matched_price` already exists in the schema (currently null in dry-run). We will populate it from the order response going forward.

- [ ] **Step 2: Update `checkSchema()` in `trade.repository.js`**

Add `matched_size, bet_status` to the schema self-check columns so the engine screams at boot if the migration isn't applied.

---

## Phase 2: Engine — Capture Match Result on Placement

**Files:**
- Edit: `src/services/betfair-orders.service.js`
- Edit: `src/repositories/trade.repository.js`
- Edit: `src/scalpy/scalpy.engine.js`

- [ ] **Step 1: Extend `placeOrder()` return shape**

`betfair-orders.service.js` already returns `{ betId, status, matchedSize, averagePrice }`. In dry-run it returns zeros — keep that, but also expose a `betStatus` field mapped from Betfair's `instructionReport.status` for consistency.

- [ ] **Step 2: Update `promoteToPending()` in `trade.repository.js`**

Accept the full order result and persist:
- `matched_size` = `orderResult.matchedSize`
- `matched_price` = `orderResult.averagePrice` (only if non-null)
- `bet_status` = `orderResult.status`
- `size_matched_at` = now (if matchedSize > 0)

Decide initial trade status from match state:
- `matchedSize === 0` → `PENDING` (still open / waiting for live settlement)
- `0 < matchedSize < stake` → `PARTIALLY_MATCHED`
- `matchedSize >= stake` → `MATCHED`

- [ ] **Step 3: Capture match result in `executePlacement()` (`scalpy.engine.js`)**

After `placeOrder()`, pass the full result to `promoteToPending()`. Update the PLACED log line and SSE broadcast to include match outcome:
- Full: `PLACED @ 1.20 £2.00 → matched 2.00 @ 1.22`
- Partial: `PLACED @ 1.20 £2.00 → partial 1.35/2.00 @ 1.21`
- Unmatched: `PLACED @ 1.20 £2.00 → UNMATCHED (open)`

Extend `bet_placed` SSE payload with `matchedSize`, `matchedPrice`, `betStatus`.

- [ ] **Step 4: Dry-run parity**

In dry-run, `placeOrder()` returns `matchedSize: stake, averagePrice: requested_price, status: 'EXECUTION_COMPLETE'` so the new logging path produces "matched 2.00 @ 1.20" — preserving the old "treat as fully matched" behavior in dry-run while exercising the new code path.

---

## Phase 3: Live Settlement — Track Unmatched & Partial Orders

**Files:**
- Edit: `src/scalpy/scalpy.live-settlement.js`
- Edit: `src/repositories/trade.repository.js`

- [ ] **Step 1: Extend `updateMatchedStatus()`**

Current code only promotes `PENDING → MATCHED` on `EXECUTION_COMPLETE`. Extend to:
- `EXECUTION_COMPLETE` → set status to `MATCHED`, update `matched_size`, `matched_price`, `size_matched_at`. Broadcast `trade_matched`.
- `EXECUTABLE` with `sizeMatched > 0` but `< stake` → set status to `PARTIALLY_MATCHED`, update `matched_size`. Broadcast `trade_partial_match` (only when the value changes, to avoid spam).
- `EXECUTABLE` with `sizeMatched === 0` → no change (still unmatched, keep polling).
- `EXPIRED` / `CANCELLED` → settle/finish based on the matched portion (may be 0).

- [ ] **Step 2: New `updateMatchResult()` in `trade.repository.js`**

A targeted column update that doesn't touch status unless asked (so the poller can update `matched_size` on a partially-matched row repeatedly without clobbering status):

```js
updateMatchResult(tradeId, { matchedSize, matchedPrice, betStatus, sizeMatchedAt })
```

- [ ] **Step 3: Settle using actual matched amount**

In `settleClearedOrders()`, use `order.priceMatched` and `order.sizeSettled` from Betfair's cleared order report for P&L (not `trade.stake` / `trade.requested_price`). A partially-matched bet's P&L is computed on the matched portion only.

- [ ] **Step 4: Handle unmatched expiry**

When an order expires fully unmatched, mark the trade as `FAILED` with reason `unmatched_expired`. Do NOT count it as a loss (no money was risked). Log `UNMATCHED` decision. Broadcast `trade_unmatched`.

---

## Phase 4: Decision Trail — New Actions

**Files:**
- Edit: `src/scalpy/scalpy.decisions.js`
- Edit: `src/scalpy/scalpy.engine.js`
- Edit: `src/scalpy/scalpy.live-settlement.js`

- [ ] **Step 1: Add new action types to `logDecision()`**

Extend the JSDoc-accepted `action` union with `MATCHED`, `PARTIAL_MATCH`, `UNMATCHED`. The function itself accepts any string (no runtime change).

- [ ] **Step 2: Emit new actions**

- `MATCHED` — when an order transitions to fully matched (in live-settlement poller)
- `PARTIAL_MATCH` — when partial match amount changes
- `UNMATCHED` — when an order expires/cancels unmatched

Each log entry includes `matchedSize`, `matchedPrice`, `requestedPrice`, `stake` so the operator can see the full picture.

---

## Phase 5: Frontend — Display Match Details

**Files:**
- Edit: `bettrade/types/scalpy.ts`
- Edit: `bettrade/components/scalpy-trades-table.tsx`
- Edit: `bettrade/components/execution-panel.tsx` (if present)
- Edit: `bettrade/hooks/useScalpyStream.ts`

- [ ] **Step 1: Extend `ScalpyTrade` type**

Add `matched_size: number | null`, `bet_status: string | null`, `size_matched_at: string | null`.

- [ ] **Step 2: Update trades table**

Add columns / adjust existing ones:
- Show `matched_price` next to `requested_price` when they differ (e.g. "1.20 → 1.22")
- Show `matched_size` vs `stake` when partial (e.g. "1.35/2.00")
- Status colors: green for `MATCHED`, amber for `PARTIALLY_MATCHED`, red for `FAILED` (unmatched)
- Tooltip on status showing `bet_status` from Betfair

- [ ] **Step 3: New SSE event handlers**

Add `trade_partial_match` and `trade_unmatched` to the `ScalpySSEEvent` union. Update `useScalpyStream` and any panel that surfaces events.

---

## Phase 6: Operational Rollout

**Sequence:**

1. Apply `migrations/scalpy-order-matching.sql` in Supabase SQL editor
2. Deploy engine with `SCALPY_DRY_RUN=true` still — verify new logging works (trades should show "matched 2.00 @ 1.20" since dry-run simulates full match)
3. Set `SCALPY_DRY_RUN=false` + `SCALPY_LIVE_CONFIRM=I_UNDERSTAND` + `SCALPY_ADMIN_TOKEN=<secret>`
4. Enable `manualArm: true` in `scalpy-config.json` — every match starts disarmed
5. Arm ONE match under operator supervision, watch the decision log for match results
6. After N successful supervised matches, disable `manualArm` for full automation

**Rollback:** Set `SCALPY_DRY_RUN=true` and restart. All live settlements pause; dry-run resumes.

---

## Edge Cases

- **Partial match then market settles** — settle on `matched_size` at `matched_price`; log the unmatched remainder
- **Order matched at better price** — P&L uses `matched_price`; log highlights the improvement
- **Kill-switch fires with open orders** — `cancelAllUnmatchedLive()` already cancels unmatched portion; matched portion settles normally
- **Betfair API timeout after placeOrder** — trade stays `PENDING`/`CLAIMED`, live settlement poller picks it up on next tick via `listCurrentOrders`
- **Engine restart with open orders** — `getOpenBetGeniusIds()` rehydrates; live settlement continues tracking via `bet_id`
- **Friendly strategy's 3 correlated legs** — each leg tracked independently; the existing batched circuit-breaker logic still applies

---

## Files Touched Summary

**Engine (bettrade-engine):**
- `migrations/scalpy-order-matching.sql` (new)
- `src/repositories/trade.repository.js`
- `src/services/betfair-orders.service.js`
- `src/scalpy/scalpy.engine.js`
- `src/scalpy/scalpy.live-settlement.js`
- `src/scalpy/scalpy.decisions.js`

**Frontend (bettrade):**
- `types/scalpy.ts`
- `components/scalpy-trades-table.tsx`
- `hooks/useScalpyStream.ts`
- (optionally) `components/execution-panel.tsx`, `components/scalpy-summary-bar.tsx`
