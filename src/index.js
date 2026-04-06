import 'dotenv/config'
import { login } from './services/betfair-auth.service.js'
import { startPolling } from './services/overlap.service.js'
import { app } from './server.js'

const PORT = process.env.PORT ?? 4001

async function main() {
  console.log('[engine] Starting bettrade-engine...')

  // Authenticate with Betfair before polling starts
  await login()

  // Start 60-second overlap sync loop
  startPolling()

  app.listen(PORT, () => {
    console.log(`[engine] Listening on http://localhost:${PORT}`)
    console.log(`[engine] Overlap endpoint: http://localhost:${PORT}/api/v1/fixtures/overlap`)
  })
}

main().catch(err => {
  console.error('[engine] Fatal startup error:', err)
  process.exit(1)
})
