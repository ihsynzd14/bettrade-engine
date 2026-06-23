/**
 * Live U/O price poller for the Live Fixtures cards. Fetches the current-score Under/Over book
 * (BBP/BLP/LTP for the UNDER runner) for every watched, in-play tracked fixture.
 *
 * Tuned to be as fast as possible without straining the server or Betfair:
 *  - SELF-SCHEDULING (next run only after the previous finishes → never overlaps/piles up)
 *  - BATCHED (one listMarketBook request covers up to 40 markets via fetchMarketBooks)
 *  - CHANGE-ONLY broadcast (no SSE/CPU spam when prices are unchanged)
 *  - ADAPTIVE BACKOFF on Betfair errors/rate-limits (×2 up to a cap, recovers when healthy)
 */
import { getAllStates, getState, setOuBook } from './scalpy.match-state.js'
import { goalCountToMarketType, resolveOuMarketId } from '../services/betfair-ou-market.service.js'
import { fetchMarketBooks } from '../services/betfair-market.service.js'
import { broadcast } from './scalpy.sse.js'

const POLL_MS        = parseInt(process.env.SCALPY_OU_POLL_MS ?? '3000', 10)
const MAX_BACKOFF_MS = 12000

let timer = null
let currentBackoff = POLL_MS

export function startPricePoller() {
  console.log(`[scalpy.price-poller] Started (interval: ${POLL_MS}ms, batched + change-only + backoff)`)
  schedule(POLL_MS)
}

export function stopPricePoller() {
  if (timer) clearTimeout(timer)
  timer = null
}

function schedule(ms) {
  timer = setTimeout(tick, ms)
}

async function tick() {
  let hadError = false
  try {
    const live = getAllStates().filter(s => s.watching && s.phase !== 'FullTime' && s.betfairEventId)
    if (live.length === 0) { schedule(POLL_MS); return }

    // Resolve (cached) marketIds and group fixtures sharing a market.
    const byMarket = new Map() // marketId -> { resolved, geniusIds: [] }
    for (const s of live) {
      const marketType = goalCountToMarketType(s.totalGoals)
      let resolved
      try {
        resolved = await resolveOuMarketId(s.betfairEventId, marketType)
      } catch (err) {
        hadError = true
        continue
      }
      if (!resolved) { setOuBookIfChanged(s.geniusId, null); continue }
      if (!byMarket.has(resolved.marketId)) byMarket.set(resolved.marketId, { resolved, geniusIds: [] })
      byMarket.get(resolved.marketId).geniusIds.push(s.geniusId)
    }

    const marketIds = [...byMarket.keys()]
    if (marketIds.length) {
      let books = new Map()
      try {
        books = await fetchMarketBooks(marketIds)
      } catch (err) {
        hadError = true
      }
      for (const [marketId, { resolved, geniusIds }] of byMarket) {
        const book = books.get(marketId)
        const ouBook = book ? extractUnderBook(resolved, book) : null
        for (const gid of geniusIds) setOuBookIfChanged(gid, ouBook)
      }
    }
  } catch (err) {
    hadError = true
    console.error('[scalpy.price-poller] tick error:', err.message)
  }

  // Adaptive backoff: slow down on errors/rate-limits, snap back when healthy.
  currentBackoff = hadError ? Math.min(currentBackoff * 2, MAX_BACKOFF_MS) : POLL_MS
  schedule(currentBackoff)
}

function extractUnderBook(resolved, book) {
  const r = book.runners?.find(x => x.selectionId === resolved.underSelectionId)
  return {
    marketId:         resolved.marketId,
    marketType:       resolved.marketType,
    threshold:        resolved.threshold,
    underSelectionId: resolved.underSelectionId,
    status:           book.status ?? null,
    bbp:              r?.back?.[0]?.price ?? null,
    blp:              r?.lay?.[0]?.price ?? null,
    ltp:              r?.lastPriceTraded ?? null,
  }
}

function setOuBookIfChanged(geniusId, ouBook) {
  const s = getState(geniusId)
  if (!s) return
  const prev = s.ouBook
  const changed = (!prev) !== (!ouBook) || (prev && ouBook && (
    prev.bbp !== ouBook.bbp || prev.blp !== ouBook.blp || prev.ltp !== ouBook.ltp ||
    prev.status !== ouBook.status || prev.marketType !== ouBook.marketType
  ))
  if (!changed) return
  setOuBook(geniusId, ouBook)
  broadcast({ type: 'ou_book', geniusId, data: ouBook })
}
