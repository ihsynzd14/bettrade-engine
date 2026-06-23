import 'dotenv/config'
import { login } from './services/betfair-auth.service.js'
import { startPolling } from './services/overlap.service.js'
import { startEngine } from './scalpy/scalpy.engine.js'
import { startLiveSettlement } from './scalpy/scalpy.live-settlement.js'
import { startPricePoller } from './scalpy/scalpy.price-poller.js'
import { app } from './server.js'
import { DRY_RUN, LIVE_ARMED } from './lib/env.js'
import { loadControl, kill, isKilled, isPersistenceAvailable } from './lib/control.js'

const PORT = process.env.PORT ?? 4001
// Bind all interfaces by default so the engine is reachable on the machine's real/public IP
// (not just localhost). Override with HOST=127.0.0.1 to restrict to local only.
const HOST = process.env.HOST ?? '0.0.0.0'

async function main() {
  console.log('[engine] Starting bettrade-engine...')

  // Authenticate with Betfair
  await login()

  // Load kill-switch / daily risk state and enforce the live-mode guard BEFORE any placement.
  await loadControl()
  if (!DRY_RUN && !LIVE_ARMED) {
    await kill('live_mode_without_SCALPY_LIVE_CONFIRM', 'startup')
    console.error('[engine] 🔴 LIVE requested without SCALPY_LIVE_CONFIRM=I_UNDERSTAND — engine KILLED for safety')
  } else if (!DRY_RUN && !isPersistenceAvailable()) {
    await kill('live_mode_without_control_persistence', 'startup')
    console.error('[engine] 🔴 LIVE requested but scalpy_control table is missing — engine KILLED for safety')
  }

  // Start overlap sync loop (existing)
  startPolling()

  // Start Scalpy trading engine (async: rehydrates open bets before arming)
  await startEngine()

  // Start live settlement poller (no-op unless SCALPY_DRY_RUN=false)
  startLiveSettlement()

  // Start the live U/O price poller for the Live Fixtures cards
  startPricePoller()

  app.listen(PORT, HOST, () => {
    console.log(`[engine] Listening on http://${HOST}:${PORT} (all interfaces — reachable on this machine's IP)`)
    console.log(`[engine] Overlap:       /api/v1/fixtures/overlap`)
    console.log(`[engine] Scalpy stream: /api/scalpy/stream`)
    console.log(`[engine] DRY_RUN: ${DRY_RUN} | LIVE_ARMED: ${LIVE_ARMED} | killed: ${isKilled()}`)
  })
}

main().catch(err => {
  console.error('[engine] Fatal startup error:', err)
  process.exit(1)
})
