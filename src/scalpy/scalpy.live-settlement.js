import axios from 'axios'
import { getSessionToken } from '../services/betfair-auth.service.js'
import { getOpenLiveTrades, markTradeMatched, settleTrade } from '../repositories/trade.repository.js'
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
      await recordSettlement({ pnl, outcome, limits: getConfig().brakes ?? {} })
    } catch (err) {
      console.error(`[scalpy.live-settlement] settleTrade failed for ${trade.id}:`, err.message)
    }
  }
}
