import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { addTicks, clampPrice } from './scalpy.ticks.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CONFIG_PATH = resolve(__dirname, '../../scalpy-config.json')

let cachedConfig = null

export function loadConfig() {
  const raw = readFileSync(CONFIG_PATH, 'utf-8')
  cachedConfig = JSON.parse(raw)
  const rungs = Object.keys(cachedConfig.ladder ?? {}).length
  console.log(`[scalpy.algorithm] Config loaded: ${rungs}-rung ladder, stake=${cachedConfig.stake}, stacking=${cachedConfig.adjustments?.stackAdjustments}`)
  return cachedConfig
}

export function getConfig() {
  if (!cachedConfig) loadConfig()
  return cachedConfig
}

/**
 * Decide the bet for a 2nd-half stoppage announcement (Scalpy v1 algorithm).
 *
 * Base price comes from the added-minutes ladder; then tick adjustments are applied along the
 * real Betfair tick ladder: +goalDiffTicks if the score difference >= threshold, +redCard2Ticks
 * if a team is down exactly 2 players. Adjustments stack additively or take the max per config.
 * A team down >= redCardSkipFrom players → SKIP. Order is a BACK UNDER limit at the chosen price.
 *
 * @param {Object} p
 * @param {number} p.addedMinutes - announced 2nd-half added minutes
 * @param {number} p.goalDiff      - |homeGoals - awayGoals|
 * @param {number} p.maxRedCards   - largest red-card count on a single team
 * @returns {{ action:'BACK'|'LAY'|'SKIP', selection?:string, price?:number, stake?:number, reason:string, adjustments?:object }}
 */
export function decide({ addedMinutes, goalDiff = 0, maxRedCards = 0 }) {
  const cfg = getConfig()
  const adj = cfg.adjustments ?? {}
  const bounds = cfg.priceBounds ?? { min: 1.01, max: 1000 }

  // Skip entirely if a team is down too many players.
  const skipFrom = adj.redCardSkipFrom ?? 3
  if (maxRedCards >= skipFrom) {
    return { action: 'SKIP', reason: `team_down_${maxRedCards}_players` }
  }

  // Ladder base price by announced added minutes.
  const maxMin = cfg.maxAddedMinutes ?? 7
  if (addedMinutes == null || addedMinutes < 1 || addedMinutes > maxMin) {
    return { action: 'SKIP', reason: `added_minutes_${addedMinutes}_out_of_range_1_${maxMin}` }
  }
  const base = cfg.ladder?.[String(addedMinutes)]
  if (base == null) {
    return { action: 'SKIP', reason: `no_ladder_entry_for_${addedMinutes}min` }
  }

  // Tick adjustments (stack additively, or take the max — per config).
  const goalDiffTicks = goalDiff >= (adj.goalDiffThreshold ?? 4) ? (adj.goalDiffTicks ?? 0) : 0
  const redCardTicks  = maxRedCards === 2 ? (adj.redCard2Ticks ?? 0) : 0
  const ticks = adj.stackAdjustments ? goalDiffTicks + redCardTicks : Math.max(goalDiffTicks, redCardTicks)

  const price = clampPrice(addTicks(base, ticks), bounds.min, bounds.max)

  const side = cfg.side ?? 'BACK'
  const selection = cfg.selection ?? 'UNDER'

  const bits = [`${addedMinutes}min(${base})`]
  if (goalDiffTicks) bits.push(`+${goalDiffTicks}t goalDiff`)
  if (redCardTicks)  bits.push(`+${redCardTicks}t redCard`)
  if (goalDiffTicks && redCardTicks && !adj.stackAdjustments) bits.push('(max)')

  return {
    action: side,
    selection,
    price,
    stake: cfg.stake,
    reason: `${bits.join(' ')} → ${side} ${selection} @ ${price}`,
    adjustments: { goalDiffTicks, redCardTicks, ticksApplied: ticks },
  }
}
