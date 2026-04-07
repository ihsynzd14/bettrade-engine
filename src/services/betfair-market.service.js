import axios from 'axios'
import { getSessionToken } from './betfair-auth.service.js'

const BETTING_API = 'https://api.betfair.com/exchange/betting/rest/v1.0'
const BATCH_SIZE = 40 // EX_BEST_OFFERS = 5 weight points per market → max 40 per 200-point request

/**
 * Fetches live market book data from Betfair for the given market IDs.
 * Batches requests to stay within the 200-point data limit.
 *
 * @param {string[]} marketIds - Array of Betfair market IDs
 * @returns {Promise<Map<string, object>>} Map of marketId → parsed market data
 */
export async function fetchMarketBooks(marketIds) {
  if (!marketIds.length) return new Map()

  const appKey = process.env.BETFAIR_APP_KEY
  const sessionToken = getSessionToken()

  const headers = {
    'X-Application':    appKey,
    'X-Authentication': sessionToken,
    'Content-Type':     'application/json',
    Accept:             'application/json',
    'Accept-Encoding':  'gzip, deflate',
    Connection:         'keep-alive',
  }

  const results = new Map()

  // Process in batches of BATCH_SIZE
  for (let i = 0; i < marketIds.length; i += BATCH_SIZE) {
    const batch = marketIds.slice(i, i + BATCH_SIZE)

    try {
      const response = await axios.post(
        `${BETTING_API}/listMarketBook/`,
        {
          marketIds: batch,
          priceProjection: {
            priceData: ['EX_BEST_OFFERS'],
            exBestOffersOverrides: { bestPricesDepth: 3 },
          },
        },
        { headers }
      )

      for (const book of response.data) {
        results.set(book.marketId, {
          status:       book.status,
          inplay:       book.inplay ?? false,
          totalMatched: book.totalMatched ?? 0,
          runners:      (book.runners ?? []).map(r => ({
            selectionId:     r.selectionId,
            lastPriceTraded: r.lastPriceTraded ?? null,
            totalMatched:    r.totalMatched ?? 0,
            back: (r.ex?.availableToBack ?? []).slice(0, 3).map(p => ({
              price: p.price,
              size:  p.size,
            })),
            lay: (r.ex?.availableToLay ?? []).slice(0, 3).map(p => ({
              price: p.price,
              size:  p.size,
            })),
          })),
        })
      }

      console.log(`[betfair-market] Fetched book for ${batch.length} markets (batch ${Math.floor(i / BATCH_SIZE) + 1})`)
    } catch (err) {
      console.error(`[betfair-market] Batch ${Math.floor(i / BATCH_SIZE) + 1} failed:`, err.message)
      if (err.response?.data) {
        console.error(`[betfair-market] Betfair error detail:`, JSON.stringify(err.response.data))
      }
    }
  }

  return results
}
