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

/** Register a handler fired when the engine transitions to KILLED (e.g. cancel live orders). */
const onKillHandlers = []
export function onKill(fn) { onKillHandlers.push(fn) }

export async function kill(reason, by = 'system') {
  if (control.killed) return getControl() // monotonic: keep the original kill reason
  await persist({ killed: true, killReason: reason, killedAt: new Date().toISOString(), killedBy: by })
  console.warn(`[control] 🔴 KILLED by ${by}: ${reason}`)
  broadcast({ type: 'control_changed', data: getControl() })
  for (const fn of onKillHandlers) {
    Promise.resolve().then(() => fn(reason, by)).catch(e => console.error('[control] onKill handler error:', e.message))
  }
  return getControl()
}

export async function resume(by = 'operator') {
  // Also clear the consecutive-loss streak. `canPlaceBet` (scalpy.brakes.js) checks
  // `consecutiveLosses >= circuitBreakerLosses` as a standalone backstop, INDEPENDENT of `killed` —
  // so a circuit-breaker auto-kill left `killed:false` after resume() but the streak count still
  // past threshold, meaning EVERY bet kept silently BLOCKING (reason `circuit_breaker_tripped`) with
  // no losing trade ever able to happen to reset it, and no path back except the next Istanbul-day
  // rollover. Resume is an explicit operator decision to let the bot operate again — leaving the very
  // counter that triggered the kill in place defeated that purpose (found live 2026-07-11: resumed
  // but consecutiveLosses stayed at 6, bot silently frozen for the rest of the day).
  // `realizedPnlToday` is intentionally NOT reset here — it's real settled P&L (self-healing from the
  // DB), and "stay paused for the rest of today after hitting the DAILY loss limit" is the correct,
  // intended safety behaviour, unlike the streak counter which has no such daily-scoped meaning.
  await persist({ killed: false, killReason: null, killedAt: null, killedBy: by, consecutiveLosses: 0 })
  console.warn(`[control] 🟢 RESUMED by ${by} (consecutive-loss streak cleared)`)
  broadcast({ type: 'control_changed', data: getControl() })
  return getControl()
}

/**
 * Reset JUST the consecutive-loss streak — a targeted tool distinct from resume(), usable whether or
 * not the bot is currently killed. If the CURRENT kill was specifically caused by the circuit
 * breaker, this also un-kills (that's exactly what tripped it); a kill from another cause (manual,
 * daily-loss-limit) stays killed — use resume() for that. Lets the operator give the streak a fresh
 * start proactively (e.g. before it reaches the threshold) or clear a tripped breaker directly from
 * the admin panel without touching an unrelated kill reason.
 */
export async function resetCircuitBreaker(by = 'operator') {
  const wasCircuitBreakerKill = control.killed && !!control.killReason?.startsWith('circuit_breaker')
  const patch = { consecutiveLosses: 0 }
  if (wasCircuitBreakerKill) Object.assign(patch, { killed: false, killReason: null, killedAt: null, killedBy: by })
  await persist(patch)
  console.warn(`[control] 🔁 Circuit breaker reset by ${by}${wasCircuitBreakerKill ? ' (was killed by it — also resumed)' : ''}`)
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
