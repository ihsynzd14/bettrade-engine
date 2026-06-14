import 'dotenv/config'
import axios from 'axios'
import { login } from './src/services/betfair-auth.service.js'
import { getBetfairFixtures } from './src/services/betfair-fixtures.service.js'
import { getGeniusFixtures } from './src/services/genius-fixtures.service.js'
import { fixtureSimilarity, bookingFixtureSimilarity } from './src/lib/normalize.js'

const GENIUS = process.env.GENIUS_BACKEND_URL ?? 'http://localhost:3003'
const WINDOW = 60 * 60 * 1000, THRESH = 0.65, now = Date.now()

await login()
const [bf, genius] = await Promise.all([getBetfairFixtures(), getGeniusFixtures()])

// reproduce name+time matching
const matched = []
for (const g of genius) {
  const gt = new Date(g.startTime).getTime()
  for (const b of bf) {
    if (Math.abs(gt - new Date(b.startTime).getTime()) > WINDOW) continue
    if (fixtureSimilarity({ home: g.home, away: g.away }, { home: b.home, away: b.away }) >= THRESH) {
      matched.push({ homeTeam: g.home, awayTeam: g.away, startTime: g.startTime, status: g.status }); break
    }
  }
}
const isStarted = m => new Date(m.startTime).getTime() <= now
const started = matched.filter(isStarted)
console.log('matched (pre-booking):', matched.length, '| already started:', started.length)
started.forEach(m => console.log('   STARTED:', `${m.homeTeam} v ${m.awayTeam}`, '|', m.status))

const coverage = (await axios.get(`${GENIUS}/api/booking/fixtures/coverage`, { params: { sportId: 10 }, timeout: 15000 })).data || []

const applyFilter = (list, bypassStarted) => list.filter(f => {
  if (bypassStarted && isStarted(f)) return true
  return coverage.some(bk => bookingFixtureSimilarity(f, bk) >= THRESH)
})

const oldKept = applyFilter(matched, false)
const newKept = applyFilter(matched, true)
console.log('\nOLD filter -> kept:', oldKept.length, '| started kept:', oldKept.filter(isStarted).length)
console.log('NEW filter -> kept:', newKept.length, '| started kept:', newKept.filter(isStarted).length, '  <-- in-play matches now retained')
