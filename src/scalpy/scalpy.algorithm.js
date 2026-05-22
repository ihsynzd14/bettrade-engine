import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CONFIG_PATH = resolve(__dirname, '../../scalpy-config.json')

let cachedConfig = null

export function loadConfig() {
  const raw = readFileSync(CONFIG_PATH, 'utf-8')
  cachedConfig = JSON.parse(raw)
  console.log(`[scalpy.algorithm] Config loaded: ${cachedConfig.rules.length} rules, stake=${cachedConfig.stake}`)
  return cachedConfig
}

export function getConfig() {
  if (!cachedConfig) loadConfig()
  return cachedConfig
}

/**
 * Decide what action to take given current match state and market prices.
 *
 * @param {Object} params
 * @param {number} params.addedMinutes
 * @param {number} params.totalGoals
 * @param {number|null} params.bestBackUnder
 * @param {number|null} params.bestLayUnder
 * @param {number|null} params.bestBackOver
 * @param {number|null} params.bestLayOver
 *
 * @returns {{ action: 'BACK'|'LAY'|'SKIP', selection?: string, price?: number, stake?: number, reason: string }}
 */
export function decide({ addedMinutes, totalGoals, bestBackUnder, bestLayUnder, bestBackOver, bestLayOver }) {
  const config = getConfig()

  const rule = config.rules.find(r => r.addedMinutes === addedMinutes)
  if (!rule) {
    return { action: 'SKIP', reason: `no_rule_for_${addedMinutes}_added_minutes` }
  }

  let availablePrice = null
  if (rule.selection === 'UNDER' && rule.side === 'BACK') availablePrice = bestBackUnder
  if (rule.selection === 'UNDER' && rule.side === 'LAY')  availablePrice = bestLayUnder
  if (rule.selection === 'OVER'  && rule.side === 'BACK') availablePrice = bestBackOver
  if (rule.selection === 'OVER'  && rule.side === 'LAY')  availablePrice = bestLayOver

  if (availablePrice === null) {
    return { action: 'SKIP', reason: 'price_unavailable' }
  }

  if (rule.side === 'BACK' && availablePrice < rule.price) {
    return {
      action: 'SKIP',
      reason: `back_price_too_low: available=${availablePrice} required>=${rule.price}`
    }
  }
  if (rule.side === 'LAY' && availablePrice > rule.price) {
    return {
      action: 'SKIP',
      reason: `lay_price_too_high: available=${availablePrice} required<=${rule.price}`
    }
  }

  return {
    action:    rule.side,
    selection: rule.selection,
    price:     rule.price,
    stake:     config.stake,
    reason:    `rule_matched: ${addedMinutes}min → ${rule.side} ${rule.selection} @ ${rule.price}`,
  }
}
