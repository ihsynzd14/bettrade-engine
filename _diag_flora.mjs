import 'dotenv/config'
import axios from 'axios'
import { login } from './src/services/betfair-auth.service.js'
import { getBetfairFixtures } from './src/services/betfair-fixtures.service.js'
import { getGeniusFixtures } from './src/services/genius-fixtures.service.js'
import { fixtureSimilarity, bookingFixtureSimilarity } from './src/lib/normalize.js'

const GENIUS = process.env.GENIUS_BACKEND_URL ?? 'http://localhost:3003'
const RX = /flora|kalev/i
const WINDOW = 60 * 60 * 1000

await login()
const [bf, genius] = await Promise.all([getBetfairFixtures(), getGeniusFixtures()])

const bfHits = bf.filter(b => RX.test(`${b.home} ${b.away}`))
const gHits  = genius.filter(g => RX.test(`${g.home} ${g.away}`))

console.log('=== BETFAIR candidates ===')
bfHits.forEach(b => console.log(`  "${b.home} v ${b.away}" | start=${b.startTime} | mkt=${b.betfairMarketId}`))
console.log('=== GENIUS candidates ===')
gHits.forEach(g => console.log(`  "${g.home} v ${g.away}" | status=${g.status} | start=${g.startTime}`))

console.log('\n=== STEP 1: name+time match (threshold 0.65, +/-1h) ===')
for (const g of gHits) {
  for (const b of bfHits) {
    const dt = Math.abs(new Date(g.startTime) - new Date(b.startTime))
    const score = fixtureSimilarity({ home: g.home, away: g.away }, { home: b.home, away: b.away })
    const ok = dt <= WINDOW && score >= 0.65
    console.log(`  ${ok ? 'MATCH ' : 'no    '} score=${score.toFixed(2)} dt=${Math.round(dt / 60000)}m | GS "${g.home} v ${g.away}"  <~>  BF "${b.home} v ${b.away}"`)
  }
}

console.log('\n=== STEP 2: booking coverage ===')
const bc = await axios.get(`${GENIUS}/api/booking/fixtures/coverage`, { params: { sportId: 10 }, timeout: 15000 })
const coverage = Array.isArray(bc.data) ? bc.data : []
console.log('booking coverage entries:', coverage.length)
if (coverage.length) {
  const sample = coverage[0]
  console.log('sample entry keys:', Object.keys(sample).join(','))
  console.log('sample entry:', JSON.stringify(sample).slice(0, 200))
  // date range of coverage
  const dates = coverage.map(c => new Date(c.date || c.startDate || 0).getTime()).filter(Boolean).sort((a, b) => a - b)
  if (dates.length) {
    const now = Date.now()
    console.log('coverage date range:', new Date(dates[0]).toISOString(), '->', new Date(dates[dates.length - 1]).toISOString())
    console.log('coverage entries with date in PAST (kicked off):', dates.filter(d => d < now).length, '/', dates.length)
  }
  // does coverage contain the Flora match?
  const floraCov = coverage.filter(c => RX.test(c.name || ''))
  console.log('Flora/Kalev in booking coverage:', floraCov.length)
  floraCov.forEach(c => console.log('   ', JSON.stringify(c).slice(0, 160)))
}
