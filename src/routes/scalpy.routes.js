import { Router } from 'express'
import { readFileSync, writeFileSync, renameSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { addClient } from '../scalpy/scalpy.sse.js'
import { loadConfig, getConfig } from '../scalpy/scalpy.algorithm.js'
import { getTrades, getTradeById, getSummary, getOpenLiability } from '../repositories/trade.repository.js'
import { getAllStates } from '../scalpy/scalpy.match-state.js'
import { getControl, kill, resume, setTrackingPaused } from '../lib/control.js'
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
      openLiability,
      brakes: cfg.brakes ?? null,
      stake: cfg.stake,
      maxStakeHardCap: cfg.maxStakeHardCap ?? null,
    })
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message })
  }
})

// POST /api/scalpy/control { action:'kill'|'resume', pauseTracking?, reason? }
router.post('/control', requireAdmin, async (req, res) => {
  try {
    const { action, pauseTracking, reason } = req.body ?? {}
    if (action === 'kill')        await kill(reason || 'manual_kill', 'operator')
    else if (action === 'resume') await resume('operator')
    else if (action == null && pauseTracking == null)
      return res.status(400).json({ ok: false, error: 'missing action' })
    if (pauseTracking != null) await setTrackingPaused(!!pauseTracking)
    res.json({ ok: true, control: getControl() })
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message })
  }
})

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
