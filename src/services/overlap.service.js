import { getBetfairFixtures } from './betfair-fixtures.service.js'
import { getGeniusFixtures }  from './genius-fixtures.service.js'
import { fetchMarketBooks }   from './betfair-market.service.js'
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
 * @returns {{ fixtures: object[], lastUpdated: string | null }}
 */
export function getOverlap() {
  return {
    fixtures: overlappedFixtures,
    lastUpdated,
  }
}

/**
 * Merges runner names from listMarketCatalogue with price data from listMarketBook.
 * Maps runners by selectionId so names line up with back/lay prices.
 *
 * @param {Array<{ selectionId: number, runnerName: string, sortPriority: number }>} catalogueRunners
 * @param {Array<{ selectionId: number, lastPriceTraded: number|null, totalMatched: number, back: object[], lay: object[] }>} bookRunners
 * @returns {Array<{ name: string, selectionId: number, sortPriority: number, lastPriceTraded: number|null, totalMatched: number, back: object[], lay: object[] }>}
 */
function mergeRunners(catalogueRunners, bookRunners) {
  const bookMap = new Map()
  for (const br of bookRunners) {
    bookMap.set(br.selectionId, br)
  }

  return catalogueRunners
    .sort((a, b) => a.sortPriority - b.sortPriority)
    .map(cr => {
      const br = bookMap.get(cr.selectionId)
      return {
        name:            cr.runnerName,
        selectionId:     cr.selectionId,
        sortPriority:    cr.sortPriority,
        lastPriceTraded: br?.lastPriceTraded ?? null,
        totalMatched:    br?.totalMatched ?? 0,
        back:            br?.back ?? [],
        lay:             br?.lay ?? [],
      }
    })
}

/**
 * Runs one sync cycle: fetch both sources, compute overlap, enrich with market data.
 */
export async function syncOnce() {
  console.log('[overlap] Sync started...')

  const [betfairFixtures, geniusFixtures] = await Promise.all([
    getBetfairFixtures(),
    getGeniusFixtures(),
  ])

  console.log(`[overlap] Betfair: ${betfairFixtures.length} markets | Genius: ${geniusFixtures.length} fixtures`)

  // Build a lookup from betfairMarketId → full betfair fixture (for competition + runners)
  const betfairLookup = new Map()
  for (const bf of betfairFixtures) {
    betfairLookup.set(bf.betfairMarketId, bf)
  }

  const matched = []

  for (const genius of geniusFixtures) {
    const geniusTime = new Date(genius.startTime).getTime()

    for (const betfair of betfairFixtures) {
      const betfairTime = new Date(betfair.startTime).getTime()

      if (Math.abs(geniusTime - betfairTime) > TIME_WINDOW_MS) continue

      const score = fixtureSimilarity(
        { home: genius.home, away: genius.away },
        { home: betfair.home, away: betfair.away }
      )

      if (score >= SIMILARITY_THRESHOLD) {
        matched.push({
          matchId:         `bf_${betfair.betfairEventId}_gs_${genius.geniusId}`,
          geniusId:        genius.geniusId,
          betfairEventId:  betfair.betfairEventId,
          betfairMarketId: betfair.betfairMarketId,
          homeTeam:        genius.home,
          awayTeam:        genius.away,
          startTime:       genius.startTime,
          status:          genius.status,
          similarityScore: Math.round(score * 100) / 100,
        })
        break
      }
    }
  }

  console.log(`[overlap] Matched ${matched.length} fixtures, fetching market books...`)

  // Enrich with live Betfair market data
  const marketIds = matched.map(f => f.betfairMarketId)
  let marketBooks = new Map()

  try {
    marketBooks = await fetchMarketBooks(marketIds)
  } catch (err) {
    console.error('[overlap] Market book enrichment failed:', err.message)
  }

  // Merge market data into each fixture
  const enriched = matched.map(fixture => {
    const book = marketBooks.get(fixture.betfairMarketId)
    const catalogue = betfairLookup.get(fixture.betfairMarketId)

    if (!book) {
      return { ...fixture, market: null }
    }

    return {
      ...fixture,
      market: {
        status:       book.status,
        inplay:       book.inplay,
        totalMatched: book.totalMatched,
        competition:  catalogue?.competition ?? null,
        runners:      mergeRunners(catalogue?.runners ?? [], book.runners),
      },
    }
  })

  overlappedFixtures = enriched
  lastUpdated = new Date().toISOString()

  console.log(`[overlap] Sync complete — ${enriched.length} overlapped fixtures`)
}

/**
 * Starts the background polling loop.
 * Runs syncOnce immediately, then every POLL_INTERVAL_MS.
 */
export function startPolling() {
  if (isPolling) return
  isPolling = true

  const intervalMs = parseInt(process.env.POLL_INTERVAL_MS ?? '60000', 10)

  syncOnce().catch(err => console.error('[overlap] Initial sync failed:', err.message))

  setInterval(() => {
    syncOnce().catch(err => console.error('[overlap] Sync error:', err.message))
  }, intervalMs)

  console.log(`[overlap] Polling started (interval: ${intervalMs}ms)`)
}
