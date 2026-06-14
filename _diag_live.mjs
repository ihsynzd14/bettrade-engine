import 'dotenv/config'
import axios from 'axios'
import { login, getSessionToken } from './src/services/betfair-auth.service.js'
import { getGeniusFixtures } from './src/services/genius-fixtures.service.js'

const NAME = /flora|kalev/i
const now = new Date()
console.log('NOW:', now.toISOString(), '\n')

// 1) Engine overlap (what the engine currently believes)
const ov = await (await fetch('http://127.0.0.1:4001/api/v1/fixtures/overlap')).json()
console.log('=== ENGINE OVERLAP ===')
console.log('lastUpdated:', ov.lastUpdated, '| count:', ov.count)
const ageSec = ov.lastUpdated ? Math.round((now - new Date(ov.lastUpdated)) / 1000) : null
console.log('overlap age:', ageSec, 'seconds old')
const hits = (ov.fixtures || []).filter(f => NAME.test((f.homeTeam || '') + ' ' + (f.awayTeam || '')))
for (const f of hits) {
  console.log('\n[OVERLAP HIT]', f.homeTeam, 'v', f.awayTeam)
  console.log('  geniusId:', f.geniusId, '| betfairEventId:', f.betfairEventId, '| betfairMarketId:', f.betfairMarketId)
  console.log('  status(genius):', f.status, '| startTime:', f.startTime)
  console.log('  market.inplay:', f.market?.inplay, '| market.status:', f.market?.status)
}
if (!hits.length) console.log('  (no Flora/Kalev fixture in current overlap)')

// 2) Genius FRESH status (bypassing the possibly-stale overlap)
console.log('\n=== GENIUS (fresh, via getGeniusFixtures) ===')
const genius = await getGeniusFixtures()
const ghits = genius.filter(g => NAME.test((g.home || '') + ' ' + (g.away || '')))
for (const g of ghits) {
  const startedMin = Math.round((now - new Date(g.startTime)) / 60000)
  console.log(`  ${g.home} v ${g.away} | id=${g.geniusId} | status=${g.status} | start=${g.startTime} (${startedMin}m ago)`)
}
if (!ghits.length) console.log('  (no Flora/Kalev in genius notfinished list)')

// 3) Betfair book (is the market actually in-play?)
console.log('\n=== BETFAIR listMarketBook ===')
const marketIds = [...new Set(hits.map(h => h.betfairMarketId).filter(Boolean))]
if (marketIds.length) {
  await login()
  const r = await axios.post(
    'https://api.betfair.com/exchange/betting/rest/v1.0/listMarketBook/',
    { marketIds, priceProjection: { priceData: ['EX_BEST_OFFERS'] } },
    { headers: { 'X-Application': process.env.BETFAIR_APP_KEY, 'X-Authentication': getSessionToken(), 'Content-Type': 'application/json', Accept: 'application/json' } }
  )
  for (const b of r.data) console.log(`  market ${b.marketId} | status=${b.status} | inplay=${b.inplay}`)
} else {
  console.log('  (no betfairMarketId to query)')
}
