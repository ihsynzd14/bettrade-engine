import axios from 'axios'
import { getSessionToken } from './betfair-auth.service.js'

const BETTING_API = 'https://api.betfair.com/exchange/betting/rest/v1.0'

/**
 * Place a limit order on Betfair, or simulate it in DRY_RUN mode.
 *
 * DRY_RUN mode is ACTIVE unless SCALPY_DRY_RUN=false in env.
 *
 * @param {Object} params
 * @param {string}       params.marketId
 * @param {number}       params.selectionId
 * @param {'BACK'|'LAY'} params.side
 * @param {number}       params.price         Betfair decimal price (e.g. 1.18)
 * @param {number}       params.size          Stake in GBP
 * @param {string}       params.customerRef   Unique reference (e.g. "scalpy_<uuid>")
 *
 * @returns {Promise<{ betId: string|null, status: string, matchedSize: number, averagePrice: number|null }>}
 */
export async function placeOrder({ marketId, selectionId, side, price, size, customerRef }) {
  const dryRun = process.env.SCALPY_DRY_RUN !== 'false'

  if (dryRun) {
    console.log(`[betfair-orders] DRY_RUN — would place ${side} ${size} @ ${price} on market ${marketId} sel ${selectionId}`)
    return {
      betId:        null,
      status:       'DRY_RUN',
      matchedSize:  0,
      averagePrice: null,
    }
  }

  const appKey       = process.env.BETFAIR_APP_KEY
  const sessionToken = getSessionToken()

  const body = {
    marketId,
    instructions: [{
      selectionId,
      handicap:  0,
      side,
      orderType: 'LIMIT',
      limitOrder: {
        size,
        price,
        persistenceType: 'LAPSE',
      },
    }],
    customerRef,
  }

  const response = await axios.post(
    `${BETTING_API}/placeOrders/`,
    body,
    {
      headers: {
        'X-Application':    appKey,
        'X-Authentication': sessionToken,
        'Content-Type':     'application/json',
        Accept:             'application/json',
      },
    }
  )

  const result = response.data
  if (result.status !== 'SUCCESS') {
    throw new Error(`[betfair-orders] placeOrders failed: ${JSON.stringify(result)}`)
  }

  const report = result.instructionReports?.[0]
  if (report?.status !== 'SUCCESS') {
    throw new Error(`[betfair-orders] Instruction failed: ${JSON.stringify(report)}`)
  }

  return {
    betId:        report.betId,
    status:       report.status,
    matchedSize:  report.sizeMatched ?? 0,
    averagePrice: report.averagePriceMatched ?? null,
  }
}
