import { Router } from 'express'
import { readFileSync, writeFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { addClient } from '../scalpy/scalpy.sse.js'
import { loadConfig } from '../scalpy/scalpy.algorithm.js'
import { getTrades, getTradeById, getSummary } from '../repositories/trade.repository.js'
import { getAllStates } from '../scalpy/scalpy.match-state.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CONFIG_PATH = resolve(__dirname, '../../scalpy-config.json')

const router = Router()

// GET /api/scalpy/stream — SSE live events
router.get('/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()

  // Send current states immediately on connect
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
    const summary = await getSummary()
    res.json({ ok: true, summary })
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message })
  }
})

// POST /api/scalpy/config — Hot-reload algorithm config
router.post('/config', (req, res) => {
  try {
    if (req.body && Object.keys(req.body).length > 0) {
      writeFileSync(CONFIG_PATH, JSON.stringify(req.body, null, 2))
    }
    const config = loadConfig()
    res.json({ ok: true, config })
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message })
  }
})

export { router as scalpyRoutes }
