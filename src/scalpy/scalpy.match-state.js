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
 * @property {string|null} phase
 * @property {boolean} bettingDone
 * @property {string|null} lastSeenTs
 */

export function initState(fixture) {
  if (states.has(fixture.geniusId)) return
  states.set(fixture.geniusId, {
    geniusId:        fixture.geniusId,
    homeTeam:        fixture.homeTeam,
    awayTeam:        fixture.awayTeam,
    betfairEventId:  fixture.betfairEventId,
    betfairMarketId: fixture.betfairMarketId,
    totalGoals:      0,
    phase:           null,
    bettingDone:     false,
    lastSeenTs:      null,
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

export function incrementGoals(geniusId) {
  const s = states.get(geniusId)
  if (!s) return
  s.totalGoals += 1
  console.log(`[match-state] Goal! geniusId=${geniusId} totalGoals=${s.totalGoals}`)
}

export function setPhase(geniusId, phase) {
  const s = states.get(geniusId)
  if (!s) return
  s.phase = phase
  console.log(`[match-state] Phase change: geniusId=${geniusId} phase=${phase}`)
}

export function setBettingDone(geniusId) {
  const s = states.get(geniusId)
  if (!s) return
  s.bettingDone = true
}

export function setLastSeenTs(geniusId, ts) {
  const s = states.get(geniusId)
  if (!s) return
  s.lastSeenTs = ts
}

export function clearState(geniusId) {
  states.delete(geniusId)
}
