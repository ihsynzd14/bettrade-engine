/**
 * Bet-decision trail (PLACED / MATCHED / PARTIAL_MATCH / UNMATCHED / SETTLED / SKIPPED / BLOCKED /
 * DEFERRED / ANNOUNCE / ENGINE / ERROR), surfaced to the admin panel via GET /api/scalpy/log.
 *
 * Two layers: an in-memory ring buffer (fast, serves the API) AND an append-only JSONL file
 * (`scalpy-decisions.log` in the engine root). The file exists because the engine restarts on every
 * deploy and the in-memory buffer dies with it — post-mortems kept hitting "the log was wiped".
 * File writes are fire-and-forget: a disk error must never break the betting loop.
 */
import { appendFile } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const LOG_FILE = resolve(__dirname, '../../scalpy-decisions.log')

const MAX = 300
const buffer = []

/**
 * @param {{ geniusId?: string, match?: string,
 *            action: 'PLACED'|'MATCHED'|'PARTIAL_MATCH'|'UNMATCHED'|'SETTLED'
 *                   |'SKIPPED'|'BLOCKED'|'DEFERRED'|'ANNOUNCE'|'ENGINE'|'ERROR',
 *            reason?: string, brake?: string, detail?: string, price?: number, stake?: number,
 *            marketType?: string, matchedSize?: number, matchedPrice?: number, betStatus?: string }} entry
 */
export function logDecision(entry) {
  const row = { ts: new Date().toISOString(), ...entry }
  buffer.push(row)
  if (buffer.length > MAX) buffer.shift()
  appendFile(LOG_FILE, JSON.stringify(row) + '\n', () => {}) // durable trail — survives restarts
}

export function getDecisions(limit = 50) {
  const n = Math.max(1, Math.min(limit, MAX))
  return buffer.slice(-n).reverse()
}
