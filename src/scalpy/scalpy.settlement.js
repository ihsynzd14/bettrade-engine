import { getPendingTrades, settleTrade } from '../repositories/trade.repository.js'
import { broadcast } from './scalpy.sse.js'
import { recordSettlement } from '../lib/control.js'
import { getConfig } from './scalpy.algorithm.js'

/**
 * Calculate DRY_RUN outcome based on final total goals.
 * Settlement threshold formula: parseFloat(marketType.replace('OVER_UNDER_', '')) / 10
 * e.g. OVER_UNDER_25 → 25 / 10 = 2.5; goals < 2.5 means Under wins
 *
 * @param {Object} trade     - Trade row from Supabase (snake_case fields)
 * @param {number} finalGoals - Total goals at full time
 */
function calcDryRunOutcome(trade, finalGoals) {
  const threshold = parseFloat(trade.market_type.replace('OVER_UNDER_', '')) / 10

  // Under X.5 wins if final goals < threshold (e.g. goals < 2.5 → goals ≤ 2)
  const underWins = finalGoals < threshold

  let outcome
  if (trade.selection === 'UNDER') {
    outcome = trade.side === 'BACK'
      ? (underWins ? 'WON' : 'LOST')
      : (underWins ? 'LOST' : 'WON')
  } else {
    // OVER
    outcome = trade.side === 'BACK'
      ? (underWins ? 'LOST' : 'WON')
      : (underWins ? 'WON' : 'LOST')
  }

  let pnl
  if (trade.side === 'BACK') {
    pnl = outcome === 'WON'
      ? trade.stake * (trade.requested_price - 1)
      : -trade.stake
  } else {
    // LAY
    pnl = outcome === 'WON'
      ? trade.stake
      : -(trade.stake * (trade.requested_price - 1))
  }

  return { outcome, pnl: Math.round(pnl * 100) / 100 }
}

/**
 * Settle one trade in the DB + broadcast only — no circuit-breaker/daily-loss bookkeeping (callers
 * decide how to record it; see settleFixture for why friendly legs are batched).
 * @returns {{outcome, pnl, strategy}|null} null if already settled by another path (idempotent).
 */
async function settleOneTrade(trade, finalGoals) {
  const { outcome, pnl } = calcDryRunOutcome(trade, finalGoals)
  const settled = await settleTrade(trade.id, outcome, pnl)
  if (!settled) return null // already settled by another path — idempotent, don't double-count P&L
  console.log(`[settlement] DRY_RUN settled trade ${trade.id}: ${outcome} P&L=${pnl}`)
  broadcast({ type: 'trade_settled', data: { tradeId: trade.id, outcome, pnl, dryRun: true } })
  return { outcome, pnl, strategy: trade.strategy ?? 'stoppage' }
}

/**
 * Settle a single DRY_RUN trade using the final goal count, and record it as ONE circuit-breaker /
 * daily-loss event. For a friendly match's correlated legs, prefer `settleFixture` — it batches them
 * into a single event; calling this directly per leg would count each leg as an independent loss.
 */
export async function settleDryRunTrade(trade, finalGoals) {
  const result = await settleOneTrade(trade, finalGoals)
  if (!result) return
  await recordSettlement({ pnl: result.pnl, outcome: result.outcome, limits: getConfig().brakes ?? {} })
}

/**
 * Called by ScalpyEngine when FullTime phase change is detected.
 * Settles all DRY_RUN PENDING trades for this fixture.
 *
 * @param {string} geniusId
 * @param {number} finalGoals
 */
export async function settleFixture(geniusId, finalGoals) {
  try {
    const pending = await getPendingTrades()
    const forFixture = pending.filter(t => t.genius_id === geniusId && t.dry_run === true)

    const settled = []
    for (const trade of forFixture) {
      const result = await settleOneTrade(trade, finalGoals)
      if (result) settled.push(result)
    }

    // Circuit-breaker bookkeeping: a friendly match's up-to-3 correlated legs (87/88/89′) usually
    // bust or clear TOGETHER off the same late event, so they must count as ONE win/loss for the
    // streak counter, not up to 3 — otherwise a single bad friendly match can trip the breaker on
    // its own (Ersen 2026-07-12, PAOK v FC Twente: 3 legs LOST = 3 counted, tripped the breaker
    // alone). A clean sweep (every leg LOST) counts as one strike; ANY leg winning resets the streak,
    // same as a normal WON. Non-friendly settlements are still recorded one-for-one, unchanged.
    const friendlyLegs = settled.filter(r => r.strategy === 'friendly')
    const otherLegs = settled.filter(r => r.strategy !== 'friendly')
    for (const r of otherLegs) {
      await recordSettlement({ pnl: r.pnl, outcome: r.outcome, limits: getConfig().brakes ?? {} })
    }
    if (friendlyLegs.length > 0) {
      const anyWon = friendlyLegs.some(r => r.outcome === 'WON')
      const batchPnl = Math.round(friendlyLegs.reduce((s, r) => s + r.pnl, 0) * 100) / 100
      await recordSettlement({ pnl: batchPnl, outcome: anyWon ? 'WON' : 'LOST', limits: getConfig().brakes ?? {} })
    }

    if (forFixture.length > 0) {
      console.log(`[settlement] Settled ${forFixture.length} DRY_RUN trade(s) for geniusId=${geniusId}`)
    }
  } catch (err) {
    console.error(`[settlement] Error settling fixture ${geniusId}:`, err.message)
  }
}
