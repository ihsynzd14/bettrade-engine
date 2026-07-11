import axios from 'axios'
import { getSessionToken } from '../services/betfair-auth.service.js'
import { getOpenLiveTrades, markTradeMatched, settleTrade, getStrategyTradesForFixture } from '../repositories/trade.repository.js'
import { cancelOrders } from '../services/betfair-orders.service.js'
import { broadcast } from './scalpy.sse.js'
import { recordSettlement } from '../lib/control.js'
import { getConfig } from './scalpy.algorithm.js'
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
  if (betIds.length === 0) return

  // 1. Promote PENDING -> MATCHED once the order is fully executed.
  await updateMatchedStatus(open, betIds)

  // 2. Settle (-> SETTLED) using Betfair's real settled P&L once the market resolves.
  await settleClearedOrders(open, betIds)
}

async function updateMatchedStatus(open, betIds) {
  let res
  try {
    res = await axios.post(`${BETTING_API}/listCurrentOrders/`, { betIds }, { headers: headers() })
  } catch (err) {
    console.error('[scalpy.live-settlement] listCurrentOrders failed:', err.message)
    return
  }

  const byBetId = new Map((res.data?.currentOrders ?? []).map(o => [o.betId, o]))

  for (const trade of open) {
    if (trade.status !== 'PENDING') continue
    const order = byBetId.get(trade.bet_id)
    if (!order || order.status !== 'EXECUTION_COMPLETE') continue

    try {
      await markTradeMatched(trade.id, order.averagePriceMatched ?? null)
      console.log(`[scalpy.live-settlement] Trade ${trade.id} matched @ ${order.averagePriceMatched ?? '?'}`)
      broadcast({ type: 'trade_matched', data: { tradeId: trade.id, matchedPrice: order.averagePriceMatched ?? null } })
    } catch (err) {
      console.error(`[scalpy.live-settlement] markTradeMatched failed for ${trade.id}:`, err.message)
    }
  }
}

async function settleClearedOrders(open, betIds) {
  let res
  try {
    res = await axios.post(
      `${BETTING_API}/listClearedOrders/`,
      { betStatus: 'SETTLED', betIds, groupBy: 'BET' },
      { headers: headers() }
    )
  } catch (err) {
    console.error('[scalpy.live-settlement] listClearedOrders failed:', err.message)
    return
  }

  const byBetId = new Map((res.data?.clearedOrders ?? []).map(o => [o.betId, o]))

  for (const trade of open) {
    const order = byBetId.get(trade.bet_id)
    if (!order) continue

    const outcome = order.betOutcome === 'WON' ? 'WON' : 'LOST'
    const pnl = Math.round((order.profit ?? 0) * 100) / 100

    try {
      const settled = await settleTrade(trade.id, outcome, pnl)
      if (!settled) continue // already settled — idempotent
      console.log(`[scalpy.live-settlement] Trade ${trade.id} settled: ${outcome} P&L=${pnl}`)
      broadcast({ type: 'trade_settled', data: { tradeId: trade.id, outcome, pnl, dryRun: false } })
      await recordSettlementFor(trade, outcome, pnl)
    } catch (err) {
      console.error(`[scalpy.live-settlement] settleTrade failed for ${trade.id}:`, err.message)
    }
  }
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
  const stillOpen = siblings.some(s => s.status === 'PENDING' || s.status === 'MATCHED')
  if (stillOpen) return // other legs haven't resolved yet — this fixture's batch fires once they have
  const resolvedLegs = siblings.filter(s => s.status === 'SETTLED')
  if (resolvedLegs.length === 0) return // shouldn't happen (we just settled one) — defensive no-op
  const anyWon = resolvedLegs.some(s => s.outcome === 'WON')
  const batchPnl = Math.round(resolvedLegs.reduce((sum, s) => sum + Number(s.pnl ?? 0), 0) * 100) / 100
  await recordSettlement({ pnl: batchPnl, outcome: anyWon ? 'WON' : 'LOST', limits: getConfig().brakes ?? {} })
}
