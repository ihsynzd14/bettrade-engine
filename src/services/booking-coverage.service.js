import axios from 'axios'

const CACHE_TTL = 5 * 60 * 1000

let cachedFixtures = null
let cachedAt = 0

export async function getBookingCoverage() {
  if (cachedFixtures && Date.now() - cachedAt < CACHE_TTL) {
    return cachedFixtures
  }

  const baseUrl = process.env.GENIUS_BACKEND_URL ?? 'http://localhost:3002'

  try {
    const res = await axios.get(`${baseUrl}/api/booking/fixtures/coverage`, {
      params: { sportId: 10 },
      timeout: 15_000,
    })

    cachedFixtures = Array.isArray(res.data) ? res.data : []
    cachedAt = Date.now()

    console.log(`[booking-coverage] Fetched ${cachedFixtures.length} fixtures`)
    return cachedFixtures
  } catch (err) {
    console.error('[booking-coverage] Fetch failed:', err.message)
    return cachedFixtures ?? []
  }
}
