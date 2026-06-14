import 'dotenv/config'
import { login } from './src/services/betfair-auth.service.js'
import { getBetfairFixtures } from './src/services/betfair-fixtures.service.js'
import { fetchMarketBooks } from './src/services/betfair-market.service.js'
import { getGeniusFixtures } from './src/services/genius-fixtures.service.js'

const now = Date.now()
await login()
const [bf, genius] = await Promise.all([getBetfairFixtures(), getGeniusFixtures()])

const gs = {}; for (const g of genius) gs[g.status] = (gs[g.status] || 0) + 1
console.log('GENIUS status distribution:', JSON.stringify(gs))
console.log('GENIUS InProgress count   :', genius.filter(g => /inprogress/i.test(g.status)).length)

const past = bf.filter(b => new Date(b.startTime).getTime() < now)
console.log(`\nBETFAIR markets past kickoff: ${past.length} / ${bf.length}`)

const books = await fetchMarketBooks(past.map(b => b.betfairMarketId))
let inplayCount = 0
for (const b of past) {
  const bk = books.get(b.betfairMarketId)
  const startedMin = Math.round((now - new Date(b.startTime).getTime()) / 60000)
  if (bk?.inplay) inplayCount++
  console.log(`  ${bk?.inplay ? 'INPLAY ' : '       '} status=${(bk?.status || '?').padEnd(9)} | +${startedMin}m | ${b.home} v ${b.away}`)
}
console.log(`\nBETFAIR inplay=true among past-kickoff: ${inplayCount} / ${past.length}`)
