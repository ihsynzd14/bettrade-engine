import axios from 'axios'
import { getSessionToken } from '../services/betfair-auth.service.js'
import { getOpenLiveTrades, markTradeMatched, updateMatchResult, failTrade, settleTrade, getStrategyTradesForFixture } from '../repositories/trade.repository.js'
import { cancelOrders } from '../services/betfair-orders.service.js'
import { broadcast } from './scalpy.sse.js'
import { recordSettlement } from '../lib/control.js'
import { getConfig } from './scalpy.algorithm.js'
import { logDecision } from './scalpy.decisions.js'
import { DRY_RUN } from '../lib/env.js'

const BETTING_API    = 'https://api.betfair.com/exchange/betting/rest/v1.0'
const SETTLE_POLL_MS = parseInt(process.env.SCALPY_LIVE_SETTLE_MS ?? '60000', 10)

let intervalRef = null

function headers() {
  return {
    'X-Application':    process.env.BETFAIR_APP_KEY,
    'X-Authentication': getSessionToken(),
    'Content-Type':     'application/json',
    Accept:             'application/json',
  }
}

// ------------------------------------------------------------------
// Public API
// ------------------------------------------------------------------

/**
 * Start the live settlement poller. No-op in DRY_RUN mode (DRY_RUN trades are
 * settled from the final goal count by scalpy.settlement.js instead).
 */
export function startLiveSettlement() {
  if (DRY_RUN) {
    console.log('[scalpy.live-settlement] DRY_RUN mode — live settlement poller disabled')
    return
  }
  if (intervalRef) return

  // Fire one tick immediately at startup so we don't wait 15s to see if settlement works.
  tick().catch(err => console.error('[scalpy.live-settlement] startup tick error:', err.message))

  intervalRef = setInterval(() => {
    tick().catch(err => console.error('[scalpy.live-settlement] tick error:', err.message))
  }, SETTLE_POLL_MS)

  console.log(`[scalpy.live-settlement] Started (interval: ${SETTLE_POLL_MS}ms)`)
}

export function stopLiveSettlement() {
  if (intervalRef) {
    clearInterval(intervalRef)
    intervalRef = null
  }
}

/**
 * Emergency: cancel the unmatched portion of every open LIVE bet (called by the kill-switch).
 * No-op in DRY_RUN. Best-effort — errors are logged, never thrown.
 */
export async function cancelAllUnmatchedLive() {
  if (DRY_RUN) return
  try {
    const open = await getOpenLiveTrades()
    const withBet = open.filter(t => t.bet_id)
    if (withBet.length === 0) return

    const byMarket = new Map()
    for (const t of withBet) {
      if (!byMarket.has(t.betfair_market_id)) byMarket.set(t.betfair_market_id, [])
      byMarket.get(t.betfair_market_id).push(t.bet_id)
    }
    for (const [marketId, betIds] of byMarket) {
      try {
        await cancelOrders(marketId, betIds)
        console.log(`[scalpy.live-settlement] 🛑 Kill cancelled unmatched on ${marketId} (${betIds.length} bet(s))`)
      } catch (err) {
        console.error(`[scalpy.live-settlement] cancel failed for ${marketId}:`, err.message)
      }
    }
  } catch (err) {
    console.error('[scalpy.live-settlement] cancelAllUnmatchedLive error:', err.message)
  }
}

// ------------------------------------------------------------------
// Internal
// ------------------------------------------------------------------

async function tick() {
  const open = await getOpenLiveTrades()
  if (!open || open.length === 0) return

  const betIds = open.map(t => t.bet_id).filter(Boolean)
  if (betIds.length === 0) {
    console.warn(`[scalpy.live-settlement] ${open.length} open trade(s) but NONE have a bet_id — cannot query Betfair`)
    return
  }

  // 1. Reconcile current orders: PENDING → PARTIALLY_MATCHED → MATCHED, or FAILED on expiry.
  const reconciled = await reconcileCurrentOrders(open, betIds)

  // 2. Settle (-> SETTLED) using Betfair's real settled P&L once the market resolves.
  const settled = await settleClearedOrders(open, betIds)

  // Diagnostic: surface "open but not found anywhere on Betfair" so stuck trades are visible
  // instead of silently rotting. If after several ticks a trade is still open and Betfair returns
  // nothing for it in either API, something is wrong (bet_id mismatch, Betfair delay, etc.).
  const found = reconciled.found + settled.found
  const missing = open.length - found
  if (missing > 0) {
    console.warn(`[scalpy.live-settlement] tick: ${open.length} open, ${betIds.length} betIds, currentOrders=${reconciled.returned}, clearedOrders=${settled.returned}, settled=${settled.count}, MISSING=${missing} (not found in either Betfair API)`)
  } else if (settled.count > 0 || reconciled.count > 0) {
    console.log(`[scalpy.live-settlement] tick: ${open.length} open, currentOrders=${reconciled.returned}, clearedOrders=${settled.returned}, reconciled=${reconciled.count}, settled=${settled.count}`)
  }
}

/**
 * Poll listCurrentOrders for every open live trade and update match state.
 * Transitions:
 *   PENDING → PARTIALLY_MATCHED (sizeMatched > 0 but < stake, order still EXECUTABLE)
 *   PENDING/PARTIALLY_MATCHED → MATCHED (EXECUTION_COMPLETE)
 *   PENDING/PARTIALLY_MATCHED → FAILED (EXPIRED / CANCELLED with 0 matched — no money risked)
 *   MATCHED → MATCHED (final matched size may have changed — keep it in sync)
 */
async function reconcileCurrentOrders(open, betIds) {
  let res
  try {
    res = await axios.post(`${BETTING_API}/listCurrentOrders/`, { betIds }, { headers: headers() })
  } catch (err) {
    console.error('[scalpy.live-settlement] listCurrentOrders failed:', err.message)
    return { found: 0, returned: 0, count: 0 }
  }

  const orders = res.data?.currentOrders ?? []
  const byBetId = new Map(orders.map(o => [o.betId, o]))
  let actionsTaken = 0

  for (const trade of open) {
    // Skip already-settled or already-failed trades.
    if (trade.status === 'SETTLED' || trade.status === 'FAILED') continue

    const order = byBetId.get(trade.bet_id)

    // No order data — nothing to reconcile for this trade.
    if (!order) continue

    const ms = Number(order.sizeMatched ?? 0)
    const mp = order.averagePriceMatched ?? null
    const bs = order.status ?? null               // EXECUTABLE / EXECUTION_COMPLETE / EXPIRED / CANCELLED
    const stake = Number(trade.stake ?? 0)

    // ── Order expired or cancelled with NO matched amount → no money risked, mark FAILED ──
    if ((bs === 'EXPIRED' || bs === 'CANCELLED') && ms <= 0) {
      actionsTaken++
      try {
        await failTrade(trade.id, `${bs.toLowerCase()}_unmatched`, { matchedSize: 0 })
        console.log(`[scalpy.live-settlement] Trade ${trade.id} ${bs} — fully unmatched, no loss`)
        broadcast({ type: 'trade_unmatched', data: { tradeId: trade.id, requestedPrice: trade.requested_price, stake: trade.stake } })
        logDecision({ geniusId: trade.genius_id, match: `${trade.home_team} v ${trade.away_team}`,
          action: 'UNMATCHED', reason: `${bs.toLowerCase()}_unmatched`,
          detail: `Order ${bs} with 0 matched — requested @ ${trade.requested_price} £${trade.stake}` })
      } catch (err) {
        console.error(`[scalpy.live-settlement] failTrade(${bs}) failed for ${trade.id}:`, err.message)
      }
      continue
    }

    // ── Order fully executed → MATCHED ──
    if (bs === 'EXECUTION_COMPLETE') {
      // Already marked matched with the same size? Skip to avoid redundant broadcasts.
      if (trade.status === 'MATCHED' && trade.matched_size === ms) continue
      actionsTaken++
      try {
        await markTradeMatched(trade.id, mp, ms)
        console.log(`[scalpy.live-settlement] Trade ${trade.id} matched: ${ms.toFixed(2)} GBP @ ${mp ?? '?'}`)
        broadcast({ type: 'trade_matched', data: { tradeId: trade.id, matchedPrice: mp, matchedSize: ms, stake: trade.stake } })
        logDecision({ geniusId: trade.genius_id, match: `${trade.home_team} v ${trade.away_team}`,
          action: 'MATCHED', reason: 'fully_matched',
          detail: `${ms.toFixed(2)} GBP matched @ ${mp ?? '?'} (requested @ ${trade.requested_price})`,
          price: trade.requested_price, stake: trade.stake })
      } catch (err) {
        console.error(`[scalpy.live-settlement] markTradeMatched failed for ${trade.id}:`, err.message)
      }
      continue
    }

    // ── Order still open (EXECUTABLE) with partial match → PARTIALLY_MATCHED ──
    if (bs === 'EXECUTABLE' && ms > 0 && ms < stake) {
      // Only update when the matched size changed (avoids spam on every tick).
      if (trade.status === 'PARTIALLY_MATCHED' && trade.matched_size === ms) continue
      actionsTaken++
      try {
        await updateMatchResult(trade.id, { matchedSize: ms, matchedPrice: mp, betStatus: bs, stake })
        console.log(`[scalpy.live-settlement] Trade ${trade.id} partial match: ${ms.toFixed(2)}/${stake.toFixed(2)} GBP @ ${mp ?? '?'}`)
        broadcast({ type: 'trade_partial_match', data: { tradeId: trade.id, matchedSize: ms, stake: trade.stake, matchedPrice: mp } })
        logDecision({ geniusId: trade.genius_id, match: `${trade.home_team} v ${trade.away_team}`,
          action: 'PARTIAL_MATCH', reason: 'partial_matched',
          detail: `${ms.toFixed(2)}/${stake.toFixed(2)} GBP matched @ ${mp ?? '?'} (requested @ ${trade.requested_price})`,
          price: trade.requested_price, stake: trade.stake })
      } catch (err) {
        console.error(`[scalpy.live-settlement] updateMatchResult(partial) failed for ${trade.id}:`, err.message)
      }
      continue
    }

    // ── Order expired/cancelled WITH a partial match → settle on the matched portion only ──
    if ((bs === 'EXPIRED' || bs === 'CANCELLED') && ms > 0) {
      actionsTaken++
      try {
        await updateMatchResult(trade.id, { matchedSize: ms, matchedPrice: mp, betStatus: bs, stake })
        console.log(`[scalpy.live-settlement] Trade ${trade.id} ${bs} with partial match: ${ms.toFixed(2)}/${stake.toFixed(2)} GBP`)
        broadcast({ type: 'trade_partial_match', data: { tradeId: trade.id, matchedSize: ms, stake: trade.stake, matchedPrice: mp, final: true } })
        logDecision({ geniusId: trade.genius_id, match: `${trade.home_team} v ${trade.away_team}`,
          action: 'PARTIAL_MATCH', reason: `${bs.toLowerCase()}_partial`,
          detail: `${bs} — ${ms.toFixed(2)}/${stake.toFixed(2)} GBP matched @ ${mp ?? '?'} (rest unmatched)` })
      } catch (err) {
        console.error(`[scalpy.live-settlement] updateMatchResult(${bs}-partial) failed for ${trade.id}:`, err.message)
      }
      continue
    }
  }

  return { found: byBetId.size, returned: orders.length, count: actionsTaken }
}

/**
 * Settle fully-resolved trades using Betfair's cleared-order report.
 * Uses the actual priceMatched / sizeSettled from Betfair, not the requested values,
 * so partial-match trades settle on the matched portion only.
 */
async function settleClearedOrders(open, betIds) {
  let res
  try {
    // settledDateRange is CRITICAL: without it, Betfair defaults to a narrow window (start of today
    // or last few hours) and silently omits bets settled on previous days. This caused 19 trades to
    // stay stuck in PENDING for 24h+ — the poller ran but Betfair returned nothing for them.
    // 7-day window is generous; we filter by betIds anyway so the range just ensures inclusion.
    const nowIso = new Date().toISOString()
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
    res = await axios.post(
      `${BETTING_API}/listClearedOrders/`,
      {
        betStatus: 'SETTLED',
        betIds,
        settledDateRange: { from: sevenDaysAgo, to: nowIso },
        groupBy: 'BET',
      },
      { headers: headers() }
    )
  } catch (err) {
    console.error('[scalpy.live-settlement] listClearedOrders failed:', err.message)
    return { found: 0, returned: 0, count: 0 }
  }

  const orders = res.data?.clearedOrders ?? []
  const byBetId = new Map(orders.map(o => [o.betId, o]))
  let settledCount = 0

  for (const trade of open) {
    // Skip already-settled or failed trades.
    if (trade.status === 'SETTLED' || trade.status === 'FAILED') continue

    const order = byBetId.get(trade.bet_id)
    if (!order) continue

    const outcome = order.betOutcome === 'WON' ? 'WON' : 'LOST'
    // Use Betfair's actual profit (already accounts for matched price + commission).
    const pnl = Math.round((order.profit ?? 0) * 100) / 100

    // Update matched_size/price from the settled report if they changed.
    const settledSize = Number(order.sizeSettled ?? trade.matched_size ?? trade.stake ?? 0)
    const settledPrice = Number(order.priceMatched ?? trade.matched_price ?? trade.requested_price ?? 0)
    if (settledSize !== Number(trade.matched_size ?? 0) || settledPrice !== Number(trade.matched_price ?? 0)) {
      try {
        await updateMatchResult(trade.id, { matchedSize: settledSize, matchedPrice: settledPrice, betStatus: 'SETTLED', stake: trade.stake })
      } catch { /* best-effort */ }
    }

    try {
      const settled = await settleTrade(trade.id, outcome, pnl)
      if (!settled) continue // already settled — idempotent
      settledCount++
      console.log(`[scalpy.live-settlement] Trade ${trade.id} settled: ${outcome} P&L=${pnl} (${settledSize.toFixed(2)} GBP @ ${settledPrice})`)
      broadcast({ type: 'trade_settled', data: { tradeId: trade.id, outcome, pnl, dryRun: false, matchedSize: settledSize, matchedPrice: settledPrice } })
      await recordSettlementFor(trade, outcome, pnl)
    } catch (err) {
      console.error(`[scalpy.live-settlement] settleTrade failed for ${trade.id}:`, err.message)
    }
  }

  return { found: byBetId.size, returned: orders.length, count: settledCount }
}

/**
 * Record ONE trade's circuit-breaker/daily-loss effect — except a friendly leg, whose 87/88/89′
 * siblings can clear on Betfair across SEVERAL poller ticks (not necessarily together like the
 * DRY_RUN path's single-call settleFixture). Hold recording until every leg of that match has
 * resolved, then record it as ONE batched win/loss — same rationale as scalpy.settlement.js: 3
 * correlated legs must count as one strike, not up to 3 (Ersen 2026-07-12). DB-driven (re-queries
 * `scalpy_trades`, not in-memory tick state) so it stays correct across ticks and restarts.
 */
async function recordSettlementFor(trade, outcome, pnl) {
  const strategy = trade.strategy ?? 'stoppage'
  if (strategy !== 'friendly') {
    await recordSettlement({ pnl, outcome, limits: getConfig().brakes ?? {} })
    return
  }
  const siblings = await getStrategyTradesForFixture(trade.genius_id, 'friendly')
  const stillOpen = siblings.some(s => s.status === 'PENDING' || s.status === 'PARTIALLY_MATCHED' || s.status === 'MATCHED')
  if (stillOpen) return // other legs haven't resolved yet — this fixture's batch fires once they have
  const resolvedLegs = siblings.filter(s => s.status === 'SETTLED')
  if (resolvedLegs.length === 0) return // shouldn't happen (we just settled one) — defensive no-op
  const anyWon = resolvedLegs.some(s => s.outcome === 'WON')
  const batchPnl = Math.round(resolvedLegs.reduce((sum, s) => sum + Number(s.pnl ?? 0), 0) * 100) / 100
  await recordSettlement({ pnl: batchPnl, outcome: anyWon ? 'WON' : 'LOST', limits: getConfig().brakes ?? {} })
}
