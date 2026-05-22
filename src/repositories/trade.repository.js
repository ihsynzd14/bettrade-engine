import { supabase } from '../lib/supabase.js'

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
 * Settle a trade after the market resolves.
 * @param {string} tradeId - UUID of the trade row
 * @param {'WON'|'LOST'} outcome
 * @param {number} pnl - net profit/loss in GBP
 */
export async function settleTrade(tradeId, outcome, pnl) {
  const { error } = await supabase
    .from('scalpy_trades')
    .update({
      outcome,
      pnl,
      status: 'SETTLED',
      settled_at: new Date().toISOString(),
    })
    .eq('id', tradeId)

  if (error) throw new Error(`[trade.repository] settleTrade failed: ${error.message}`)
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
  const today = new Date().toISOString().slice(0, 10)
  const todaySettled = settled.filter(t => t.created_at?.startsWith(today))

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
