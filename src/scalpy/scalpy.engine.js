import axios from 'axios'
import {
  initState, getState, getAllStates,
  recordGoal, setPhase, setClock, setBettingDone, setBetPlaced, setLastSeenTs, markEventReceived
} from './scalpy.match-state.js'
import { goalCountToMarketType, getOuMarket } from '../services/betfair-ou-market.service.js'
import { placeOrder } from '../services/betfair-orders.service.js'
import { decide, loadConfig, getConfig } from './scalpy.algorithm.js'
import { upsertMatchState, claimTrade, promoteToPending, failClaim, getOpenBetGeniusIds } from '../repositories/trade.repository.js'
import { broadcast } from './scalpy.sse.js'
import { getOverlap, onOverlapSync } from '../services/overlap.service.js'
import { settleFixture } from './scalpy.settlement.js'
import { canPlaceBet } from './scalpy.brakes.js'
import { isKilled, kill } from '../lib/control.js'
import { logDecision } from './scalpy.decisions.js'
import { DRY_RUN } from '../lib/env.js'

const FEED_POLL_MS = parseInt(process.env.SCALPY_FEED_POLL_MS ?? '3000', 10)
const GENIUS_URL   = process.env.GENIUS_BACKEND_URL ?? 'http://localhost:3003'

// Each poll re-requests a small window before lastSeenTs so an event that shares a
// timestamp with an already-seen event isn't skipped by the server's strict `>` filter.
const POLL_LOOKBACK_MS = 5000

/** Set of geniusIds currently being polled */
const polledFixtures = new Set()

/** geniusId -> Set of processed `${type}:${id}` keys (cross-poll de-dupe) */
const seenEventKeys = new Map()

/** geniusId -> self-scheduling feed-poll timeout id */
const feedTimers = new Map()

/** geniusId -> consecutive syncs the fixture has NOT been live (used to detect match end) */
const notLiveCount = new Map()

/** Per-fixture mutexes (single-threaded JS: claim/release with no await between check+set) */
const pollInFlight = new Set()
const placing      = new Set()

// GLOBAL placement serialization: the per-fixture `placing` mutex does NOT bound TOTAL open
// liability (N fixtures hitting stoppage at once could each read the same pre-claim liability
// and all pass the cap). Serializing the gate+claim critical section across ALL fixtures makes
// the liability check and the claim atomic, so the total-open-liability bound truly holds.
let placementChain = Promise.resolve()
function withPlacementLock(fn) {
  const next = placementChain.then(fn, fn)
  placementChain = next.then(() => {}, () => {}) // never let a rejection break the chain
  return next
}

/** Fixtures that already had an OPEN bet at boot — never re-bet them after a restart */
const rehydratedBetFixtures = new Set()

// A tracked match that leaves the live set for this many consecutive syncs is treated as finished.
const FINALIZE_AFTER_SYNCS = 2

// ------------------------------------------------------------------
// Public API
// ------------------------------------------------------------------

export async function startEngine() {
  loadConfig()

  // Rehydrate: any fixture with an open (non-skipped) trade is already bet — never re-bet on restart.
  try {
    const ids = await getOpenBetGeniusIds()
    ids.forEach(id => rehydratedBetFixtures.add(id))
    if (ids.length) console.log(`[scalpy.engine] Rehydrated ${ids.length} fixtures with open bets (won't re-bet)`)
  } catch (err) {
    console.error('[scalpy.engine] rehydrate failed:', err.message)
    // Fail-closed in live: without the open-bet set we might re-bet a fixture after restart.
    if (!DRY_RUN) {
      await kill('rehydrate_failed_live', 'startup')
      console.error('[scalpy.engine] 🔴 rehydrate failed in LIVE — engine KILLED for safety')
    }
  }

  console.log(`[scalpy.engine] Engine started (DRY_RUN=${DRY_RUN})`)

  // Re-check live fixtures immediately after every overlap refresh (incl. the first), so
  // newly-live matches are picked up as soon as the data is fresh — no fixed-interval lag.
  onOverlapSync(syncLiveFixtures)
}

export function stopEngine() {
  for (const t of feedTimers.values()) clearTimeout(t)
  feedTimers.clear()
  polledFixtures.clear()
  seenEventKeys.clear()
  notLiveCount.clear()
  pollInFlight.clear()
  placing.clear()
  console.log('[scalpy.engine] Engine stopped')
}

// ------------------------------------------------------------------
// Internal
// ------------------------------------------------------------------

/** Persist a fixture's in-memory state to Supabase (fire-and-forget). */
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

    // Restart-safety: a fixture that already has an open bet must not be bet again.
    if (rehydratedBetFixtures.has(geniusId)) setBettingDone(geniusId)

    if (!polledFixtures.has(geniusId)) {
      polledFixtures.add(geniusId)
      await startFeedForFixture(geniusId)
      schedulePoll(geniusId)
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
 * A tracked match is no longer live. We can't rely on a FullTime feed event (the feed
 * unsubscribes at match end), so finalize directly: mark FullTime, settle with the last-known
 * score, stop polling, clean up.
 */
async function finalizeFixture(geniusId) {
  const t = feedTimers.get(geniusId)
  if (t) clearTimeout(t)
  feedTimers.delete(geniusId)
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

// --- self-scheduling poll (no overlapping requests; a slow feed call can't pile up) ---
function schedulePoll(geniusId) {
  if (!polledFixtures.has(geniusId)) return
  feedTimers.set(geniusId, setTimeout(runPoll, FEED_POLL_MS, geniusId))
}

async function runPoll(geniusId) {
  if (!polledFixtures.has(geniusId)) return
  if (pollInFlight.has(geniusId)) { schedulePoll(geniusId); return }
  pollInFlight.add(geniusId)
  try {
    await pollEvents(geniusId)
  } catch (err) {
    console.error(`[scalpy.engine] runPoll error for ${geniusId}:`, err.message)
  } finally {
    pollInFlight.delete(geniusId)
    schedulePoll(geniusId) // schedule the next run only if still polled
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

    markEventReceived(geniusId) // feed-freshness stamp for the safety gate

    for (const event of events) {
      await processEvent(geniusId, event)
    }

    const lastTs = events[events.length - 1]?.timestamp
    if (lastTs) setLastSeenTs(geniusId, lastTs)

    persistState(geniusId)
  } catch (err) {
    if (err.response?.status !== 404) {
      console.error(`[scalpy.engine] Poll error for ${geniusId}:`, err.message)
    }
  }
}

/** True if this event was already processed for the fixture (cross-poll de-dupe by id). */
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
        if (s) await settleFixture(geniusId, s.totalGoals)
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

  if (event.phase !== 'SecondHalf') {
    console.log(`[scalpy.engine] Stoppage in ${event.phase} — skipping (not SecondHalf)`)
    return
  }
  if (state.bettingDone) {
    console.log(`[scalpy.engine] bettingDone=true for geniusId=${geniusId} — skipping`)
    return
  }

  console.log(`[scalpy.engine] Stoppage detected! geniusId=${geniusId} addedMinutes=${event.addedMinutes} totalGoals=${state.totalGoals}`)
  setBettingDone(geniusId) // in-memory one-shot guard against re-delivered announcements

  await placeScalpyBet(geniusId, event.addedMinutes)
}

/**
 * The single bet-placement choke point: decide → brakes gate → claim-before-place → order.
 * Fully guarded by the `placing` mutex and the claim's unique dedupe_key.
 */
async function placeScalpyBet(geniusId, addedMinutes) {
  if (placing.has(geniusId)) return
  placing.add(geniusId)
  try {
    const state = getState(geniusId)
    if (!state) return
    const cfg = getConfig()
    const match = `${state.homeTeam} v ${state.awayTeam}`
    const goalsAtDecision = state.totalGoals
    const currentMarketType = goalCountToMarketType(state.totalGoals)

    const ouMarket = await getOuMarket(state.betfairEventId, currentMarketType)
    if (!ouMarket) {
      broadcast({ type: 'bet_skipped', geniusId, data: { reason: 'no_market_found', marketType: currentMarketType } })
      logDecision({ geniusId, match, action: 'SKIPPED', reason: 'no_market_found', marketType: currentMarketType })
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

    if (decision.action === 'SKIP') {
      broadcast({ type: 'bet_skipped', geniusId, data: { reason: decision.reason, addedMinutes } })
      logDecision({ geniusId, match, action: 'SKIPPED', reason: decision.reason })
      return
    }

    const selectionId = decision.selection === 'UNDER' ? ouMarket.underSelectionId : ouMarket.overSelectionId
    const dedupeKey   = `scalpy:${geniusId}:${ouMarket.marketId}`

    // --- ATOMIC GATE + CLAIM (global lock so the total-open-liability bound truly holds) ---
    let claim = null
    await withPlacementLock(async () => {
      let gate
      try {
        gate = await canPlaceBet({ state, decision, ouMarket, goalsAtDecision, dryRun: DRY_RUN, cfg, currentMarketType })
      } catch (err) {
        // Any error inside the gate fails CLOSED — never place on uncertain data.
        console.error(`[scalpy.engine] gate error for ${match}:`, err.message)
        broadcast({ type: 'bet_blocked', geniusId, data: { reason: 'gate_error', brake: 'gate_error', detail: err.message } })
        logDecision({ geniusId, match, action: 'BLOCKED', reason: 'gate_error', brake: 'gate_error', detail: err.message })
        return
      }
      if (!gate.allow) {
        console.warn(`[scalpy.engine] 🚫 BLOCKED ${match}: ${gate.reason} [${gate.brake}] ${gate.detail ?? ''}`)
        broadcast({ type: 'bet_blocked', geniusId, data: { reason: gate.reason, brake: gate.brake, detail: gate.detail } })
        logDecision({ geniusId, match, action: 'BLOCKED', reason: gate.reason, brake: gate.brake, detail: gate.detail })
        return
      }
      // Claim INSIDE the lock so its CLAIMED row counts toward the next bet's liability read.
      claim = await claimTrade({
        dedupeKey, dryRun: DRY_RUN,
        geniusId, betfairEventId: state.betfairEventId, betfairMarketId: ouMarket.marketId, selectionId,
        homeTeam: state.homeTeam, awayTeam: state.awayTeam, totalGoals: state.totalGoals, addedMinutes,
        marketType: ouMarket.marketType, selection: decision.selection, side: decision.action,
        requestedPrice: decision.price, stake: decision.stake, reason: decision.reason,
      })
      if (!claim) {
        broadcast({ type: 'bet_skipped', geniusId, data: { reason: 'already_claimed' } })
        logDecision({ geniusId, match, action: 'SKIPPED', reason: 'already_claimed' })
      }
    })
    if (!claim) return // blocked, gate-errored, or already claimed — nothing placed

    // --- RE-CHECK KILL at the last synchronous instant before placing ---
    if (isKilled()) {
      await failClaim(claim.id, 'killed_post_claim')
      broadcast({ type: 'bet_blocked', geniusId, data: { reason: 'killed_post_claim', brake: 'kill_switch' } })
      logDecision({ geniusId, match, action: 'BLOCKED', reason: 'killed_post_claim', brake: 'kill_switch' })
      return
    }

    let orderResult
    try {
      orderResult = await placeOrder({
        marketId: ouMarket.marketId, selectionId, side: decision.action,
        price: decision.price, size: decision.stake, customerRef: dedupeKey,
      })
    } catch (err) {
      await failClaim(claim.id, err.message)
      console.error(`[scalpy.engine] placeOrder failed for ${match}:`, err.message)
      broadcast({ type: 'error', geniusId, data: { message: `order_failed: ${err.message}` } })
      logDecision({ geniusId, match, action: 'BLOCKED', reason: 'order_failed', detail: err.message })
      return
    }

    await promoteToPending(claim.id, { betId: orderResult.betId, matchedPrice: orderResult.averagePrice })
    setBetPlaced(geniusId, claim.id)
    persistState(geniusId)

    broadcast({
      type: 'bet_placed', geniusId,
      data: {
        tradeId: claim.id, side: decision.action, selection: decision.selection,
        price: decision.price, stake: decision.stake, marketType: ouMarket.marketType,
        addedMinutes, dryRun: DRY_RUN,
      },
    })
    logDecision({ geniusId, match, action: 'PLACED', reason: decision.reason, price: decision.price, stake: decision.stake, marketType: ouMarket.marketType })
    console.log(`[scalpy.engine] ✅ BET PLACED ${match}: ${decision.action} ${decision.selection} @ ${decision.price} £${decision.stake} (${ouMarket.marketType})`)

  } catch (err) {
    console.error(`[scalpy.engine] placeScalpyBet error for ${geniusId}:`, err.message)
    broadcast({ type: 'error', geniusId, data: { message: err.message } })
  } finally {
    placing.delete(geniusId)
  }
}
