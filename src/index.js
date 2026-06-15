import 'dotenv/config'
import { login } from './services/betfair-auth.service.js'
import { startPolling } from './services/overlap.service.js'
import { startEngine } from './scalpy/scalpy.engine.js'
import { startLiveSettlement } from './scalpy/scalpy.live-settlement.js'
import { app } from './server.js'

const PORT = process.env.PORT ?? 4001
// Bind all interfaces by default so the engine is reachable on the machine's real/public IP
// (not just localhost). Override with HOST=127.0.0.1 to restrict to local only.
const HOST = process.env.HOST ?? '0.0.0.0'

async function main() {
  console.log('[engine] Starting bettrade-engine...')

  // Authenticate with Betfair
  await login()

  // Start overlap sync loop (existing)
  startPolling()

  // Start Scalpy trading engine
  startEngine()

  // Start live settlement poller (no-op unless SCALPY_DRY_RUN=false)
  startLiveSettlement()

  app.listen(PORT, HOST, () => {
    console.log(`[engine] Listening on http://${HOST}:${PORT} (all interfaces — reachable on this machine's IP)`)
    console.log(`[engine] Overlap:       /api/v1/fixtures/overlap`)
    console.log(`[engine] Scalpy stream: /api/scalpy/stream`)
    console.log(`[engine] DRY_RUN mode: ${process.env.SCALPY_DRY_RUN !== 'false'}`)
  })
}

main().catch(err => {
  console.error('[engine] Fatal startup error:', err)
  process.exit(1)
})
