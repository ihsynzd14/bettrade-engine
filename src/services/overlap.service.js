import { getBetfairFixtures } from './betfair-fixtures.service.js'
import { getGeniusFixtures }  from './genius-fixtures.service.js'
import { fixtureSimilarity }  from '../lib/normalize.js'

const SIMILARITY_THRESHOLD = 0.65
const TIME_WINDOW_MS = 60 * 60 * 1000 // ±1 hour

/** In-memory state — no external cache */
let overlappedFixtures = []
let lastUpdated = null
let isPolling = false

/**
 * Returns the current overlapped fixtures list.
 *
 * @returns {{ fixtures: OverlappedFixture[], lastUpdated: string | null }}
 */
export function getOverlap() {
  return {
    fixtures: overlappedFixtures,
    lastUpdated,
  }
}

/**
 * Runs one sync cycle: fetch both sources, compute overlap, update state.
 */
export async function syncOnce() {
  console.log('[overlap] Sync started...')

  const [betfairFixtures, geniusFixtures] = await Promise.all([
    getBetfairFixtures(),
    getGeniusFixtures(),
  ])

  console.log(`[overlap] Betfair: ${betfairFixtures.length} markets | Genius: ${geniusFixtures.length} fixtures`)

  const matched = []

  for (const genius of geniusFixtures) {
    const geniusTime = new Date(genius.startTime).getTime()

    for (const betfair of betfairFixtures) {
      const betfairTime = new Date(betfair.startTime).getTime()

      // Time filter: only compare fixtures within ±1 hour of each other
      if (Math.abs(geniusTime - betfairTime) > TIME_WINDOW_MS) continue

      const score = fixtureSimilarity(
        { home: genius.home, away: genius.away },
        { home: betfair.home, away: betfair.away }
      )

      if (score >= SIMILARITY_THRESHOLD) {
        matched.push({
          matchId:        `bf_${betfair.betfairEventId}_gs_${genius.geniusId}`,
          geniusId:       genius.geniusId,
          betfairEventId: betfair.betfairEventId,
          betfairMarketId: betfair.betfairMarketId,
          homeTeam:       genius.home,
          awayTeam:       genius.away,
          startTime:      genius.startTime,
          status:         genius.status,
          similarityScore: Math.round(score * 100) / 100,
        })
        break // each genius fixture matches at most one betfair market
      }
    }
  }

  overlappedFixtures = matched
  lastUpdated = new Date().toISOString()

  console.log(`[overlap] Sync complete — ${matched.length} overlapped fixtures`)
}

/**
 * Starts the background polling loop.
 * Runs syncOnce immediately, then every POLL_INTERVAL_MS.
 */
export function startPolling() {
  if (isPolling) return
  isPolling = true

  const intervalMs = parseInt(process.env.POLL_INTERVAL_MS ?? '60000', 10)

  // Run immediately on startup
  syncOnce().catch(err => console.error('[overlap] Initial sync failed:', err.message))

  // Then on interval
  setInterval(() => {
    syncOnce().catch(err => console.error('[overlap] Sync error:', err.message))
  }, intervalMs)

  console.log(`[overlap] Polling started (interval: ${intervalMs}ms)`)
}
