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
 * Settle a single DRY_RUN trade using the final goal count.
 */
export async function settleDryRunTrade(trade, finalGoals) {
  const { outcome, pnl } = calcDryRunOutcome(trade, finalGoals)
  const settled = await settleTrade(trade.id, outcome, pnl)
  if (!settled) return // already settled by another path — idempotent, don't double-count P&L
  console.log(`[settlement] DRY_RUN settled trade ${trade.id}: ${outcome} P&L=${pnl}`)
  broadcast({ type: 'trade_settled', data: { tradeId: trade.id, outcome, pnl, dryRun: true } })
  await recordSettlement({ pnl, outcome, limits: getConfig().brakes ?? {} })
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

    for (const trade of forFixture) {
      await settleDryRunTrade(trade, finalGoals)
    }

    if (forFixture.length > 0) {
      console.log(`[settlement] Settled ${forFixture.length} DRY_RUN trade(s) for geniusId=${geniusId}`)
    }
  } catch (err) {
    console.error(`[settlement] Error settling fixture ${geniusId}:`, err.message)
  }
}
