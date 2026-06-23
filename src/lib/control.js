/**
 * Scalpy control state — kill-switch + per-day risk counters.
 *
 * Single authoritative Supabase row (`scalpy_control`, id='singleton') mirrored to an
 * in-memory cache read O(1) on the hot path. Mutated by the admin panel and by auto-kill
 * triggers (daily loss limit / circuit breaker).
 *
 * Degrades gracefully: if the table is missing (migration not yet applied), it runs
 * in-memory only and flags `persistenceAvailable=false` (DRY_RUN can still operate; going
 * LIVE without persistence is refused at startup).
 */
import { supabase } from './supabase.js'
import { broadcast } from '../scalpy/scalpy.sse.js'
import { getRealizedPnlToday } from '../repositories/trade.repository.js'
import { DRY_RUN } from './env.js'

const TZ = 'Europe/Istanbul'

/** UTC instant of the most recent Istanbul (UTC+3, no DST) midnight. */
function startOfIstanbulDayUtc() {
  return new Date(`${istanbulDay()}T00:00:00+03:00`).toISOString()
}

let persistenceAvailable = false

let control = {
  killed: false,
  killReason: null,
  killedAt: null,
  killedBy: null,
  trackingPaused: false,
  tradingDay: istanbulDay(),
  realizedPnlToday: 0,
  consecutiveLosses: 0,
}

export function istanbulDay(d = new Date()) {
  // 'en-CA' → YYYY-MM-DD; timeZone makes it the Istanbul calendar day.
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(d)
}

function fromRow(r) {
  return {
    killed:            !!r.killed,
    killReason:        r.kill_reason ?? null,
    killedAt:          r.killed_at ?? null,
    killedBy:          r.killed_by ?? null,
    trackingPaused:    !!r.tracking_paused,
    tradingDay:        r.trading_day ?? istanbulDay(),
    realizedPnlToday:  Number(r.realized_pnl_today ?? 0),
    consecutiveLosses: r.consecutive_losses ?? 0,
  }
}

function toRow() {
  return {
    killed:              control.killed,
    kill_reason:         control.killReason,
    killed_at:           control.killedAt,
    killed_by:           control.killedBy,
    tracking_paused:     control.trackingPaused,
    trading_day:         control.tradingDay,
    realized_pnl_today:  control.realizedPnlToday,
    consecutive_losses:  control.consecutiveLosses,
    updated_at:          new Date().toISOString(),
  }
}

export async function loadControl() {
  try {
    const { data, error } = await supabase
      .from('scalpy_control').select('*').eq('id', 'singleton').maybeSingle()
    if (error) throw error

    if (!data) {
      const { error: insErr } = await supabase
        .from('scalpy_control').insert({ id: 'singleton', ...toRow() })
      if (insErr) throw insErr
    } else {
      control = fromRow(data)
    }
    persistenceAvailable = true
    await rolloverIfNeeded()
    console.log(`[control] loaded (persisted) — killed=${control.killed} day=${control.tradingDay} pnlToday=${control.realizedPnlToday} losses=${control.consecutiveLosses}`)
  } catch (err) {
    persistenceAvailable = false
    console.error('[control] ⚠️ scalpy_control unavailable — running IN-MEMORY ONLY (kill-switch will not survive restart). Apply the migration. Detail:', err.message)
  }
  return getControl()
}

export function isPersistenceAvailable() { return persistenceAvailable }

async function persist(patch) {
  Object.assign(control, patch)
  if (!persistenceAvailable) return
  const { error } = await supabase.from('scalpy_control').update(toRow()).eq('id', 'singleton')
  if (error) console.error('[control] persist failed:', error.message)
}

export function getControl() { return { ...control, persistenceAvailable } }
export function isKilled() { return control.killed }
export function isTrackingPaused() { return control.trackingPaused }

export async function kill(reason, by = 'system') {
  if (control.killed) return getControl() // monotonic: keep the original kill reason
  await persist({ killed: true, killReason: reason, killedAt: new Date().toISOString(), killedBy: by })
  console.warn(`[control] 🔴 KILLED by ${by}: ${reason}`)
  broadcast({ type: 'control_changed', data: getControl() })
  return getControl()
}

export async function resume(by = 'operator') {
  await persist({ killed: false, killReason: null, killedAt: null, killedBy: by })
  console.warn(`[control] 🟢 RESUMED by ${by}`)
  broadcast({ type: 'control_changed', data: getControl() })
  return getControl()
}

export async function setTrackingPaused(paused) {
  await persist({ trackingPaused: !!paused })
  broadcast({ type: 'control_changed', data: getControl() })
  return getControl()
}

/**
 * Record a settled trade's effect on the daily risk counters and trip auto-kill on breach.
 * Auto-kills require MANUAL acknowledgment to resume (operator decision).
 *
 * @param {{ pnl:number, outcome:'WON'|'LOST', limits:{ dailyRealizedLossLimit?:number, circuitBreakerLosses?:number } }} p
 */
export async function recordSettlement({ pnl, outcome, limits = {} }) {
  await rolloverIfNeeded()
  // Recompute from the authoritative SETTLED rows rather than incrementing a float — this
  // self-heals a missed/failed counter write and can never drift or double-count (H3 fix).
  let realizedPnlToday
  try {
    realizedPnlToday = await getRealizedPnlToday(startOfIstanbulDayUtc(), DRY_RUN)
  } catch (err) {
    realizedPnlToday = Math.round((control.realizedPnlToday + (pnl ?? 0)) * 100) / 100
    console.error('[control] realized-P&L recompute failed, fell back to increment:', err.message)
  }
  const consecutiveLosses = outcome === 'LOST' ? control.consecutiveLosses + 1 : 0
  await persist({ realizedPnlToday, consecutiveLosses })

  const lossLimit = limits.dailyRealizedLossLimit
  const cbLosses  = limits.circuitBreakerLosses
  if (lossLimit != null && realizedPnlToday <= -Math.abs(lossLimit) && !control.killed) {
    await kill(`daily_loss_limit: realized=${realizedPnlToday} <= -${Math.abs(lossLimit)}`, 'auto')
  } else if (cbLosses != null && consecutiveLosses >= cbLosses && !control.killed) {
    await kill(`circuit_breaker: ${consecutiveLosses} consecutive losses`, 'auto')
  }
}

/**
 * On a new Istanbul day, reset the daily counters. The `killed` flag intentionally PERSISTS
 * across the rollover (an auto-killed bot must not silently re-arm a fresh loss budget).
 */
export async function rolloverIfNeeded() {
  const today = istanbulDay()
  if (control.tradingDay !== today) {
    await persist({ tradingDay: today, realizedPnlToday: 0, consecutiveLosses: 0 })
    console.log(`[control] daily rollover → ${today} (counters reset; killed stays ${control.killed})`)
  }
}
