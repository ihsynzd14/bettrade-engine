/**
 * In-memory ring buffer of recent bet decisions (PLACED / SKIPPED / BLOCKED / DEFERRED),
 * surfaced to the admin panel via GET /api/scalpy/log. Kept in memory only (no table).
 */

const MAX = 300
const buffer = []

/**
 * @param {{ geniusId?: string, match?: string, action: 'PLACED'|'SKIPPED'|'BLOCKED'|'DEFERRED',
 *            reason?: string, brake?: string, detail?: string, price?: number, stake?: number,
 *            marketType?: string }} entry
 */
export function logDecision(entry) {
  buffer.push({ ts: new Date().toISOString(), ...entry })
  if (buffer.length > MAX) buffer.shift()
}

export function getDecisions(limit = 50) {
  const n = Math.max(1, Math.min(limit, MAX))
  return buffer.slice(-n).reverse()
}
