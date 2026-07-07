import axios from 'axios'
import {
  initState, getState, getAllStates, clearState,
  recordGoal, setScore, setPhase, setClock, setBettingDone, setBetPlaced, setLastSeenTs, markEventReceived,
  setEstimatedStoppage, pushEstimatorEvent, recordRedCard, maxRedCards, setRisk, isAnyRiskActive, activeRiskNames,
  setPendingBet, getPendingBet, clearPendingBet, setWatching, officialClock, officialClockFromSec,
  recordBustGoal, startStoppageLog, pushStoppageLog,
} from './scalpy.match-state.js'
import { toMatchEvent, estimateFromMatchEvents } from './scalpy.stoppage-estimator.js'
import { goalCountToMarketType, getOuMarket, forgetOuMarket } from '../services/betfair-ou-market.service.js'
import { placeOrder } from '../services/betfair-orders.service.js'
import { decide, loadConfig, getConfig } from './scalpy.algorithm.js'
import { addTicks, clampPrice } from './scalpy.ticks.js'
import { upsertMatchState, claimTrade, promoteToPending, failClaim, getOpenBetGeniusIds, setBustGoals, setStoppageLog, getRecentFirstHalfEnds } from '../repositories/trade.repository.js'
import { broadcast } from './scalpy.sse.js'
import { getOverlap, onOverlapSync } from '../services/overlap.service.js'
import { settleFixture } from './scalpy.settlement.js'
import { canPlaceBet } from './scalpy.brakes.js'
import { isKilled, kill, istanbulDay } from '../lib/control.js'
import { logDecision } from './scalpy.decisions.js'
import { DRY_RUN } from '../lib/env.js'

const FEED_POLL_MS = parseInt(process.env.SCALPY_FEED_POLL_MS ?? '3000', 10)
const GENIUS_URL   = process.env.GENIUS_BACKEND_URL ?? 'http://localhost:3003'

// If a poll 404s ("Feed not found" — backend restarted / Ably dropped the subscription), re-subscribe,
// but no more than once per this window so we don't POST /feed/start every cycle while it comes back.
const FEED_RESUBSCRIBE_THROTTLE_MS = parseInt(process.env.SCALPY_FEED_RESUBSCRIBE_MS ?? '10000', 10)

// Each poll re-requests a small window before lastSeenTs so an event that shares a
// timestamp with an already-seen event isn't skipped by the server's strict `>` filter.
const POLL_LOOKBACK_MS = 5000

/** Set of geniusIds currently being polled */
const polledFixtures = new Set()

/** geniusId -> Set of processed `${type}:${id}` keys (cross-poll de-dupe) */
const seenEventKeys = new Map()

/** geniusId -> self-scheduling feed-poll timeout id */
const feedTimers = new Map()

/** geniusId -> last time we (re)subscribed its feed (throttles the on-404 re-subscribe) */
const lastFeedStartAt = new Map()

/** geniusId -> Set of one-shot friendly-strategy log notes already emitted (keeps the decision log
 *  readable: log each distinct "why we didn't bet" reason at most once per fixture, not every poll). */
const friendlyNotes = new Map()
function friendlyNoteOnce(geniusId, key) {
  let s = friendlyNotes.get(geniusId)
  if (!s) { s = new Set(); friendlyNotes.set(geniusId, s) }
  if (s.has(key)) return false
  s.add(key)
  return true
}

/** `${geniusId}:${minute}` -> earliest ts we may re-attempt a friendly mark that was blocked by a
 *  TRANSIENT gate (Betfair market suspended / no book / stale feed / score just changed). Betfair
 *  suspends the U/O market during the very attacks we bet right after, so a clear-of-risk attempt can
 *  still hit a suspended market — we hold and retry (throttled) instead of burning the mark. Bounded by 90:00. */
const friendlyRetryAt = new Map()
const FRIENDLY_RETRY_MS = 8000

/** Fixtures Genius provides NO live stream for (feed/start 404s upstream — the "no minute on the card"
 *  matches). Detected via strikes in startFeedForFixture; once flagged we stop polling/re-subscribing so
 *  the log isn't a wall of "Failed to start feed ... 500" every 10s. Per-run: a restart retries once. */
const noStreamFixtures = new Set()
const feedStartFails = new Map()   // geniusId -> consecutive feed/start failures
const NO_STREAM_STRIKES = 3

/** geniusId -> last time a poll error was written to the decision log (1/min throttle per fixture) */
const lastPollErrAt = new Map()

/** geniusId -> consecutive syncs the fixture has NOT been live (used to detect match end) */
const notLiveCount = new Map()

/** Per-fixture mutexes (single-threaded JS: claim/release with no await between check+set) */
const pollInFlight = new Set()
const placing      = new Set()
const finalizing   = new Set()

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

/** geniusId -> persisted 1st-half end clock (sec), loaded once at boot. Seeds a re-picked-up fixture's
 *  state so a mid-match restart keeps the friendly strategy's pricing input instead of silently
 *  skipping the match ("1st half not observed"). firstHalfEndSec is otherwise in-memory only. */
const rehydratedFirstHalfEnds = new Map()
const FIRSTHALF_REHYDRATE_WINDOW_MS = 6 * 60 * 60 * 1000 // only restore clocks from matches touched in the last 6h

// A tracked match that leaves the live set for this many consecutive syncs is treated as finished.
const FINALIZE_AFTER_SYNCS = 2

// Risk-defer tuning (wall-clock so a deferred bet always ages out regardless of poll cadence/watch)
const RISK_TTL_MS    = parseInt(process.env.SCALPY_RISK_TTL_MS ?? '60000', 10)
const MAX_PENDING_MS = parseInt(process.env.SCALPY_MAX_PENDING_MS ?? '600000', 10) // ~10 min
const FEED_DEAD_MS   = parseInt(process.env.SCALPY_FEED_DEAD_MS ?? '30000', 10)

/** geniusIds finalized this Istanbul day — refuse to re-track (flapping inplay-flag guard) */
const finalizedToday = new Set()
let finalizedDay = istanbulDay()
function rolloverFinalized() {
  const d = istanbulDay()
  if (d !== finalizedDay) { finalizedToday.clear(); finalizedDay = d }
}

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

  // Rehydrate 1st-half clocks so a mid-match restart doesn't silently disable the friendly strategy.
  // Best-effort: any failure just means those fixtures fall back to the safe "1st half not observed"
  // skip (now logged) — never a betting risk — so this must not block or kill startup.
  try {
    const sinceIso = new Date(Date.now() - FIRSTHALF_REHYDRATE_WINDOW_MS).toISOString()
    const map = await getRecentFirstHalfEnds(sinceIso)
    for (const [gid, sec] of Object.entries(map)) rehydratedFirstHalfEnds.set(gid, sec)
    if (rehydratedFirstHalfEnds.size) console.log(`[scalpy.engine] Rehydrated ${rehydratedFirstHalfEnds.size} first-half clock(s) (friendly restart-safety)`)
  } catch (err) {
    console.error('[scalpy.engine] first-half rehydrate failed:', err.message)
  }

  console.log(`[scalpy.engine] Engine started (DRY_RUN=${DRY_RUN})`)
  // Boot marker in the decision trail: makes restarts visible in /log and the durable file, so
  // "why is the log short / why did a pending bet vanish" is answerable (each restart wipes memory).
  logDecision({ action: 'ENGINE', reason: 'started', detail: `DRY_RUN=${DRY_RUN}` })

  // Re-check live fixtures immediately after every overlap refresh (incl. the first), so
  // newly-live matches are picked up as soon as the data is fresh — no fixed-interval lag.
  onOverlapSync(syncLiveFixtures)
}

export function stopEngine() {
  for (const t of feedTimers.values()) clearTimeout(t)
  feedTimers.clear()
  polledFixtures.clear()
  seenEventKeys.clear()
  friendlyNotes.clear()
  friendlyRetryAt.clear()
  noStreamFixtures.clear()
  feedStartFails.clear()
  lastPollErrAt.clear()
  notLiveCount.clear()
  lastFeedStartAt.clear()
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
  rolloverFinalized() // clear the finalized-fixtures guard at the Istanbul day boundary
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
    // A match finalized today must not be re-tracked if its inplay flag flaps back on.
    if (finalizedToday.has(geniusId)) continue
    // Genius offers no stream for it (flagged by startFeedForFixture) — untrackable, don't re-pick-up.
    if (noStreamFixtures.has(geniusId)) continue
    // Seed the 1st-half clock from persistence if we're re-picking this fixture up after a restart
    // (initState ignores the seed for an already-tracked fixture, so a live-observed value wins).
    const seed = rehydratedFirstHalfEnds.has(geniusId)
      ? { firstHalfEndSec: rehydratedFirstHalfEnds.get(geniusId) }
      : {}
    initState(fixture, seed)
    rehydratedFirstHalfEnds.delete(geniusId) // one-shot: from now on the live value re-persists
    notLiveCount.delete(geniusId) // still live → reset the end-of-match counter

    // Restart-safety: a fixture that already has an open bet must not be bet again.
    if (rehydratedBetFixtures.has(geniusId)) setBettingDone(geniusId)

    if (!polledFixtures.has(geniusId)) {
      polledFixtures.add(geniusId)
      // Manual-arm mode: a newly-appeared match starts DISARMED (no betting) until the operator
      // explicitly arms it with the eye button. Lets us validate one match before opening the rest.
      if (getConfig().manualArm) {
        setWatching(geniusId, false)
        broadcast({ type: 'watch_toggled', geniusId, data: { watching: false } })
      }
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
  if (finalizing.has(geniusId)) return
  finalizing.add(geniusId)
  try {
    // Stop polling + clean up per-fixture state.
    const t = feedTimers.get(geniusId)
    if (t) clearTimeout(t)
    feedTimers.delete(geniusId)
    polledFixtures.delete(geniusId)
    notLiveCount.delete(geniusId)
    seenEventKeys.delete(geniusId)
    friendlyNotes.delete(geniusId)
    for (const k of friendlyRetryAt.keys()) if (k.startsWith(`${geniusId}:`)) friendlyRetryAt.delete(k)
    lastFeedStartAt.delete(geniusId)
    feedStartFails.delete(geniusId)
    lastPollErrAt.delete(geniusId)
    clearPendingBet(geniusId)

    const state = getState(geniusId)
    if (!state) return // already cleared
    if (state.betfairEventId) forgetOuMarket(state.betfairEventId) // evict price cache

    if (!finalizedToday.has(geniusId)) {
      setPhase(geniusId, 'FullTime')
      broadcast({ type: 'phase_change', geniusId, data: { phase: 'FullTime' } })
      broadcast({ type: 'full_time', geniusId })
      console.log(`[scalpy.engine] Finalizing ${geniusId} (FullTime), settling with totalGoals=${state.totalGoals}`)
      try {
        await settleFixture(geniusId, state.totalGoals)
      } catch (err) {
        console.error(`[scalpy.engine] settle-on-finalize failed for ${geniusId}:`, err.message)
      }
      finalizedToday.add(geniusId)
    }

    // Persist the full post-90' timeline to the placed bet (survives the feed buffer being wiped).
    if (state.tradeId && state.stoppageLog.length) {
      setStoppageLog(state.tradeId, state.stoppageLog.join('\n')).catch(() => {})
    }
    persistState(geniusId) // persist final state before removing it from memory
    clearState(geniusId)   // remove from Live Fixtures — the match is over
    broadcast({ type: 'match_states', data: getAllStates() })
  } finally {
    finalizing.delete(geniusId)
  }
}

async function startFeedForFixture(geniusId) {
  if (noStreamFixtures.has(geniusId)) return
  lastFeedStartAt.set(geniusId, Date.now()) // stamp BEFORE the await so the 404 path throttles correctly
  try {
    await axios.post(`${GENIUS_URL}/api/feed/start/${geniusId}`)
    feedStartFails.delete(geniusId)
    console.log(`[scalpy.engine] Feed started for geniusId=${geniusId}`)
  } catch (err) {
    const status = err.response?.status
    const inner = err.response?.data?.error ?? err.message
    const fails = (feedStartFails.get(geniusId) ?? 0) + 1
    feedStartFails.set(geniusId, fails)
    console.error(`[scalpy.engine] Failed to start feed for ${geniusId} (attempt ${fails}):`, inner)
    // Genius has no live stream for this fixture (upstream 404 — today the backend wraps it in a 500,
    // after the backend fix it arrives as a plain 404). These are the "no minute on the card" matches:
    // no data will EVER arrive, so betting is impossible. Stop polling instead of retrying forever.
    if (status === 404 || fails >= NO_STREAM_STRIKES) {
      noStreamFixtures.add(geniusId)
      const state = getState(geniusId)
      logDecision({ geniusId, match: state ? `${state.homeTeam} v ${state.awayTeam}` : String(geniusId),
        action: 'SKIPPED', reason: 'no_stream',
        detail: `Genius has no live feed (feed/start ${status ?? '?'}: ${inner}) — fixture untrackable, polling stopped` })
      stopPollingFixture(geniusId)
    }
  }
}

/** Stop polling a fixture and drop it from the live list (no feed will ever arrive → nothing to bet). */
function stopPollingFixture(geniusId) {
  const t = feedTimers.get(geniusId)
  if (t) clearTimeout(t)
  feedTimers.delete(geniusId)
  polledFixtures.delete(geniusId)
  clearState(geniusId)
  broadcast({ type: 'match_states', data: getAllStates() })
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
    await tryPendingBet(geniusId)      // re-check deferred stoppage bets (risk may have cleared / expired)
    await handleFriendlyTicks(geniusId) // friendly strategy: fire 87/88/89 bets when due
  } catch (err) {
    console.error(`[scalpy.engine] runPoll error for ${geniusId}:`, err.message)
    // Surface real processing errors in the decision trail too (console dies with the terminal;
    // /log + the durable file don't). Throttled to 1/min per fixture so a crash-loop can't spam.
    const last = lastPollErrAt.get(geniusId) ?? 0
    if (Date.now() - last > 60_000) {
      lastPollErrAt.set(geniusId, Date.now())
      const state = getState(geniusId)
      logDecision({ geniusId, match: state ? `${state.homeTeam} v ${state.awayTeam}` : String(geniusId),
        action: 'ERROR', reason: 'poll_error', detail: err.message })
    }
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

    // Authoritative score from the backend (recomputed like the live UI: confirmed goals − VAR
    // cancellations). Applied EVERY poll — even when no new events fall in the `since` window —
    // because a disallowed/retracted goal may not emit a fresh-timestamped event. This replaces the
    // per-event counter so a goal that is scored then cancelled can't push us into the wrong market.
    const score = res.data?.score
    if (score && Number.isFinite(score.home) && Number.isFinite(score.away)) {
      if (setScore(geniusId, score.home, score.away)) {
        const s = getState(geniusId)
        broadcast({ type: 'goal', geniusId, data: { totalGoals: s.totalGoals, homeGoals: s.homeGoals, awayGoals: s.awayGoals } })
      }
    }

    if (events.length === 0) return

    markEventReceived(geniusId) // feed-freshness stamp for the safety gate

    for (const event of events) {
      await processEvent(geniusId, event)
    }

    const lastTs = events[events.length - 1]?.timestamp
    if (lastTs) setLastSeenTs(geniusId, lastTs)

    // Recompute the predicted stoppage totals (display only). Stored per-half in SECONDS so the
    // card shows the exact M:SS the live system shows, with first/second half broken out (1Y/2Y).
    if (state.phase === 'FirstHalf' || state.phase === 'SecondHalf') {
      const calc = estimateFromMatchEvents(state.estimatorEvents)
      setEstimatedStoppage(geniusId, { first: calc.firstHalf.total, second: calc.secondHalf.total })
    }

    persistState(geniusId)
  } catch (err) {
    if (err.response?.status === 404) {
      // "Feed not found" — the backend lost this subscription (restart / Ably drop). Re-subscribe so
      // polling self-heals; throttled so we don't hammer /feed/start (and flood the backend log) while
      // it comes back up. Only matches still in the live overlap reach here (ended ones get finalized).
      const last = lastFeedStartAt.get(geniusId) ?? 0
      if (Date.now() - last > FEED_RESUBSCRIBE_THROTTLE_MS) {
        console.log(`[scalpy.engine] Feed not found for ${geniusId} — re-subscribing`)
        await startFeedForFixture(geniusId)
      }
    } else {
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
  let key
  if (event.type === 'cornersV2' && event.id != null) {
    // The same corner id arrives twice (awarded → taken). Key on the taken state so the
    // "taken" update is NOT deduped away (else pendingCorner would get stuck true forever).
    key = `cornersV2:${event.id}:${event.taken?.isConfirmed ? 'taken' : 'awarded'}`
  } else if (event.id != null) {
    // Some records re-send the SAME id when their state transitions (VAR InReview→Clear, danger
    // state, penalty risk, a revised stoppage). Fold the changing field into the key so the later
    // "clear"/update isn't deduped away (else a risk flag would stick on → bet wrongly deferred).
    const sub = event.varState ?? event.riskState ?? event.dangerState ?? event.currentPhase
      ?? (event.type === 'stoppageTimeAnnouncements' ? event.addedMinutes : undefined)
    key = sub != null ? `${event.type}:${event.id}:${sub}` : `${event.type}:${event.id}`
  } else {
    key = `${event.type}:${event.timestamp ?? ''}`
  }
  if (keys.has(key)) return true
  keys.add(key)
  return false
}

const spaceCase = (s) => (typeof s === 'string' ? s.replace(/([a-z])([A-Z])/g, '$1 $2') : String(s))

/** One human-readable timeline line for a feed event: "91:23  Home Dangerous Attack". */
function timelineEntry(event) {
  const clock = officialClock(event.phase, event.timeElapsed)
  if (!clock) return null
  let label
  switch (event.type) {
    case 'goals':                     label = `⚽ GOAL${event.team ? ` (${event.team})` : ''}${event.isOwnGoal ? ' OG' : ''}`; break
    case 'dangerStateChanges':        label = spaceCase(event.dangerState); break
    case 'cornersV2':                 label = event.taken?.isConfirmed ? 'Corner taken' : 'Corner awarded'; break
    case 'varStateChanges':           label = `VAR: ${event.varState}${event.varReason && event.varReason !== 'NotSet' ? ` (${event.varReason})` : ''}`; break
    case 'penaltyRiskChanges':        label = `Penalty risk: ${event.riskState}`; break
    case 'straightRedCards':          label = `🟥 Red card${event.team ? ` (${event.team})` : ''}`; break
    case 'secondYellowCards':         label = `🟥 2nd yellow${event.team ? ` (${event.team})` : ''}`; break
    case 'yellowCards':               label = `🟨 Yellow${event.team ? ` (${event.team})` : ''}`; break
    case 'stoppageTimeAnnouncements': label = `⏱ +${event.addedMinutes} min announced`; break
    case 'substitutions':             label = `Substitution${event.team ? ` (${event.team})` : ''}`; break
    case 'throwIns':                  label = 'Throw-in'; break
    case 'fouls':                     label = 'Foul'; break
    case 'goalKicks':                 label = 'Goal kick'; break
    case 'kickOffs':                  label = 'Kick-off'; break
    case 'offsides':                  label = 'Offside'; break
    case 'shotsOnTarget':             label = 'Shot on target'; break
    case 'shotsOffTarget':            label = 'Shot off target'; break
    case 'blockedShots':              label = 'Blocked shot'; break
    case 'shotsOffWoodwork':          label = 'Woodwork'; break
    case 'phaseChanges':              label = `— ${event.currentPhase} —`; break
    default:                          label = event.type; break
  }
  return `${clock}  ${label}`
}

async function processEvent(geniusId, event) {
  const state = getState(geniusId)
  if (!state) return

  if (alreadyProcessed(geniusId, event)) return

  // Any event that carries phase + timeElapsed advances the displayed minute.
  if (event.phase && event.timeElapsed) setClock(geniusId, event.phase, event.timeElapsed)

  // Feed the stoppage-time estimator (subs / injuries / VAR / incidents / red cards).
  const me = toMatchEvent(event)
  if (me) pushEstimatorEvent(geniusId, me)

  // Post-90' replay (Ersen): start capturing at the 2nd-half stoppage announcement, then log EVERY
  // event until full time. Persisted to the placed bet at finalize so it survives the feed being wiped.
  if (event.type === 'stoppageTimeAnnouncements' && event.phase === 'SecondHalf') startStoppageLog(geniusId)
  if (state.stoppageLogging) {
    const line = timelineEntry(event)
    if (line) pushStoppageLog(geniusId, line)
  }

  switch (event.type) {
    case 'goals': {
      const s = getState(geniusId)
      // If a bet is already OPEN on this fixture, a goal now busts the Under — capture its official
      // clock time so the LOST row can show WHY we blew up (e.g. "92:15"). Independent of scoring.
      if (s && s.betPlaced && s.tradeId && event.phase && event.timeElapsed) {
        const clock = officialClock(event.phase, event.timeElapsed)
        if (clock) {
          // s.homeGoals/awayGoals already reflect this goal (score set at the top of the poll), so
          // record the time AND the resulting score, e.g. "92:15 (2-3)" — Ersen wants both.
          const entry = `${clock} (${s.homeGoals}-${s.awayGoals})`
          recordBustGoal(geniusId, entry)
          setBustGoals(s.tradeId, s.bustGoals.join(' · ')).catch(() => {})
          broadcast({ type: 'bust_goal', geniusId, data: { tradeId: s.tradeId, clock: entry } })
        }
      }
      // The score is now authoritative from the backend (see pollEvents — confirmed goals − VAR
      // cancellations, retraction-safe). Fall back to the legacy per-event counter ONLY until a
      // backend score has arrived (e.g. an old/un-redeployed backend that omits `score`).
      if (s && !s.usingBackendScore) {
        recordGoal(geniusId, event)
        broadcast({ type: 'goal', geniusId, data: {
          totalGoals: s.totalGoals, homeGoals: s.homeGoals, awayGoals: s.awayGoals,
        } })
      }
      break
    }

    case 'phaseChanges':
      if (event.currentPhase === 'FullTime' || event.currentPhase === 'PostMatch') {
        console.log(`[scalpy.engine] ${event.currentPhase} detected for geniusId=${geniusId}`)
        await finalizeFixture(geniusId)
      } else {
        setPhase(geniusId, event.currentPhase)
        broadcast({ type: 'phase_change', geniusId, data: { phase: event.currentPhase } })
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

    // --- Red cards: a confirmed straight red OR second yellow = a player sent off ---
    case 'straightRedCards':
    case 'secondYellowCards':
      if (event.isConfirmed && (event.team === 'Home' || event.team === 'Away')) {
        recordRedCard(geniusId, event.team)
      }
      break

    // --- Risk flags: defer betting while any of these is active ---
    case 'dangerStateChanges': {
      const ds = event.dangerState ?? ''
      setRisk(geniusId, 'dangerousAttack', /DangerousAttack/i.test(ds))
      // A corner also shows in the danger flow ('HomeCorner'/'AwayCorner'/'CornerDanger'). Treat it as
      // a pending-corner risk too — belt-and-braces with the cornersV2 signal (whose delivery the feed
      // can drop). Cleared by the cornersV2 'taken' event or the 60s risk TTL.
      if (/Corner/i.test(ds)) setRisk(geniusId, 'pendingCorner', true)
      break
    }

    case 'cornersV2':
      if (event.awarded?.isConfirmed && !event.taken?.isConfirmed) setRisk(geniusId, 'pendingCorner', true)
      else if (event.taken?.isConfirmed) setRisk(geniusId, 'pendingCorner', false)
      break

    case 'varStateChanges':
      // VAR is active while the feed reports 'Danger' (possible check) or 'InProgress' (review under
      // way); it clears on 'Safe' (complete). The old check looked for 'InReview', a value the feed
      // NEVER sends, so VAR never deferred a bet. Vocabulary confirmed from the live UI's
      // varStateMapping (Safe / InProgress / Danger). The 60s risk TTL still bounds any stuck flag.
      setRisk(geniusId, 'varInReview', event.varState === 'InProgress' || event.varState === 'Danger')
      break

    case 'penaltyRiskChanges': {
      const rs = event.riskState ?? ''
      const active = !!rs && !/clear|none|safe|^no/i.test(rs)
      setRisk(geniusId, 'penaltyRisk', active)
      break
    }

    default:
      break
  }
}

async function handleStoppageTime(geniusId, event) {
  const state = getState(geniusId)
  if (!state) return
  const match = `${state.homeTeam} v ${state.awayTeam}`

  // Durable trace of EVERY 2nd-half announcement, before any strategy filter can swallow it — so
  // "did the engine even see the announcement?" is always answerable from /log, even after a restart.
  if (event.phase === 'SecondHalf' && Number.isFinite(event.addedMinutes)) {
    logDecision({ geniusId, match, action: 'ANNOUNCE', reason: `${event.addedMinutes}min_announced`,
      detail: `2nd-half stoppage +${event.addedMinutes}′ announced` })
  }

  // Friendly matches use the friendly strategy (87/88/89) ONLY — skip the stoppage strategy for them.
  if (isFriendlyMatch(state, getConfig())) return

  if (event.phase !== 'SecondHalf') {
    console.log(`[scalpy.engine] Stoppage in ${event.phase} — skipping (not SecondHalf)`)
    return
  }
  if (!state.watching) {
    broadcast({ type: 'bet_skipped', geniusId, data: { reason: 'unwatched' } })
    logDecision({ geniusId, match, action: 'SKIPPED', reason: 'unwatched' })
    return
  }
  if (state.bettingDone) {
    console.log(`[scalpy.engine] bettingDone=true for geniusId=${geniusId} — skipping`)
    return
  }

  console.log(`[scalpy.engine] Stoppage detected! geniusId=${geniusId} addedMinutes=${event.addedMinutes} totalGoals=${state.totalGoals}`)

  // Risk-defer: hold the bet while Dangerous Attack / pending corner / VAR / penalty risk is
  // active; retry each poll until it clears. Do NOT setBettingDone — keep the slot open.
  if (isAnyRiskActive(geniusId, RISK_TTL_MS)) {
    const risks = activeRiskNames(geniusId, RISK_TTL_MS)
    setPendingBet(geniusId, { addedMinutes: event.addedMinutes, createdTs: Date.now(), attempts: 0 })
    console.log(`[scalpy.engine] Bet DEFERRED for ${match} — active risk: ${risks.join(',')}`)
    broadcast({ type: 'bet_deferred', geniusId, data: { addedMinutes: event.addedMinutes, risks } })
    logDecision({ geniusId, match, action: 'DEFERRED', reason: `risk:${risks.join(',')}`, detail: `${event.addedMinutes}′ announced — held until risk clears` })
    pushStoppageLog(geniusId, `${officialClock(event.phase, event.timeElapsed) ?? '?'}  ⏸ DEFERRED — risk: ${risks.join(',')} (${event.addedMinutes}′)`)
    return
  }

  setBettingDone(geniusId)
  clearPendingBet(geniusId) // committing now → don't let tryPendingBet re-fire a wasted claim
  await placeScalpyBet(geniusId, event.addedMinutes)
}

/**
 * Re-evaluate a deferred bet each poll: place once the risk clears; expire (wall-clock) if the 2nd
 * half ends, the cap elapses, or the feed goes dead. Expiries run independent of watch state so a
 * deferred bet can never get stuck; placement itself still honours manual unwatch.
 */
async function tryPendingBet(geniusId) {
  const state = getState(geniusId)
  if (!state) return
  const pending = getPendingBet(geniusId)
  if (!pending) return
  const match = `${state.homeTeam} v ${state.awayTeam}`
  const expire = (reason) => {
    clearPendingBet(geniusId)
    broadcast({ type: 'bet_skipped', geniusId, data: { reason } })
    logDecision({ geniusId, match, action: 'SKIPPED', reason })
  }

  // Wall-clock expiries FIRST (independent of watch state) — a deferred bet always ages out.
  if (state.phase !== 'SecondHalf') return expire('pending_expired_phase')
  if (Date.now() - pending.createdTs > MAX_PENDING_MS) return expire('pending_expired_cap')
  if (state.lastEventReceivedAt && Date.now() - state.lastEventReceivedAt > FEED_DEAD_MS) {
    return expire('pending_expired_feed_dead')
  }

  if (!state.watching) return                        // hold while unwatched (still ages out above)
  if (isAnyRiskActive(geniusId, RISK_TTL_MS)) return // still risky → keep waiting

  clearPendingBet(geniusId)
  setBettingDone(geniusId)
  await placeScalpyBet(geniusId, pending.addedMinutes, { deferred: true })
}

const SECOND_HALF_MINUTES = 45

/**
 * Minutes ACTUALLY LEFT in 2nd-half added time. The added time ends ~(45 + announced) minutes into
 * the half (phase-elapsed 45:00 = match 90:00). Risk-defer can eat into it, so we re-price off what
 * remains, NOT the announced total (Ersen's rule): "5 announced, risk clears at 91:00 → 4 left" →
 * bet the 4-minute rung. Ceil so the whole 91:xx minute reads "4". Falls back to the announced total
 * if the clock is unknown, and never returns more than the announced total.
 *
 * @returns {number} whole minutes remaining (0 = added time already elapsed → caller skips)
 */
export function minutesRemainingInStoppage(announcedMin, elapsedSec) {
  if (elapsedSec == null || !Number.isFinite(elapsedSec)) return announcedMin
  const endSec = (SECOND_HALF_MINUTES + announcedMin) * 60
  const remainingSec = Math.min(announcedMin * 60, Math.max(0, endSec - elapsedSec))
  return Math.ceil(remainingSec / 60)
}

/**
 * Shared placement core used by BOTH strategies: atomic gate + claim (under the global lock) →
 * kill re-check → order → promote → broadcast. One place for the safety logic. Returns the claim, or
 * null if blocked/skipped/already-claimed. Caller owns the per-fixture `placing` mutex.
 */
async function executePlacement(ctx) {
  const {
    geniusId, state, match, decision, ouMarket, selectionId,
    goalsAtDecision, currentMarketType, dedupeKey, strategy = 'stoppage', friendly = false,
    addedMinutes, firstHalfAdded = null, placedLog, placedDetail, extraBroadcast = {},
  } = ctx

  let claim = null
  await withPlacementLock(async () => {
    let gate
    try {
      gate = await canPlaceBet({ state, decision, ouMarket, goalsAtDecision, dryRun: DRY_RUN, cfg: getConfig(), currentMarketType, friendly })
    } catch (err) {
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
      dedupeKey, dryRun: DRY_RUN, strategy, firstHalfAdded,
      geniusId, betfairEventId: state.betfairEventId, betfairMarketId: ouMarket.marketId, selectionId,
      homeTeam: state.homeTeam, awayTeam: state.awayTeam,
      totalGoals: state.totalGoals, homeGoals: state.homeGoals, awayGoals: state.awayGoals, addedMinutes,
      marketType: ouMarket.marketType, selection: decision.selection, side: decision.action,
      requestedPrice: decision.price, stake: decision.stake, reason: decision.reason,
    })
    if (!claim) {
      broadcast({ type: 'bet_skipped', geniusId, data: { reason: 'already_claimed' } })
      logDecision({ geniusId, match, action: 'SKIPPED', reason: 'already_claimed' })
    }
  })
  if (!claim) return null

  // --- RE-CHECK KILL at the last synchronous instant before placing ---
  if (isKilled()) {
    await failClaim(claim.id, 'killed_post_claim')
    broadcast({ type: 'bet_blocked', geniusId, data: { reason: 'killed_post_claim', brake: 'kill_switch' } })
    logDecision({ geniusId, match, action: 'BLOCKED', reason: 'killed_post_claim', brake: 'kill_switch' })
    return null
  }

  let orderResult
  try {
    orderResult = await placeOrder({ marketId: ouMarket.marketId, selectionId, side: decision.action, price: decision.price, size: decision.stake, customerRef: dedupeKey })
  } catch (err) {
    await failClaim(claim.id, err.message)
    console.error(`[scalpy.engine] placeOrder failed for ${match}:`, err.message)
    broadcast({ type: 'error', geniusId, data: { message: `order_failed: ${err.message}` } })
    logDecision({ geniusId, match, action: 'BLOCKED', reason: 'order_failed', detail: err.message })
    return null
  }

  await promoteToPending(claim.id, { betId: orderResult.betId, matchedPrice: orderResult.averagePrice })
  setBetPlaced(geniusId, claim.id)
  if (placedLog) pushStoppageLog(geniusId, placedLog)
  persistState(geniusId)
  broadcast({ type: 'bet_placed', geniusId, data: {
    tradeId: claim.id, side: decision.action, selection: decision.selection,
    price: decision.price, stake: decision.stake, marketType: ouMarket.marketType,
    addedMinutes, strategy, dryRun: DRY_RUN, ...extraBroadcast,
  } })
  logDecision({ geniusId, match, action: 'PLACED', reason: decision.reason, detail: placedDetail, price: decision.price, stake: decision.stake, marketType: ouMarket.marketType })
  console.log(`[scalpy.engine] ✅ BET PLACED ${match}: ${decision.action} ${decision.selection} @ ${decision.price} £${decision.stake} (${ouMarket.marketType}) [${strategy}]`)
  return claim
}

// ── Club-friendly strategy (Ersen): 3 timed BACK-UNDER bets at 87/88/89, priced off a fixed rung +
//    1st-half-added ticks + goal-diff ticks. Only runs on friendly comps; the stoppage strategy is off. ──

/** True if this fixture is a club friendly (config `friendly.competitionMatch`, e.g. "friendl"). */
function isFriendlyMatch(state, cfg) {
  const f = cfg.friendly
  if (!f?.enabled) return false
  try { return new RegExp(f.competitionMatch ?? 'friendl', 'i').test(state.competition ?? '') }
  catch { return /friendl/i.test(state.competition ?? '') }
}

/** Map the 1st-half END clock (phase-elapsed seconds) to accepted added minutes (Ersen's buckets). */
function firstHalfAddedMinutes(firstHalfEndSec) {
  if (firstHalfEndSec == null) return null          // engine never saw the 1st half → unknown
  if (firstHalfEndSec < 45.5 * 60) return 0         // 44:30–45:30 (and anything shorter) → 0
  if (firstHalfEndSec < 46.5 * 60) return 1
  if (firstHalfEndSec < 47.5 * 60) return 2
  if (firstHalfEndSec < 48.5 * 60) return 3
  return 4                                          // 48:30+ → 4+ (caller skips the match)
}

/** Friendly target price: base rung + 1st-half ticks + (goalDiff≥5 → extra ticks), on the tick ladder. */
function friendlyPrice(cfg, minute, firstHalfAdded, goalDiff) {
  const f = cfg.friendly
  const base = f.rungs?.[String(minute)]
  if (base == null) return null
  const fhTicks = f.firstHalfTicks?.[String(firstHalfAdded)] ?? 0
  const gdTicks = goalDiff >= (f.goalDiffFrom ?? 5) ? (f.goalDiffTicks ?? 0) : 0
  const b = cfg.priceBounds ?? { min: 1.01, max: 2.0 }
  return { price: clampPrice(addTicks(base, fhTicks + gdTicks), b.min, b.max), base, fhTicks, gdTicks }
}

/**
 * Per-poll friendly driver: at each 87/88/89 mark (2nd half), place one BACK-UNDER bet. If a risk
 * (dangerous attack / corner / VAR / penalty) is active at the mark, HOLD the bet and retry every poll
 * until it clears — then place, re-priced by the minutes actually left to 90:00 (Ersen: "geçince al,
 * kalan dakikaya göre fiyatla"). A mark is only abandoned if 90:00 arrives before it can place. The loop
 * stops at the first unfilled mark, so marks fire in order and never overlap (no double bet).
 */
async function handleFriendlyTicks(geniusId) {
  const state = getState(geniusId)
  if (!state) return
  const cfg = getConfig()
  // These three are the normal "not applicable" gates — silent by design (would spam every poll for
  // every non-friendly / 1st-half / unwatched fixture). Everything AFTER this point is logged, so a
  // friendly that is genuinely in its 2nd-half betting window always leaves a trace.
  if (!isFriendlyMatch(state, cfg) || state.phase !== 'SecondHalf' || !state.watching) return
  const match = `${state.homeTeam} v ${state.awayTeam}`

  const fhAdded = firstHalfAddedMinutes(state.firstHalfEndSec)
  if (fhAdded == null) {                                             // couldn't measure 1st half → skip (safe)
    if (friendlyNoteOnce(geniusId, 'no_first_half')) {
      broadcast({ type: 'bet_skipped', geniusId, data: { reason: 'friendly_no_first_half' } })
      logDecision({ geniusId, match, action: 'SKIPPED', reason: 'friendly_no_first_half',
        detail: "1st-half end not observed (engine started/restarted after this match's 1st half) — can't price" })
    }
    return
  }
  if (fhAdded >= (cfg.friendly.skipFirstHalfAddedFrom ?? 4)) {       // 1st half 4+ added → skip whole match
    if (friendlyNoteOnce(geniusId, 'fh_added_skip')) {
      broadcast({ type: 'bet_skipped', geniusId, data: { reason: 'friendly_1h_added_high' } })
      logDecision({ geniusId, match, action: 'SKIPPED', reason: 'friendly_1h_added_high',
        detail: `1st-half added ${fhAdded} ≥ ${cfg.friendly.skipFirstHalfAddedFrom ?? 4} — match skipped per Ersen's rule` })
    }
    return
  }
  // One-shot "armed" trace so the strategy is visibly alive while it waits for 87/88/89′.
  if (friendlyNoteOnce(geniusId, 'armed')) {
    logDecision({ geniusId, match, action: 'DEFERRED', reason: 'friendly_armed',
      detail: `2nd half · 1H+${fhAdded} · watching for 87/88/89′ marks` })
  }

  // Betting window: 87:00 .. 90:00 (2nd-half phase-elapsed 2520 .. 2700). Marks fire in order; a mark is
  // HELD through active risk until it clears (bounded by 90:00), then placed & re-priced by minutes left.
  const windowEndSec = (90 - SECOND_HALF_MINUTES) * 60             // 2700 = 90:00 in 2nd-half elapsed
  if (state.elapsedSec == null) return
  for (const minute of Object.keys(cfg.friendly.rungs ?? {}).map(Number).sort((a, b) => a - b)) {
    if (state.friendlyDone.includes(minute)) continue
    const targetSec = (minute - SECOND_HALF_MINUTES) * 60           // 2nd-half elapsed for this match minute
    if (state.elapsedSec < targetSec) return                        // not reached → later marks aren't either
    if (state.elapsedSec >= windowEndSec) {                         // 90:00 arrived before this mark could place
      state.friendlyDone.push(minute)
      broadcast({ type: 'bet_skipped', geniusId, data: { reason: 'friendly_90_reached', addedMinutes: minute } })
      logDecision({ geniusId, match, action: 'SKIPPED', reason: `friendly_${minute}_90_reached`,
        detail: `90:00 reached before ${minute}′ could clear its risk` })
      continue
    }
    if (isAnyRiskActive(geniusId, RISK_TTL_MS)) {                   // HOLD through risk — retry every poll, no giveup
      const risks = activeRiskNames(geniusId, RISK_TTL_MS)
      if (friendlyNoteOnce(geniusId, `defer_${minute}`)) {
        broadcast({ type: 'bet_deferred', geniusId, data: { addedMinutes: minute, risks } })
        logDecision({ geniusId, match, action: 'DEFERRED', reason: `risk:${risks.join(',')}`,
          detail: `friendly ${minute}′ — held until risk clears (then re-priced by minutes left)` })
      }
      return
    }
    // Clear of risk → attempt to place (re-priced by minutes left in placeFriendlyBet). A TRANSIENT
    // block (Betfair market suspended / no book / stale feed) does NOT burn the mark — hold and retry
    // (throttled), bounded by 90:00. Only an actual placement (or terminal 90:00 skip) marks it done.
    const rk = `${geniusId}:${minute}`
    if (Date.now() < (friendlyRetryAt.get(rk) ?? 0)) return         // waiting out a recent blocked attempt
    const placed = await placeFriendlyBet(geniusId, minute, fhAdded)
    if (placed) { state.friendlyDone.push(minute); friendlyRetryAt.delete(rk) }
    else friendlyRetryAt.set(rk, Date.now() + FRIENDLY_RETRY_MS)    // blocked → short hold, then retry
    return                                                          // one placement attempt per poll
  }
}

/** Place one friendly BACK-UNDER bet. `triggerMinute` = the 87/88/89 mark that fired it (keys the
 *  dedupe, ≤3/match); the PRICE re-derives from whole minutes actually left to 90:00 at this instant,
 *  so a mark held through risk and placed a minute later prices to reality (Ersen: 87→3′, 88→2′, 89→1′). */
async function placeFriendlyBet(geniusId, triggerMinute, firstHalfAdded) {
  if (placing.has(geniusId)) return false
  placing.add(geniusId)
  try {
    const state = getState(geniusId)
    if (!state) return false
    const cfg = getConfig()
    const match = `${state.homeTeam} v ${state.awayTeam}`
    const goalsAtDecision = state.totalGoals
    const currentMarketType = goalCountToMarketType(state.totalGoals)

    // Re-price by whole minutes remaining to 90:00 (87:00→3, 88:00→2, 89:00→1). A mark held through
    // risk and placed later prices to what's actually left, not the mark it triggered at.
    const windowEndSec = (90 - SECOND_HALF_MINUTES) * 60
    const minutesLeft = Math.ceil((windowEndSec - (state.elapsedSec ?? windowEndSec)) / 60)
    if (minutesLeft < 1) {
      broadcast({ type: 'bet_skipped', geniusId, data: { reason: 'friendly_90_reached', addedMinutes: triggerMinute } })
      logDecision({ geniusId, match, action: 'SKIPPED', reason: `friendly_${triggerMinute}_90_reached`, detail: '90:00 reached at placement' })
      return true                                     // terminal — window closed, don't retry
    }
    const priceMinute = 90 - minutesLeft        // 3→87, 2→88, 1→89
    const slid = priceMinute !== triggerMinute

    const ouMarket = await getOuMarket(state.betfairEventId, currentMarketType)
    if (!ouMarket) {
      broadcast({ type: 'bet_skipped', geniusId, data: { reason: 'no_market_found', marketType: currentMarketType } })
      logDecision({ geniusId, match, action: 'SKIPPED', reason: `friendly_${triggerMinute}_no_market` })
      return false                                    // market may (re)appear — retry, bounded by 90:00
    }
    const goalDiff = Math.abs(state.homeGoals - state.awayGoals)
    const p = friendlyPrice(cfg, priceMinute, firstHalfAdded, goalDiff)
    if (!p) return false

    const tag = `${triggerMinute}′${slid ? `→${priceMinute}′` : ''}`
    const bits = [`friendly ${tag}(${p.base})`]
    if (p.fhTicks) bits.push(`+${p.fhTicks}t 1H+${firstHalfAdded}`)
    if (p.gdTicks) bits.push(`+${p.gdTicks}t diff≥5`)
    const decision = {
      action: cfg.side ?? 'BACK', selection: cfg.selection ?? 'UNDER',
      price: p.price, stake: cfg.friendly.stake ?? cfg.stake,
      reason: `${bits.join(' ')} → BACK UNDER @ ${p.price}`,
    }
    const selectionId = decision.selection === 'UNDER' ? ouMarket.underSelectionId : ouMarket.overSelectionId
    const dedupeKey = `scalpy:friendly:${geniusId}:${ouMarket.marketId}:${triggerMinute}` // trigger-keyed → ≤3/market
    const clock = officialClockFromSec(state.phase, state.elapsedSec) ?? `${priceMinute}:00`

    const claim = await executePlacement({
      geniusId, state, match, decision, ouMarket, selectionId,
      goalsAtDecision, currentMarketType, dedupeKey, strategy: 'friendly', friendly: true,
      addedMinutes: priceMinute, firstHalfAdded,
      placedLog: `${clock}  🎯 FRIENDLY BET @${p.price} ${ouMarket.marketType.replace('OVER_UNDER_', 'U/O ')} (${state.homeGoals}-${state.awayGoals}) [${tag}]`,
      placedDetail: `friendly ${tag} · 1H+${firstHalfAdded}${p.gdTicks ? ' · diff≥5' : ''}`,
      extraBroadcast: { firstHalfAdded },
    })
    return !!claim                                    // placed → mark done; blocked/failed → retry (bounded by 90:00)
  } catch (err) {
    console.error(`[scalpy.engine] placeFriendlyBet error for ${geniusId}:`, err.message)
    broadcast({ type: 'error', geniusId, data: { message: err.message } })
    return false
  } finally {
    placing.delete(geniusId)
  }
}

/**
 * The single bet-placement choke point: decide → brakes gate → claim-before-place → order.
 * Fully guarded by the `placing` mutex and the claim's unique dedupe_key.
 */
async function placeScalpyBet(geniusId, addedMinutes, { deferred = false } = {}) {
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

    // Re-price off minutes ACTUALLY LEFT (Ersen's rule). For an immediate bet this equals the announced
    // total; for a risk-deferred one it shrinks as the stoppage runs, so the ladder rung tracks reality.
    const effectiveMinutes = state.phase === 'SecondHalf'
      ? minutesRemainingInStoppage(addedMinutes, state.elapsedSec)
      : addedMinutes
    if (effectiveMinutes < 1) {
      broadcast({ type: 'bet_skipped', geniusId, data: { reason: 'stoppage_time_elapsed', announced: addedMinutes } })
      logDecision({ geniusId, match, action: 'SKIPPED', reason: 'stoppage_time_elapsed', detail: `announced ${addedMinutes}min, 0 left` })
      return
    }
    if (effectiveMinutes !== addedMinutes) {
      console.log(`[scalpy.engine] Re-priced ${match}: announced ${addedMinutes}min → ${effectiveMinutes}min left (elapsed ${state.elapsedSec}s)`)
    }

    const goalDiff = Math.abs(state.homeGoals - state.awayGoals)
    const decision = decide({ addedMinutes: effectiveMinutes, goalDiff, maxRedCards: maxRedCards(geniusId) })

    if (decision.action === 'SKIP') {
      broadcast({ type: 'bet_skipped', geniusId, data: { reason: decision.reason, addedMinutes: effectiveMinutes } })
      logDecision({ geniusId, match, action: 'SKIPPED', reason: decision.reason })
      return
    }

    const selectionId = decision.selection === 'UNDER' ? ouMarket.underSelectionId : ouMarket.overSelectionId
    const dedupeKey   = `scalpy:${geniusId}:${ouMarket.marketId}`
    const repriceNote = effectiveMinutes !== addedMinutes ? `${addedMinutes}′→${effectiveMinutes}′` : null

    await executePlacement({
      geniusId, state, match, decision, ouMarket, selectionId,
      goalsAtDecision, currentMarketType, dedupeKey, strategy: 'stoppage',
      addedMinutes: effectiveMinutes,
      placedLog: `${officialClockFromSec(state.phase, state.elapsedSec) ?? '?'}  🎯 BET PLACED @${decision.price} ${ouMarket.marketType.replace('OVER_UNDER_', 'U/O ')} (${state.homeGoals}-${state.awayGoals})${repriceNote ? ` [${repriceNote}]` : ''}`,
      placedDetail: deferred
        ? `risk cleared${repriceNote ? ` · re-priced ${repriceNote}` : ` · ${effectiveMinutes}′ (full)`}`
        : (repriceNote ? `re-priced ${repriceNote}` : undefined),
      extraBroadcast: { announcedMinutes: addedMinutes },
    })

  } catch (err) {
    console.error(`[scalpy.engine] placeScalpyBet error for ${geniusId}:`, err.message)
    broadcast({ type: 'error', geniusId, data: { message: err.message } })
  } finally {
    placing.delete(geniusId)
  }
}
