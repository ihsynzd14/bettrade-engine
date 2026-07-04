import { supabase } from '../lib/supabase.js'

/** UTC instant of the most recent Europe/Istanbul (UTC+3, no DST) midnight. */
export function startOfIstanbulDayUtc() {
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul' }).format(new Date())
  return new Date(`${day}T00:00:00+03:00`).toISOString()
}

/**
 * Save a new trade record. Returns the created row.
 */
export async function saveTrade(trade) {
  const { data, error } = await supabase
    .from('scalpy_trades')
    .insert({
      bet_id:            trade.betId ?? null,
      dry_run:           trade.dryRun,
      genius_id:         trade.geniusId,
      betfair_event_id:  trade.betfairEventId,
      betfair_market_id: trade.betfairMarketId,
      selection_id:      trade.selectionId,
      home_team:         trade.homeTeam,
      away_team:         trade.awayTeam,
      total_goals:       trade.totalGoals,
      home_goals:        trade.homeGoals ?? null,
      away_goals:        trade.awayGoals ?? null,
      added_minutes:     trade.addedMinutes,
      market_type:       trade.marketType,
      selection:         trade.selection,
      side:              trade.side,
      requested_price:   trade.requestedPrice,
      matched_price:     trade.matchedPrice ?? null,
      stake:             trade.stake,
      reason:            trade.reason ?? null,
      status:            'PENDING',
    })
    .select()
    .single()

  if (error) throw new Error(`[trade.repository] saveTrade failed: ${error.message}`)
  return data
}

/**
 * Settle a trade — IDEMPOTENT. Only transitions a not-yet-settled row.
 * @returns {Promise<boolean>} true iff THIS call performed the settlement (rowCount===1).
 *   false means it was already settled by another path → caller must NOT double-count P&L.
 */
export async function settleTrade(tradeId, outcome, pnl) {
  const { data, error } = await supabase
    .from('scalpy_trades')
    .update({
      outcome,
      pnl,
      status: 'SETTLED',
      settled_at: new Date().toISOString(),
    })
    .eq('id', tradeId)
    .neq('status', 'SETTLED')
    .select('id')

  if (error) throw new Error(`[trade.repository] settleTrade failed: ${error.message}`)
  return (data?.length ?? 0) === 1
}

const OPEN_STATUSES = ['CLAIMED', 'PENDING', 'MATCHED']

function liabilityFor(side, stake, price) {
  return side === 'LAY' ? stake * (price - 1) : stake
}

/**
 * Claim-before-place: insert a CLAIMED row keyed by a unique dedupe_key so that, even across
 * retries/restarts/concurrent polls, at most ONE bet exists per fixture-market. Returns the
 * row, or null on a unique-key collision (already claimed → caller must NOT place an order).
 */
export async function claimTrade(trade) {
  const { data, error } = await supabase
    .from('scalpy_trades')
    .insert({
      dedupe_key:        trade.dedupeKey,
      bet_id:            null,
      dry_run:           trade.dryRun,
      genius_id:         trade.geniusId,
      betfair_event_id:  trade.betfairEventId,
      betfair_market_id: trade.betfairMarketId,
      selection_id:      trade.selectionId,
      home_team:         trade.homeTeam,
      away_team:         trade.awayTeam,
      total_goals:       trade.totalGoals,
      home_goals:        trade.homeGoals ?? null,
      away_goals:        trade.awayGoals ?? null,
      added_minutes:     trade.addedMinutes,
      market_type:       trade.marketType,
      selection:         trade.selection,
      side:              trade.side,
      requested_price:   trade.requestedPrice,
      stake:             trade.stake,
      reason:            trade.reason ?? null,
      status:            'CLAIMED',
    })
    .select()
    .single()

  if (error) {
    if (error.code === '23505') return null // unique_violation → already claimed
    throw new Error(`[trade.repository] claimTrade failed: ${error.message}`)
  }
  return data
}

/**
 * Persist the running-clock time(s) of the goal(s) that busted this bet's Under (CSV, e.g. "92:15").
 * Overwrite-whole (the engine's in-memory list is the source of truth). Best-effort — a failure here
 * must never break the live loop, so it logs and swallows.
 */
export async function setBustGoals(tradeId, csv) {
  const { error } = await supabase
    .from('scalpy_trades')
    .update({ bust_goals: csv })
    .eq('id', tradeId)
  if (error) console.error('[trade.repository] setBustGoals failed:', error.message)
}

/** Persist the full post-90' timeline (newline-joined) to the trade. Best-effort — logs & swallows. */
export async function setStoppageLog(tradeId, text) {
  const { error } = await supabase
    .from('scalpy_trades')
    .update({ stoppage_log: text })
    .eq('id', tradeId)
  if (error) console.error('[trade.repository] setStoppageLog failed:', error.message)
}

/** Promote a CLAIMED row to PENDING once the order is placed. */
export async function promoteToPending(tradeId, { betId, matchedPrice } = {}) {
  const { error } = await supabase
    .from('scalpy_trades')
    .update({
      status: 'PENDING',
      ...(betId != null ? { bet_id: betId } : {}),
      ...(matchedPrice != null ? { matched_price: matchedPrice } : {}),
    })
    .eq('id', tradeId)
    .eq('status', 'CLAIMED')

  if (error) throw new Error(`[trade.repository] promoteToPending failed: ${error.message}`)
}

/** Mark a CLAIMED row FAILED (order placement errored) so it doesn't count as open exposure. */
export async function failClaim(tradeId, reason) {
  const { error } = await supabase
    .from('scalpy_trades')
    .update({ status: 'FAILED', reason: `claim_failed:${reason}` })
    .eq('id', tradeId)
    .eq('status', 'CLAIMED')
  if (error) console.error(`[trade.repository] failClaim error: ${error.message}`)
}

/** True if a live (non-skipped/non-failed) bet row already exists for this Betfair market. */
export async function getMarketHasOpenBet(betfairMarketId) {
  const { data, error } = await supabase
    .from('scalpy_trades')
    .select('id')
    .eq('betfair_market_id', betfairMarketId)
    .in('status', [...OPEN_STATUSES, 'SETTLED'])
    .limit(1)
  if (error) throw new Error(`[trade.repository] getMarketHasOpenBet failed: ${error.message}`)
  return (data?.length ?? 0) > 0
}

/** Total open liability across all not-yet-settled bets (BACK liability = stake). */
export async function getOpenLiability() {
  const { data, error } = await supabase
    .from('scalpy_trades')
    .select('stake, side, requested_price, status')
    .in('status', OPEN_STATUSES)
  if (error) throw new Error(`[trade.repository] getOpenLiability failed: ${error.message}`)
  let total = 0
  for (const t of data) total += liabilityFor(t.side, Number(t.stake), Number(t.requested_price))
  return { total: Math.round(total * 100) / 100, count: data.length }
}

/**
 * Authoritative sum of today's realized P&L from SETTLED rows (self-healing daily-loss bound —
 * no float drift, survives a missed counter write). Filtered by dry_run so live and dry P&L
 * never mix.
 * @param {string} sinceUtcISO - start of the local trading day, in UTC
 * @param {boolean} [dryRun]
 */
export async function getRealizedPnlToday(sinceUtcISO, dryRun) {
  let q = supabase
    .from('scalpy_trades')
    .select('pnl')
    .eq('status', 'SETTLED')
    .gte('settled_at', sinceUtcISO)
  if (dryRun !== undefined) q = q.eq('dry_run', dryRun)
  const { data, error } = await q
  if (error) throw new Error(`[trade.repository] getRealizedPnlToday failed: ${error.message}`)
  const total = data.reduce((s, t) => s + (Number(t.pnl) || 0), 0)
  return Math.round(total * 100) / 100
}

/** geniusIds that currently have an OPEN bet — used to rehydrate bettingDone after a restart. */
export async function getOpenBetGeniusIds() {
  const { data, error } = await supabase
    .from('scalpy_trades')
    .select('genius_id')
    .in('status', OPEN_STATUSES)
  if (error) throw new Error(`[trade.repository] getOpenBetGeniusIds failed: ${error.message}`)
  return [...new Set(data.map(r => r.genius_id))]
}

/**
 * Mark a trade as MATCHED (order fully executed on Betfair).
 * @param {string} tradeId
 * @param {number|null} matchedPrice - average matched price, if known
 */
export async function markTradeMatched(tradeId, matchedPrice) {
  const { error } = await supabase
    .from('scalpy_trades')
    .update({
      status: 'MATCHED',
      ...(matchedPrice != null ? { matched_price: matchedPrice } : {}),
    })
    .eq('id', tradeId)

  if (error) throw new Error(`[trade.repository] markTradeMatched failed: ${error.message}`)
}

/**
 * Get live (non-dry-run) trades that are not yet settled — i.e. still PENDING
 * or MATCHED. Used by the live settlement poller.
 */
export async function getOpenLiveTrades() {
  const { data, error } = await supabase
    .from('scalpy_trades')
    .select('*')
    .eq('dry_run', false)
    .in('status', ['PENDING', 'MATCHED'])

  if (error) throw new Error(`[trade.repository] getOpenLiveTrades failed: ${error.message}`)
  return data
}

/**
 * Get recent trades with optional filters.
 * @param {{ limit?: number, dryRun?: boolean, status?: string }} opts
 */
export async function getTrades({ limit = 50, dryRun, status } = {}) {
  let query = supabase
    .from('scalpy_trades')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit)

  if (dryRun !== undefined) query = query.eq('dry_run', dryRun)
  if (status)               query = query.eq('status', status)

  const { data, error } = await query
  if (error) throw new Error(`[trade.repository] getTrades failed: ${error.message}`)
  return data
}

/**
 * Today's PLACED bets (Istanbul day) for the Scalpy tab — only fixtures we actually bet on
 * (PENDING/MATCHED/SETTLED), newest first. "Daily reset" = this window rolls at local midnight;
 * rows are never deleted.
 */
export async function getTradesForDay() {
  const { data, error } = await supabase
    .from('scalpy_trades')
    .select('*')
    .gte('created_at', startOfIstanbulDayUtc())
    .in('status', ['PENDING', 'MATCHED', 'SETTLED'])
    .order('created_at', { ascending: false })
  if (error) throw new Error(`[trade.repository] getTradesForDay failed: ${error.message}`)
  return data
}

/**
 * Get a single trade by ID.
 */
export async function getTradeById(id) {
  const { data, error } = await supabase
    .from('scalpy_trades')
    .select('*')
    .eq('id', id)
    .single()

  if (error) throw new Error(`[trade.repository] getTradeById failed: ${error.message}`)
  return data
}

/**
 * Get PENDING trades (for settlement poller).
 */
export async function getPendingTrades() {
  const { data, error } = await supabase
    .from('scalpy_trades')
    .select('*')
    .eq('status', 'PENDING')

  if (error) throw new Error(`[trade.repository] getPendingTrades failed: ${error.message}`)
  return data
}

/**
 * P&L summary across all trades.
 */
export async function getSummary() {
  const { data, error } = await supabase
    .from('scalpy_trades')
    .select('pnl, status, outcome, dry_run, created_at')

  if (error) throw new Error(`[trade.repository] getSummary failed: ${error.message}`)

  const settled = data.filter(t => t.status === 'SETTLED')
  const todayStart = startOfIstanbulDayUtc()
  const todaySettled = settled.filter(t => t.created_at >= todayStart)

  return {
    total: data.length,
    settled: settled.length,
    won: settled.filter(t => t.outcome === 'WON').length,
    lost: settled.filter(t => t.outcome === 'LOST').length,
    winRate: settled.length > 0
      ? Math.round((settled.filter(t => t.outcome === 'WON').length / settled.length) * 100)
      : null,
    totalPnl: settled.reduce((sum, t) => sum + (t.pnl ?? 0), 0),
    todayPnl: todaySettled.reduce((sum, t) => sum + (t.pnl ?? 0), 0),
  }
}

// ------------------------------------------------------------------
// Match-state persistence (scalpy_match_states) — audit / restart recovery
// ------------------------------------------------------------------

/**
 * Upsert the in-memory match state for a fixture (keyed by genius_id).
 * @param {Object} state - MatchState from scalpy.match-state.js
 */
export async function upsertMatchState(state) {
  const { error } = await supabase
    .from('scalpy_match_states')
    .upsert({
      genius_id:     state.geniusId,
      home_team:     state.homeTeam,
      away_team:     state.awayTeam,
      total_goals:   state.totalGoals,
      phase:         state.phase ?? null,
      betting_done:  state.bettingDone,
      last_event_ts: state.lastSeenTs ?? null,
      updated_at:    new Date().toISOString(),
    }, { onConflict: 'genius_id' })

  if (error) throw new Error(`[trade.repository] upsertMatchState failed: ${error.message}`)
}
