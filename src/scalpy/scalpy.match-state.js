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
    competition:        fixture.market?.competition ?? null,
    similarityScore:    fixture.similarityScore ?? null,
    totalGoals:         0,
    homeGoals:          0,
    awayGoals:          0,
    phase:              null,
    currentMinute:      null,
    estimatedStoppage:  null,
    estimatorEvents:    [],
    watching:           true,
    ouBook:             null,
    redCards:           { Home: 0, Away: 0 },
    risk:               { dangerousAttack: false, pendingCorner: false, varInReview: false, penaltyRisk: false },
    riskTs:             {},
    pendingBet:         null,
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

// ------------------------------------------------------------------
// Live Fixtures enrichment + watch toggle (Phase 4/5)
// ------------------------------------------------------------------

export function setWatching(geniusId, watching) {
  const s = states.get(geniusId)
  if (!s) return
  s.watching = !!watching
}

/** @param {Object|null} ouBook - { marketId, marketType, threshold, underSelectionId, bbp, blp, ltp, status } */
export function setOuBook(geniusId, ouBook) {
  const s = states.get(geniusId)
  if (!s) return
  s.ouBook = ouBook
}

/** @param {{first:number, second:number}|null} est - predicted added time per half (seconds; card shows 1Y/2Y M:SS) */
export function setEstimatedStoppage(geniusId, est) {
  const s = states.get(geniusId)
  if (!s) return
  s.estimatedStoppage = est
}

/** Append a mapped MatchEvent to the stoppage-estimator buffer (capped to bound memory). */
export function pushEstimatorEvent(geniusId, matchEvent) {
  const s = states.get(geniusId)
  if (!s || !matchEvent) return
  s.estimatorEvents.push(matchEvent)
  if (s.estimatorEvents.length > 12000) s.estimatorEvents.shift()
}

// ------------------------------------------------------------------
// Red cards + risk flags (Phase 6 betting rules)
// ------------------------------------------------------------------

/** @param {'Home'|'Away'} team */
export function recordRedCard(geniusId, team) {
  const s = states.get(geniusId)
  if (!s || (team !== 'Home' && team !== 'Away')) return
  s.redCards[team] += 1
  console.log(`[match-state] Red card: geniusId=${geniusId} ${team} → ${s.redCards.Home}-${s.redCards.Away}`)
}

/** Largest red-card count on a single team (= "down N players"). */
export function maxRedCards(geniusId) {
  const s = states.get(geniusId)
  if (!s) return 0
  return Math.max(s.redCards.Home, s.redCards.Away)
}

/** @param {'dangerousAttack'|'pendingCorner'|'varInReview'|'penaltyRisk'} flag */
export function setRisk(geniusId, flag, active) {
  const s = states.get(geniusId)
  if (!s || !(flag in s.risk)) return
  s.risk[flag] = !!active
  if (active) s.riskTs[flag] = Date.now()
}

/**
 * True if any risk flag is active. A flag whose last confirming event is older than `ttlMs`
 * is treated as stale (a missed "clear" transition) and ignored.
 */
export function isAnyRiskActive(geniusId, ttlMs = 60000) {
  const s = states.get(geniusId)
  if (!s) return false
  const now = Date.now()
  return Object.keys(s.risk).some(flag =>
    s.risk[flag] && (now - (s.riskTs[flag] ?? 0) < ttlMs)
  )
}

/** Names of the currently-active (non-stale) risk flags, for logging. */
export function activeRiskNames(geniusId, ttlMs = 60000) {
  const s = states.get(geniusId)
  if (!s) return []
  const now = Date.now()
  return Object.keys(s.risk).filter(flag => s.risk[flag] && (now - (s.riskTs[flag] ?? 0) < ttlMs))
}

// ------------------------------------------------------------------
// Pending bet (risk-defer) (Phase 6)
// ------------------------------------------------------------------

export function setPendingBet(geniusId, pending) {
  const s = states.get(geniusId)
  if (!s) return
  s.pendingBet = pending
}

export function getPendingBet(geniusId) {
  return states.get(geniusId)?.pendingBet ?? null
}

export function clearPendingBet(geniusId) {
  const s = states.get(geniusId)
  if (!s) return
  s.pendingBet = null
}

export function clearState(geniusId) {
  states.delete(geniusId)
}
