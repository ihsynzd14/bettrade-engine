import axios from 'axios'
import {
  initState, getState, getAllStates,
  recordGoal, setPhase, setClock, setBettingDone, setLastSeenTs
} from './scalpy.match-state.js'
import { goalCountToMarketType, getOuMarket } from '../services/betfair-ou-market.service.js'
import { placeOrder } from '../services/betfair-orders.service.js'
import { decide, loadConfig } from './scalpy.algorithm.js'
import { saveTrade, upsertMatchState } from '../repositories/trade.repository.js'
import { broadcast } from './scalpy.sse.js'
import { getOverlap, onOverlapSync } from '../services/overlap.service.js'
import { settleFixture } from './scalpy.settlement.js'

const FEED_POLL_MS = parseInt(process.env.SCALPY_FEED_POLL_MS ?? '3000', 10)
const GENIUS_URL   = process.env.GENIUS_BACKEND_URL ?? 'http://localhost:3003'

// Each poll re-requests a small window before lastSeenTs so an event that shares a
// timestamp with an already-seen event isn't skipped by the server's strict `>` filter.
// Re-fetched events are de-duped by id (seenEventKeys), so nothing is processed twice.
const POLL_LOOKBACK_MS = 5000

/** Set of geniusIds currently being polled */
const polledFixtures = new Set()

/** geniusId -> Set of processed `${type}:${id}` keys (cross-poll de-dupe) */
const seenEventKeys = new Map()

/** geniusId -> feed-poll interval id (so a finished fixture can be stopped individually) */
const feedIntervals = new Map()

/** geniusId -> consecutive syncs the fixture has NOT been live (used to detect match end) */
const notLiveCount = new Map()

// A tracked match that leaves the live set for this many consecutive syncs is treated as
// finished. The Genius feed unsubscribes at match end, so we can't rely on a FullTime event.
const FINALIZE_AFTER_SYNCS = 2

// ------------------------------------------------------------------
// Public API
// ------------------------------------------------------------------

export function startEngine() {
  loadConfig()
  console.log('[scalpy.engine] Engine started')

  // Re-check live fixtures immediately after every overlap refresh (including the first
  // one at startup), so newly-live matches are picked up as soon as the data is fresh —
  // no fixed-interval lag waiting for the next 30s tick.
  onOverlapSync(syncLiveFixtures)
}

export function stopEngine() {
  for (const interval of feedIntervals.values()) clearInterval(interval)
  feedIntervals.clear()
  polledFixtures.clear()
  seenEventKeys.clear()
  notLiveCount.clear()
  console.log('[scalpy.engine] Engine stopped')
}

// ------------------------------------------------------------------
// Internal
// ------------------------------------------------------------------

/**
 * Persist a fixture's in-memory state to Supabase (fire-and-forget).
 * Failures are logged but never interrupt the trading loop.
 */
function persistState(geniusId) {
  const state = getState(geniusId)
  if (!state) return
  upsertMatchState(state).catch(err =>
    console.error(`[scalpy.engine] match-state persist failed for ${geniusId}:`, err.message)
  )
}

async function syncLiveFixtures() {
  const { fixtures } = getOverlap()
  // Genius reports an in-play match as eventStatusType "InProgress" (NOT "IN_PLAY");
  // Betfair's market.inplay is the secondary signal. Either one marks a fixture live.
  const liveFixtures = fixtures.filter(f =>
    f.status?.toLowerCase() === 'inprogress' || f.market?.inplay === true
  )

  console.log(`[scalpy.engine] sync: ${fixtures.length} overlap fixtures, ${liveFixtures.length} live (InProgress / inplay)`)

  const liveIds = new Set(liveFixtures.map(f => f.geniusId))

  for (const fixture of liveFixtures) {
    const { geniusId } = fixture
    initState(fixture)
    notLiveCount.delete(geniusId) // still live → reset the end-of-match counter

    if (!polledFixtures.has(geniusId)) {
      polledFixtures.add(geniusId)
      await startFeedForFixture(geniusId)
      const interval = setInterval(() => pollEvents(geniusId), FEED_POLL_MS)
      feedIntervals.set(geniusId, interval)
      persistState(geniusId)
      console.log(`[scalpy.engine] Now polling fixture geniusId=${geniusId}`)
    }
  }

  // Finalize tracked matches that have left the live set (ended / feed dropped).
  // Skip when the overlap is empty (likely a transient fetch failure, not all matches ending).
  if (fixtures.length > 0) {
    for (const geniusId of [...polledFixtures]) {
      if (liveIds.has(geniusId)) continue
      const misses = (notLiveCount.get(geniusId) ?? 0) + 1
      notLiveCount.set(geniusId, misses)
      if (misses >= FINALIZE_AFTER_SYNCS) {
        await finalizeFixture(geniusId)
      }
    }
  }

  broadcast({ type: 'match_states', data: getAllStates() })
}

/**
 * A tracked match is no longer live (Genius marked it Finished → dropped from the overlap,
 * or its feed unsubscribed at full time). We can't rely on a FullTime event from the dead
 * feed, so finalize directly: mark FullTime, settle DRY_RUN trades with the last-known
 * score, stop polling, and clean up.
 */
async function finalizeFixture(geniusId) {
  const interval = feedIntervals.get(geniusId)
  if (interval) clearInterval(interval)
  feedIntervals.delete(geniusId)
  polledFixtures.delete(geniusId)
  notLiveCount.delete(geniusId)
  seenEventKeys.delete(geniusId)

  const state = getState(geniusId)
  if (!state || state.phase === 'FullTime') return // already finalized via the feed

  setPhase(geniusId, 'FullTime')
  broadcast({ type: 'phase_change', geniusId, data: { phase: 'FullTime' } })
  broadcast({ type: 'full_time', geniusId })
  console.log(`[scalpy.engine] Fixture ${geniusId} left live set — finalizing (FullTime), settling with totalGoals=${state.totalGoals}`)

  try {
    await settleFixture(geniusId, state.totalGoals)
  } catch (err) {
    console.error(`[scalpy.engine] settle-on-finalize failed for ${geniusId}:`, err.message)
  }
  persistState(geniusId)
  broadcast({ type: 'match_states', data: getAllStates() })
}

async function startFeedForFixture(geniusId) {
  try {
    await axios.post(`${GENIUS_URL}/api/feed/start/${geniusId}`)
    console.log(`[scalpy.engine] Feed started for geniusId=${geniusId}`)
  } catch (err) {
    console.error(`[scalpy.engine] Failed to start feed for ${geniusId}:`, err.message)
  }
}

async function pollEvents(geniusId) {
  const state = getState(geniusId)
  if (!state) return

  try {
    const sinceTs = state.lastSeenTs
      ? new Date(new Date(state.lastSeenTs).getTime() - POLL_LOOKBACK_MS).toISOString()
      : undefined

    const res = await axios.get(`${GENIUS_URL}/api/feed/${geniusId}/events`, {
      params: { since: sinceTs },
    })

    const events = res.data?.events ?? []
    if (events.length === 0) return

    for (const event of events) {
      await processEvent(geniusId, event)
    }

    // Update lastSeenTs to the timestamp of the most recent event processed
    const lastTs = events[events.length - 1]?.timestamp
    if (lastTs) setLastSeenTs(geniusId, lastTs)

    // Persist the updated state (goals / phase / bettingDone / lastSeenTs)
    persistState(geniusId)
  } catch (err) {
    if (err.response?.status !== 404) {
      console.error(`[scalpy.engine] Poll error for ${geniusId}:`, err.message)
    }
  }
}

/**
 * True if this event was already processed for the fixture (cross-poll de-dupe by id).
 * Guards against re-counting goals when the poll look-back window overlaps.
 */
function alreadyProcessed(geniusId, event) {
  let keys = seenEventKeys.get(geniusId)
  if (!keys) {
    keys = new Set()
    seenEventKeys.set(geniusId, keys)
  }
  const key = event.id != null
    ? `${event.type}:${event.id}`
    : `${event.type}:${event.timestamp ?? ''}`
  if (keys.has(key)) return true
  keys.add(key)
  return false
}

async function processEvent(geniusId, event) {
  const state = getState(geniusId)
  if (!state) return

  if (alreadyProcessed(geniusId, event)) return

  // Any event that carries phase + timeElapsed advances the displayed minute.
  if (event.phase && event.timeElapsed) setClock(geniusId, event.phase, event.timeElapsed)

  switch (event.type) {
    case 'goals': {
      recordGoal(geniusId, event)
      const s = getState(geniusId)
      broadcast({ type: 'goal', geniusId, data: {
        totalGoals: s.totalGoals, homeGoals: s.homeGoals, awayGoals: s.awayGoals,
      } })
      break
    }

    case 'phaseChanges':
      setPhase(geniusId, event.currentPhase)
      broadcast({ type: 'phase_change', geniusId, data: { phase: event.currentPhase } })

      if (event.currentPhase === 'FullTime') {
        console.log(`[scalpy.engine] FullTime detected for geniusId=${geniusId}`)
        broadcast({ type: 'full_time', geniusId })
        const s = getState(geniusId)
        if (s) {
          await settleFixture(geniusId, s.totalGoals)
        }
      }
      break

    case 'stoppageTimeAnnouncements':
      // Surface the announced added minutes on the card immediately ("90+N")
      if (event.phase === 'SecondHalf' && Number.isFinite(event.addedMinutes)) {
        const s = getState(geniusId)
        if (s) s.currentMinute = `90+${event.addedMinutes}`
      }
      await handleStoppageTime(geniusId, event)
      break

    default:
      break
  }
}

async function handleStoppageTime(geniusId, event) {
  const state = getState(geniusId)
  if (!state) return

  // Guard: only act on SecondHalf stoppage
  if (event.phase !== 'SecondHalf') {
    console.log(`[scalpy.engine] Stoppage in ${event.phase} — skipping (not SecondHalf)`)
    return
  }

  // Guard: only bet once per match
  if (state.bettingDone) {
    console.log(`[scalpy.engine] bettingDone=true for geniusId=${geniusId} — skipping`)
    return
  }

  const addedMinutes = event.addedMinutes
  console.log(`[scalpy.engine] Stoppage detected! geniusId=${geniusId} addedMinutes=${addedMinutes} totalGoals=${state.totalGoals}`)

  // Set bettingDone BEFORE API call to prevent double-betting
  setBettingDone(geniusId)

  try {
    const marketType = goalCountToMarketType(state.totalGoals)
    const ouMarket   = await getOuMarket(state.betfairEventId, marketType)

    if (!ouMarket) {
      console.warn(`[scalpy.engine] No ${marketType} market found — cannot bet`)
      broadcast({ type: 'bet_skipped', geniusId, data: { reason: 'no_market_found', marketType } })
      return
    }

    const decision = decide({
      addedMinutes,
      totalGoals:    state.totalGoals,
      bestBackUnder: ouMarket.bestBackUnder,
      bestLayUnder:  ouMarket.bestLayUnder,
      bestBackOver:  ouMarket.bestBackOver,
      bestLayOver:   ouMarket.bestLayOver,
    })

    console.log(`[scalpy.engine] Decision: ${JSON.stringify(decision)}`)

    if (decision.action === 'SKIP') {
      console.log(`[scalpy.engine] SKIP — reason: ${decision.reason}`)
      broadcast({ type: 'bet_skipped', geniusId, data: { reason: decision.reason, addedMinutes } })
      return
    }

    const selectionId = decision.selection === 'UNDER'
      ? ouMarket.underSelectionId
      : ouMarket.overSelectionId

    const customerRef = `scalpy_${geniusId}_${Date.now()}`
    const orderResult = await placeOrder({
      marketId:    ouMarket.marketId,
      selectionId,
      side:        decision.action,
      price:       decision.price,
      size:        decision.stake,
      customerRef,
    })

    console.log(`[scalpy.engine] Order result: ${JSON.stringify(orderResult)}`)

    const dryRun = process.env.SCALPY_DRY_RUN !== 'false'
    const trade = await saveTrade({
      geniusId:         state.geniusId,
      betfairEventId:   state.betfairEventId,
      betfairMarketId:  ouMarket.marketId,
      selectionId,
      homeTeam:         state.homeTeam,
      awayTeam:         state.awayTeam,
      totalGoals:       state.totalGoals,
      addedMinutes,
      marketType:       ouMarket.marketType,
      selection:        decision.selection,
      side:             decision.action,
      requestedPrice:   decision.price,
      matchedPrice:     orderResult.averagePrice,
      stake:            decision.stake,
      reason:           decision.reason,
      dryRun,
      betId:            orderResult.betId,
    })

    broadcast({
      type: 'bet_placed',
      geniusId,
      data: {
        tradeId:     trade.id,
        side:        decision.action,
        selection:   decision.selection,
        price:       decision.price,
        stake:       decision.stake,
        marketType:  ouMarket.marketType,
        addedMinutes,
        dryRun,
      },
    })

  } catch (err) {
    console.error(`[scalpy.engine] Error during handleStoppageTime:`, err.message)
    broadcast({ type: 'error', geniusId, data: { message: err.message } })
  }
}
