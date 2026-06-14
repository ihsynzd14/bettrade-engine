import 'dotenv/config'
import { writeFileSync } from 'fs'
import { login } from './src/services/betfair-auth.service.js'
import { getBetfairFixtures } from './src/services/betfair-fixtures.service.js'
import { getGeniusFixtures } from './src/services/genius-fixtures.service.js'
import { fixtureSimilarity } from './src/lib/normalize.js'

const SIMILARITY_THRESHOLD = 0.65
const TIME_WINDOW_MS = 60 * 60 * 1000

await login()
const [betfair, genius] = await Promise.all([getBetfairFixtures(), getGeniusFixtures()])

// Engine's final (matched + enriched) overlap
let overlap = []
try {
  const r = await fetch('http://127.0.0.1:4001/api/v1/fixtures/overlap')
  overlap = (await r.json()).fixtures ?? []
} catch (e) { console.log('overlap fetch failed:', e.message) }

writeFileSync('_diag_betfair.json', JSON.stringify(betfair, null, 2))
writeFileSync('_diag_genius.json', JSON.stringify(genius, null, 2))
writeFileSync('_diag_overlap.json', JSON.stringify(overlap, null, 2))

console.log('=== COUNTS ===')
console.log('betfair markets :', betfair.length)
console.log('genius fixtures :', genius.length)
console.log('engine overlap  :', overlap.length)

const gs = {}; for (const g of genius) gs[g.status] = (gs[g.status] || 0) + 1
console.log('genius status   :', JSON.stringify(gs))

const nowMs = Date.now()
const bfPast = betfair.filter(b => new Date(b.startTime).getTime() < nowMs).length
console.log('betfair started-in-past (maybe in-play):', bfPast, '/', betfair.length)

// Reproduce the NAME+TIME matching (pre booking-coverage filter) exactly like overlap.service
let matched = 0
const unmatched = []
for (const b of betfair) {
  const bt = new Date(b.startTime).getTime()
  let best = { score: 0, g: null, dtMin: Infinity }
  for (const g of genius) {
    const gt = new Date(g.startTime).getTime()
    const dt = Math.abs(bt - gt)
    if (dt > TIME_WINDOW_MS) continue
    const score = fixtureSimilarity({ home: g.home, away: g.away }, { home: b.home, away: b.away })
    if (score > best.score) best = { score, g, dtMin: dt }
  }
  if (best.score >= SIMILARITY_THRESHOLD) matched++
  else unmatched.push({
    bf: `${b.home} v ${b.away}`,
    comp: b.competition,
    bestScore: Math.round(best.score * 100) / 100,
    bestGenius: best.g ? `${best.g.home} v ${best.g.away}` : null,
    geniusStatus: best.g?.status ?? null,
    minDiffMin: best.g ? Math.round(best.dtMin / 60000) : null,
  })
}

console.log('\n=== MATCHING (name>=0.65 within +/-1h, pre-booking) ===')
console.log('betfair matched :', matched, '/', betfair.length)
console.log('betfair UNmatched:', unmatched.length)

// Near-misses: a genius candidate existed in time window but scored just below threshold
const nearMiss = unmatched.filter(u => u.bestScore >= 0.4 && u.bestGenius)
console.log('\n--- near-misses (best 0.40-0.64, likely SHOULD match) ---', nearMiss.length)
for (const u of nearMiss.slice(0, 25)) {
  console.log(`  ${u.bestScore}  BF: "${u.bf}"  <~>  GS: "${u.bestGenius}" [${u.geniusStatus}, ${u.minDiffMin}m]`)
}

const noCandidate = unmatched.filter(u => !u.bestGenius)
console.log('\n--- betfair with NO genius in time window ---', noCandidate.length)
for (const u of noCandidate.slice(0, 15)) console.log(`  "${u.bf}" (${u.comp})`)

console.log('\nWrote _diag_betfair.json, _diag_genius.json, _diag_overlap.json')
