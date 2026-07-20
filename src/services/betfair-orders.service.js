import axios from 'axios'
import https from 'https'
import { getSessionToken } from './betfair-auth.service.js'
import { DRY_RUN } from '../lib/env.js'

const BETTING_API = 'https://api.betfair.com/exchange/betting/rest/v1.0'

// Persistent keep-alive agent for Betfair betting API calls. Reusing the TLS socket avoids a fresh
// handshake (~100-200ms) on every placeOrders / cancelOrders call — critical for low-latency placement.
const betfairAgent = new https.Agent({ keepAlive: true, maxSockets: 4 })

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
 * @returns {Promise<{ betId: string|null, status: string, matchedSize: number, averagePrice: number|null, betStatus: string }>}
 *   status:    top-level Betfair response status ('SUCCESS' / 'DRY_RUN')
 *   betStatus: Betfair order status — 'EXECUTION_COMPLETE' | 'EXECUTABLE' (live), 'EXECUTION_COMPLETE' (dry-run simulation)
 */
export async function placeOrder({ marketId, selectionId, side, price, size, customerRef }) {
  const t0 = performance.now()
  if (DRY_RUN) {
    console.log(`[betfair-orders] DRY_RUN — would place ${side} ${size} @ ${price} on market ${marketId} sel ${selectionId}`)
    // Simulate a full match so the live-matching code path produces realistic output in dry-run too.
    return {
      betId:        null,
      status:       'DRY_RUN',
      matchedSize:  size,
      averagePrice: price,
      betStatus:    'EXECUTION_COMPLETE',
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
      httpAgent:  betfairAgent,
      httpsAgent: betfairAgent,
      headers: {
        'X-Application':    appKey,
        'X-Authentication': sessionToken,
        'Content-Type':     'application/json',
        Accept:             'application/json',
      },
    }
  )

  const tEl = (performance.now() - t0).toFixed(0)
  const result = response.data
  if (result.status !== 'SUCCESS') {
    console.log(`[betfair-orders] placeOrders ${side} ${size}@${price} m=${marketId} FAILED in ${tEl}ms`)
    throw new Error(`[betfair-orders] placeOrders failed: ${JSON.stringify(result)}`)
  }

  const report = result.instructionReports?.[0]
  if (report?.status !== 'SUCCESS') {
    console.log(`[betfair-orders] placeOrders ${side} ${size}@${price} m=${marketId} instruction FAILED in ${tEl}ms`)
    throw new Error(`[betfair-orders] Instruction failed: ${JSON.stringify(report)}`)
  }

  console.log(`[betfair-orders] placeOrders ${side} ${size}@${price} m=${marketId} OK in ${tEl}ms matched=${report.sizeMatched ?? 0}@${report.averagePriceMatched ?? '?'}`)

  return {
    betId:        report.betId,
    status:       report.status,        // top-level instruction status ('SUCCESS')
    matchedSize:  report.sizeMatched ?? 0,
    averagePrice: report.averagePriceMatched ?? null,
    betStatus:    report.orderStatus ?? null, // EXECUTABLE / EXECUTION_COMPLETE / EXPIRED / CANCELLED
  }
}

/**
 * Cancel the UNMATCHED portion of the given bets on a market (used by the kill-switch in live
 * mode). Fully-matched bets are unaffected (nothing to cancel). No-op in DRY_RUN.
 */
export async function cancelOrders(marketId, betIds = []) {
  if (DRY_RUN) {
    console.log(`[betfair-orders] DRY_RUN — would cancel ${betIds.length} order(s) on ${marketId}`)
    return { status: 'DRY_RUN' }
  }
  const response = await axios.post(
    `${BETTING_API}/cancelOrders/`,
    { marketId, instructions: betIds.map(betId => ({ betId })) },
    { httpAgent: betfairAgent, httpsAgent: betfairAgent, headers: {
      'X-Application': process.env.BETFAIR_APP_KEY, 'X-Authentication': getSessionToken(),
      'Content-Type': 'application/json', Accept: 'application/json',
    } }
  )
  return response.data
}
