/**
 * The single safety gate every bet passes through before an order is placed.
 *
 * Ordered cheapest/most-decisive first; FAIL-CLOSED — any missing data or check error
 * BLOCKS the bet. Returns { allow:true } or { allow:false, reason, brake, detail }.
 */
import { isKilled, getControl } from '../lib/control.js'
import { LIVE_ARMED } from '../lib/env.js'
import { getMarketHasOpenBet, getOpenLiability } from '../repositories/trade.repository.js'

const STALE_MS = parseInt(process.env.SCALPY_STALE_MS ?? '45000', 10)

function liabilityFor(side, stake, price) {
  return side === 'LAY' ? stake * (price - 1) : stake
}

const block = (brake, reason, detail) => ({ allow: false, brake, reason, detail })

/**
 * @param {{ state:Object, decision:Object, ouMarket:Object, goalsAtDecision:number,
 *           dryRun:boolean, cfg:Object, currentMarketType:string }} ctx
 */
export async function canPlaceBet(ctx) {
  const { state, decision, ouMarket, goalsAtDecision, dryRun, cfg, currentMarketType, friendly = false } = ctx
  const brakes = cfg.brakes ?? {}

  // 1 — KILL-SWITCH
  if (isKilled()) return block('kill_switch', 'killed', getControl().killReason ?? '')

  // 2 — LIVE GUARD (real money requires the explicit two-flag arm)
  if (!dryRun && !LIVE_ARMED) return block('live_guard', 'live_not_confirmed')

  // 3 — PRICE + BOOK SANITY
  const price = decision.price
  if (!(typeof price === 'number' && price >= (brakes.priceMin ?? 1.01) && price <= (brakes.priceMax ?? 1000)))
    return block('price_bounds', 'price_out_of_bounds', String(price))
  if (brakes.requireBookPresent && ouMarket.bestBackUnder == null)
    return block('book_present', 'book_missing')
  if (brakes.requireMarketOpen && ouMarket.status && ouMarket.status !== 'OPEN')
    return block('market_open', 'market_not_open', String(ouMarket.status))

  // 4 — RUNNER SANITY (Under vs Over must be two distinct real selections)
  if (!ouMarket.underSelectionId || !ouMarket.overSelectionId ||
      ouMarket.underSelectionId === ouMarket.overSelectionId)
    return block('runner_sanity', 'runner_ids_invalid')

  // 5 — MAPPING CONFIDENCE (don't trade a weakly-matched fixture)
  if (state.similarityScore != null && brakes.minSimilarityScore != null &&
      state.similarityScore < brakes.minSimilarityScore)
    return block('mapping_confidence', 'low_mapping_confidence', String(state.similarityScore))

  // 6 — FEED FRESHNESS (don't act on a stale buffered event)
  if (state.lastEventReceivedAt && (Date.now() - state.lastEventReceivedAt) > STALE_MS)
    return block('feed_freshness', 'feed_stale', `${Date.now() - state.lastEventReceivedAt}ms`)

  // 7 — SCORE UNCHANGED during placement (a goal may have landed during the market fetch)
  if (state.totalGoals !== goalsAtDecision)
    return block('score_changed', 'score_changed_during_placement', `${goalsAtDecision}->${state.totalGoals}`)
  if (currentMarketType && ouMarket.marketType !== currentMarketType)
    return block('market_mismatch', 'market_type_mismatch', `${ouMarket.marketType}!=${currentMarketType}`)

  // 8 — ONE BET PER MARKET (friendly strategy places up to 3/market at 87/88/89; its minute-keyed
  //      dedupe_key bounds that to exactly 3, and the total-open-liability cap still applies)
  if (brakes.oneBetPerMarket && !friendly && await getMarketHasOpenBet(ouMarket.marketId))
    return block('one_bet_per_market', 'market_already_bet')

  // 9 — LIABILITY PER MARKET
  const liability = liabilityFor(decision.action, decision.stake, decision.price)
  if (brakes.maxLiabilityPerMarket != null && liability > brakes.maxLiabilityPerMarket)
    return block('liability_per_market', 'liability_per_market_exceeded', String(liability))

  // 10 — TOTAL OPEN LIABILITY
  if (brakes.maxTotalOpenLiability != null) {
    const open = await getOpenLiability()
    if (open.total + liability > brakes.maxTotalOpenLiability)
      return block('total_open_liability', 'total_open_liability_exceeded', `${open.total}+${liability}`)
  }

  // 11 — DAILY REALIZED-LOSS LIMIT (backstop; recordSettlement also auto-kills)
  const ctrl = getControl()
  if (brakes.dailyRealizedLossLimit != null &&
      ctrl.realizedPnlToday <= -Math.abs(brakes.dailyRealizedLossLimit))
    return block('daily_loss_limit', 'daily_loss_limit_reached', String(ctrl.realizedPnlToday))

  // 12 — CIRCUIT BREAKER (consecutive losses)
  if (brakes.circuitBreakerLosses != null && ctrl.consecutiveLosses >= brakes.circuitBreakerLosses)
    return block('circuit_breaker', 'circuit_breaker_tripped', String(ctrl.consecutiveLosses))

  // 13 — STAKE HARD CAP
  const cap = cfg.maxStakeHardCap
  if (cap != null && decision.stake > cap)
    return block('stake_hard_cap', 'stake_over_hard_cap', `${decision.stake}>${cap}`)

  return { allow: true, liability }
}
