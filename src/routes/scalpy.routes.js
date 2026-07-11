import { Router } from 'express'
import { readFileSync, writeFileSync, renameSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { addClient, broadcast } from '../scalpy/scalpy.sse.js'
import { loadConfig, getConfig } from '../scalpy/scalpy.algorithm.js'
import { getTrades, getTradesForDay, getTradeById, getSummary, getOpenLiability } from '../repositories/trade.repository.js'
import { getAllStates, getState, setWatching } from '../scalpy/scalpy.match-state.js'
import { getControl, kill, resume, resetCircuitBreaker, setTrackingPaused } from '../lib/control.js'
import { getDecisions } from '../scalpy/scalpy.decisions.js'
import { DRY_RUN, LIVE_ARMED } from '../lib/env.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CONFIG_PATH = resolve(__dirname, '../../scalpy-config.json')

const router = Router()

/** Shared-secret guard for mutating routes. Fail-closed in live mode if no token is set. */
function requireAdmin(req, res, next) {
  const token = process.env.SCALPY_ADMIN_TOKEN
  if (token) {
    if (req.get('X-Scalpy-Admin') === token) return next()
    return res.status(401).json({ ok: false, error: 'unauthorized' })
  }
  if (!DRY_RUN) return res.status(403).json({ ok: false, error: 'SCALPY_ADMIN_TOKEN required in live mode' })
  return next() // DRY_RUN dev convenience
}

// GET /api/scalpy/stream — SSE live events
router.get('/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()
  res.write(`data: ${JSON.stringify({ type: 'match_states', data: getAllStates() })}\n\n`)
  addClient(res)
})

// GET /api/scalpy/trades
router.get('/trades', async (req, res) => {
  try {
    const { limit = '50', dry_run, status } = req.query
    const trades = await getTrades({
      limit: parseInt(limit, 10),
      dryRun: dry_run === 'true' ? true : dry_run === 'false' ? false : undefined,
      status: status ?? undefined,
    })
    res.json({ ok: true, count: trades.length, trades })
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message })
  }
})

// GET /api/scalpy/trades/today — today's PLACED bets (Istanbul day) for the Scalpy tab
router.get('/trades/today', async (req, res) => {
  try {
    const trades = await getTradesForDay()
    res.json({ ok: true, count: trades.length, trades })
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message })
  }
})

// POST /api/scalpy/watch/:geniusId { watching } — manual eye/X tracking toggle
router.post('/watch/:geniusId', (req, res) => {
  const { geniusId } = req.params
  const s = getState(geniusId)
  if (!s) return res.status(404).json({ ok: false, error: 'fixture not tracked' })
  const watching = req.body?.watching !== false // default true if omitted
  setWatching(geniusId, watching)
  broadcast({ type: 'watch_toggled', geniusId, data: { watching } })
  res.json({ ok: true, geniusId, watching })
})

// GET /api/scalpy/trades/:id
router.get('/trades/:id', async (req, res) => {
  try {
    const trade = await getTradeById(req.params.id)
    res.json({ ok: true, trade })
  } catch (err) {
    res.status(404).json({ ok: false, error: err.message })
  }
})

// GET /api/scalpy/summary
router.get('/summary', async (req, res) => {
  try {
    res.json({ ok: true, summary: await getSummary() })
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message })
  }
})

// ----- Safety / admin -----

// GET /api/scalpy/control — full status for the admin panel
router.get('/control', async (req, res) => {
  try {
    let openLiability = null
    try { openLiability = await getOpenLiability() } catch { /* table may be mid-migration */ }
    const cfg = getConfig()
    res.json({
      ok: true,
      control: getControl(),
      dryRun: DRY_RUN,
      liveArmed: LIVE_ARMED,
      manualArm: cfg.manualArm ?? false,
      openLiability,
      brakes: cfg.brakes ?? null,
      friendly: cfg.friendly ?? null,
      stake: cfg.stake,
      maxStakeHardCap: cfg.maxStakeHardCap ?? null,
    })
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message })
  }
})

// POST /api/scalpy/control { action:'kill'|'resume'|'reset_circuit_breaker', pauseTracking?, manualArm?, reason? }
router.post('/control', requireAdmin, async (req, res) => {
  try {
    const { action, pauseTracking, manualArm, reason } = req.body ?? {}
    if (action === 'kill')        await kill(reason || 'manual_kill', 'operator')
    else if (action === 'resume') await resume('operator')
    else if (action === 'reset_circuit_breaker') await resetCircuitBreaker('operator')
    else if (action == null && pauseTracking == null && manualArm == null)
      return res.status(400).json({ ok: false, error: 'missing action' })
    if (pauseTracking != null) await setTrackingPaused(!!pauseTracking)
    if (manualArm != null) setManualArm(!!manualArm)
    res.json({ ok: true, control: getControl(), manualArm: getConfig().manualArm ?? false })
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message })
  }
})

/**
 * Toggle manual-arm mode: persist the flag to config (atomic write + hot-reload) and apply it to
 * every currently-tracked match at once — ON disarms all (nothing bets until the operator arms a
 * match with the eye button), OFF re-arms all (normal "bet every watched match" behaviour).
 */
function setManualArm(on) {
  const next = { ...getConfig(), manualArm: on }
  const tmp = `${CONFIG_PATH}.tmp`
  writeFileSync(tmp, JSON.stringify(next, null, 2))
  renameSync(tmp, CONFIG_PATH) // atomic swap — never leave a half-written config live
  loadConfig()
  for (const s of getAllStates()) {
    setWatching(s.geniusId, !on)
    broadcast({ type: 'watch_toggled', geniusId: s.geniusId, data: { watching: !on } })
  }
}

// GET /api/scalpy/log?limit=N — recent decisions for the panel
router.get('/log', (req, res) => {
  const limit = parseInt(req.query.limit ?? '50', 10)
  res.json({ ok: true, decisions: getDecisions(limit) })
})

// POST /api/scalpy/config — hot-reload config (atomic write, validate-before-swap)
router.post('/config', requireAdmin, (req, res) => {
  try {
    if (req.body && Object.keys(req.body).length > 0) {
      const next = req.body
      if (typeof next.stake !== 'number') throw new Error('config.stake must be a number')
      if (next.brakes != null && typeof next.brakes !== 'object') throw new Error('config.brakes must be an object')
      const tmp = `${CONFIG_PATH}.tmp`
      writeFileSync(tmp, JSON.stringify(next, null, 2))
      renameSync(tmp, CONFIG_PATH) // atomic swap — a malformed write never becomes the live config
    }
    res.json({ ok: true, config: loadConfig() })
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message })
  }
})

export { router as scalpyRoutes }
