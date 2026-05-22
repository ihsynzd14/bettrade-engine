import axios from 'axios'
import { getSessionToken } from './betfair-auth.service.js'

const BETTING_API = 'https://api.betfair.com/exchange/betting/rest/v1.0'

/**
 * Maps total goals to the Betfair marketTypeCode for Under/Over betting.
 * Caps at 5 goals (OVER_UNDER_55 is the max standard market).
 * e.g. 2 goals → 'OVER_UNDER_25', 0 goals → 'OVER_UNDER_05'
 */
export function goalCountToMarketType(totalGoals) {
  const capped = Math.min(totalGoals, 5)
  return `OVER_UNDER_${capped}5`
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
    underSelectionId: underRunner.selectionId,
    overSelectionId:  overRunner.selectionId,
    bestBackUnder: underBook?.ex?.availableToBack?.[0]?.price ?? null,
    bestLayUnder:  underBook?.ex?.availableToLay?.[0]?.price  ?? null,
    bestBackOver:  overBook?.ex?.availableToBack?.[0]?.price  ?? null,
    bestLayOver:   overBook?.ex?.availableToLay?.[0]?.price   ?? null,
  }
}
