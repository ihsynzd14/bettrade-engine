/**
 * In-memory match state per fixture (keyed by geniusId).
 */

/** @type {Map<string, MatchState>} */
const states = new Map()

/**
 * @typedef {Object} MatchState
 * @property {string}  geniusId
 * @property {string}  homeTeam
 * @property {string}  awayTeam
 * @property {string}  betfairEventId
 * @property {string}  betfairMarketId
 * @property {number}  totalGoals
 * @property {number}  homeGoals
 * @property {number}  awayGoals
 * @property {string|null} phase
 * @property {string|null} currentMinute  - Display minute, e.g. "75", "90+3", "HT", "FT"
 * @property {boolean} bettingDone
 * @property {string|null} lastSeenTs
 */

export function initState(fixture) {
  if (states.has(fixture.geniusId)) return
  states.set(fixture.geniusId, {
    geniusId:           fixture.geniusId,
    homeTeam:           fixture.homeTeam,
    awayTeam:           fixture.awayTeam,
    betfairEventId:     fixture.betfairEventId,
    betfairMarketId:    fixture.betfairMarketId,
    similarityScore:    fixture.similarityScore ?? null,
    totalGoals:         0,
    homeGoals:          0,
    awayGoals:          0,
    phase:              null,
    currentMinute:      null,
    bettingDone:        false,
    betPlaced:          false,
    tradeId:            null,
    lastSeenTs:         null,
    lastEventReceivedAt: null,
  })
  console.log(`[match-state] Initialised state for ${fixture.homeTeam} v ${fixture.awayTeam} (geniusId=${fixture.geniusId})`)
}

export function getState(geniusId) {
  return states.get(geniusId) ?? null
}

export function getAllStates() {
  return Array.from(states.values())
}

export function hasState(geniusId) {
  return states.has(geniusId)
}

/**
 * Record a goal event, attributing it to the correct team (own-goals flip credit).
 * Called at most once per goal event id (engine dedupes via seenEventKeys).
 *
 * @param {string} geniusId
 * @param {{ team?: 'Home'|'Away', isOwnGoal?: boolean }} event
 */
export function recordGoal(geniusId, event) {
  const s = states.get(geniusId)
  if (!s) return
  // Own-goal credit goes to the opposing team
  const scoring = event.isOwnGoal
    ? (event.team === 'Home' ? 'Away' : 'Home')
    : event.team
  if (scoring === 'Home')      s.homeGoals += 1
  else if (scoring === 'Away') s.awayGoals += 1
  s.totalGoals = s.homeGoals + s.awayGoals
  console.log(`[match-state] Goal! geniusId=${geniusId} ${s.homeGoals}-${s.awayGoals} (${scoring}${event.isOwnGoal ? ' OG' : ''})`)
}

export function setPhase(geniusId, phase) {
  const s = states.get(geniusId)
  if (!s) return
  s.phase = phase
  // Reflect the new phase on the displayed minute immediately (HT, FT, "46", etc.)
  const minute = formatMinute(phase, 0)
  if (minute != null) s.currentMinute = minute
  console.log(`[match-state] Phase change: geniusId=${geniusId} phase=${phase}`)
}

/**
 * Update the displayed minute based on the latest timed event (any type that carries
 * phase + timeElapsed). Stoppage announcements bump the displayed minute to "90+N".
 *
 * @param {string} geniusId
 * @param {string} phase
 * @param {string|undefined} timeElapsed  - "HH:MM:SS" in current phase
 */
export function setClock(geniusId, phase, timeElapsed) {
  const s = states.get(geniusId)
  if (!s || !phase) return
  const elapsedMin = parseElapsedMinutes(timeElapsed)
  const minute = formatMinute(phase, elapsedMin)
  if (minute != null) s.currentMinute = minute
}

function parseElapsedMinutes(timeElapsed) {
  if (!timeElapsed || typeof timeElapsed !== 'string') return null
  const m = timeElapsed.match(/^(\d+):(\d+):(\d+)/)
  if (!m) return null
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10)
}

function formatMinute(phase, elapsedMin) {
  switch (phase) {
    case 'PreMatch':   return null
    case 'FirstHalf':  return elapsedMin == null ? null : String(Math.min(elapsedMin + 1, 45))
    case 'HalfTime':   return 'HT'
    case 'SecondHalf': return elapsedMin == null ? null : String(Math.min(45 + elapsedMin + 1, 90))
    case 'ExtraTimeFirstHalf':  return elapsedMin == null ? null : String(90 + elapsedMin + 1)
    case 'ExtraTimeHalfTime':   return 'ET HT'
    case 'ExtraTimeSecondHalf': return elapsedMin == null ? null : String(105 + elapsedMin + 1)
    case 'Penalties':  return 'PEN'
    case 'PostMatch':
    case 'FullTime':   return 'FT'
    default:           return null
  }
}

export function setBettingDone(geniusId) {
  const s = states.get(geniusId)
  if (!s) return
  s.bettingDone = true
}

/** Mark that a bet was actually placed for this fixture (feeds the Scalpy tab + card badge). */
export function setBetPlaced(geniusId, tradeId) {
  const s = states.get(geniusId)
  if (!s) return
  s.bettingDone = true
  s.betPlaced = true
  s.tradeId = tradeId ?? s.tradeId
}

/** Wall-clock stamp of the last poll that actually returned events (for the feed-freshness brake). */
export function markEventReceived(geniusId) {
  const s = states.get(geniusId)
  if (!s) return
  s.lastEventReceivedAt = Date.now()
}

export function setLastSeenTs(geniusId, ts) {
  const s = states.get(geniusId)
  if (!s) return
  s.lastSeenTs = ts
}

export function clearState(geniusId) {
  states.delete(geniusId)
}
