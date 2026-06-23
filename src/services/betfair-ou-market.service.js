import axios from 'axios'
import { getSessionToken } from './betfair-auth.service.js'

const BETTING_API = 'https://api.betfair.com/exchange/betting/rest/v1.0'

/**
 * Maps total goals to the Betfair marketTypeCode for Under/Over betting.
 * The threshold tracks the current goal count exactly (Scalpy bets that no further
 * goals are scored), so 6 goals → OVER_UNDER_65, 7 → OVER_UNDER_75, etc.
 * If Betfair doesn't offer that market for the fixture, getOuMarket returns null
 * and the engine skips the trade with reason 'no_market_found'.
 */
export function goalCountToMarketType(totalGoals) {
  const safe = Math.max(0, Math.floor(totalGoals))
  return `OVER_UNDER_${safe}5`
}

/** Numeric Under/Over threshold from a marketType, e.g. OVER_UNDER_25 → 2.5 */
export function thresholdFromMarketType(marketType) {
  return parseFloat(String(marketType).replace('OVER_UNDER_', '')) / 10
}

// Catalogue resolution cache, keyed by `${eventId}:${marketType}`. A market for a given
// (event, score) is stable, so successful results are cached indefinitely; misses are cached
// briefly to avoid hammering the catalogue endpoint for non-existent markets.
const ouIdCache = new Map() // key -> { result, ts }
const NULL_TTL_MS = 30_000

/**
 * Resolve just the marketId + runner selectionIds for the U/O market (no book), for the
 * price poller. Cheap and cached.
 * @returns {Promise<{ marketId, marketType, threshold, underSelectionId, overSelectionId }|null>}
 */
export async function resolveOuMarketId(eventId, marketType) {
  const key = `${eventId}:${marketType}`
  const hit = ouIdCache.get(key)
  if (hit && (hit.result || Date.now() - hit.ts < NULL_TTL_MS)) return hit.result

  const res = await axios.post(
    `${BETTING_API}/listMarketCatalogue/`,
    { filter: { eventIds: [eventId], marketTypeCodes: [marketType] }, marketProjection: ['RUNNER_DESCRIPTION'], maxResults: 5 },
    { headers: {
      'X-Application': process.env.BETFAIR_APP_KEY, 'X-Authentication': getSessionToken(),
      'Content-Type': 'application/json', Accept: 'application/json',
    } }
  )

  const market = res.data?.[0]
  const underRunner = market?.runners?.find(r => r.runnerName?.toLowerCase().includes('under'))
  const overRunner  = market?.runners?.find(r => r.runnerName?.toLowerCase().includes('over'))
  let result = null
  if (market && underRunner && overRunner) {
    result = {
      marketId: market.marketId, marketType, threshold: thresholdFromMarketType(marketType),
      underSelectionId: underRunner.selectionId, overSelectionId: overRunner.selectionId,
    }
  }
  ouIdCache.set(key, { result, ts: Date.now() })
  return result
}

/** Drop cached market resolutions for a finished event (prevents unbounded cache growth). */
export function forgetOuMarket(eventId) {
  const prefix = `${eventId}:`
  for (const key of ouIdCache.keys()) {
    if (key.startsWith(prefix)) ouIdCache.delete(key)
  }
}

/**
 * Fetch the Under/Over market for a given Betfair eventId and marketType.
 * Returns null if no market found or runners not identifiable.
 *
 * @param {string} eventId       - Betfair event ID (e.g. "29001234")
 * @param {string} marketType    - e.g. "OVER_UNDER_25"
 * @returns {Promise<{
 *   marketId: string,
 *   marketType: string,
 *   underSelectionId: number,
 *   overSelectionId: number,
 *   bestBackUnder: number|null,
 *   bestLayUnder: number|null,
 *   bestBackOver: number|null,
 *   bestLayOver: number|null
 * }|null>}
 */
export async function getOuMarket(eventId, marketType) {
  const appKey       = process.env.BETFAIR_APP_KEY
  const sessionToken = getSessionToken()

  const headers = {
    'X-Application':    appKey,
    'X-Authentication': sessionToken,
    'Content-Type':     'application/json',
    Accept:             'application/json',
  }

  // Step 1: list market catalogue to get runners
  const catalogueRes = await axios.post(
    `${BETTING_API}/listMarketCatalogue/`,
    {
      filter: {
        eventIds: [eventId],
        marketTypeCodes: [marketType],
      },
      marketProjection: ['RUNNER_DESCRIPTION'],
      maxResults: 5,
    },
    { headers }
  )

  const markets = catalogueRes.data
  if (!markets || markets.length === 0) {
    console.warn(`[betfair-ou] No ${marketType} market found for eventId ${eventId}`)
    return null
  }

  const market   = markets[0]
  const marketId = market.marketId

  // Identify Under and Over runners by name
  const underRunner = market.runners?.find(r =>
    r.runnerName?.toLowerCase().includes('under')
  )
  const overRunner = market.runners?.find(r =>
    r.runnerName?.toLowerCase().includes('over')
  )

  if (!underRunner || !overRunner) {
    console.warn(`[betfair-ou] Could not identify Under/Over runners for market ${marketId}`)
    return null
  }

  // Step 2: fetch live book
  const bookRes = await axios.post(
    `${BETTING_API}/listMarketBook/`,
    {
      marketIds: [marketId],
      priceProjection: {
        priceData: ['EX_BEST_OFFERS'],
        exBestOffersOverrides: { bestPricesDepth: 1 },
      },
    },
    { headers }
  )

  const book = bookRes.data?.[0]
  if (!book) return null

  const bookMap = new Map(book.runners?.map(r => [r.selectionId, r]) ?? [])

  const underBook = bookMap.get(underRunner.selectionId)
  const overBook  = bookMap.get(overRunner.selectionId)

  return {
    marketId,
    marketType,
    status: book.status ?? null,
    underSelectionId: underRunner.selectionId,
    overSelectionId:  overRunner.selectionId,
    bestBackUnder: underBook?.ex?.availableToBack?.[0]?.price ?? null,
    bestLayUnder:  underBook?.ex?.availableToLay?.[0]?.price  ?? null,
    bestBackOver:  overBook?.ex?.availableToBack?.[0]?.price  ?? null,
    bestLayOver:   overBook?.ex?.availableToLay?.[0]?.price   ?? null,
  }
}
