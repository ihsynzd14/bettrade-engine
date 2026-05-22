import axios from 'axios'
import {
  initState, getState, getAllStates,
  incrementGoals, setPhase, setBettingDone, setLastSeenTs
} from './scalpy.match-state.js'
import { goalCountToMarketType, getOuMarket } from '../services/betfair-ou-market.service.js'
import { placeOrder } from '../services/betfair-orders.service.js'
import { decide, loadConfig } from './scalpy.algorithm.js'
import { saveTrade } from '../repositories/trade.repository.js'
import { broadcast } from './scalpy.sse.js'
import { getOverlap } from '../services/overlap.service.js'
import { settleFixture } from './scalpy.settlement.js'

const FEED_POLL_MS = parseInt(process.env.SCALPY_FEED_POLL_MS ?? '3000', 10)
const GENIUS_URL   = process.env.GENIUS_BACKEND_URL ?? 'http://localhost:3003'

/** Set of geniusIds currently being polled */
const polledFixtures = new Set()

let pollIntervals = []

// ------------------------------------------------------------------
// Public API
// ------------------------------------------------------------------

export function startEngine() {
  loadConfig()
  console.log('[scalpy.engine] Engine started')

  // Every 30s: sync live fixtures from overlap store
  const syncInterval = setInterval(syncLiveFixtures, 30_000)
  syncLiveFixtures() // immediate first run

  pollIntervals.push(syncInterval)
}

export function stopEngine() {
  pollIntervals.forEach(clearInterval)
  pollIntervals = []
  polledFixtures.clear()
  console.log('[scalpy.engine] Engine stopped')
}

// ------------------------------------------------------------------
// Internal
// ------------------------------------------------------------------

async function syncLiveFixtures() {
  const { fixtures } = getOverlap()
  const liveFixtures = fixtures.filter(f =>
    f.status === 'IN_PLAY' || f.market?.inplay === true
  )

  for (const fixture of liveFixtures) {
    const { geniusId } = fixture
    initState(fixture)

    if (!polledFixtures.has(geniusId)) {
      polledFixtures.add(geniusId)
      await startFeedForFixture(geniusId)
      const interval = setInterval(() => pollEvents(geniusId), FEED_POLL_MS)
      pollIntervals.push(interval)
      console.log(`[scalpy.engine] Now polling fixture geniusId=${geniusId}`)
    }
  }

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
    const res = await axios.get(`${GENIUS_URL}/api/feed/${geniusId}/events`, {
      params: { since: state.lastSeenTs ?? undefined },
    })

    const events = res.data?.events ?? []
    if (events.length === 0) return

    for (const event of events) {
      await processEvent(geniusId, event)
    }

    // Update lastSeenTs to the timestamp of the most recent event processed
    const lastTs = events[events.length - 1]?.timestamp
    if (lastTs) setLastSeenTs(geniusId, lastTs)
  } catch (err) {
    if (err.response?.status !== 404) {
      console.error(`[scalpy.engine] Poll error for ${geniusId}:`, err.message)
    }
  }
}

async function processEvent(geniusId, event) {
  const state = getState(geniusId)
  if (!state) return

  switch (event.type) {
    case 'goals':
      incrementGoals(geniusId)
      broadcast({ type: 'goal', geniusId, data: { totalGoals: getState(geniusId).totalGoals } })
      break

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
