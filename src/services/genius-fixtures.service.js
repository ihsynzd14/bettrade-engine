import axios from 'axios'

/**
 * Fetches active (non-finished) football fixtures from geniusBackend v2 API.
 *
 * Uses GET /v2/fixtures/recent?limit=100&status=notfinished, paging through
 * all results. Response shape: { page, pageSize, totalItems, items: [...] }
 *
 * Item fields used:
 *   fixture.id                    — Genius fixture ID
 *   fixture.homeCompetitor.name   — home team name
 *   fixture.competitors[1].name   — away team name (index 1)
 *   fixture.startDate             — ISO start datetime
 *   fixture.eventStatusType       — e.g. "Scheduled", "InProgress", "Finished"
 *
 * @returns {Promise<Array<{
 *   geniusId: string,
 *   home: string,
 *   away: string,
 *   startTime: string,
 *   status: string
 * }>>}
 */
export async function getGeniusFixtures() {
  const baseUrl = process.env.GENIUS_BACKEND_URL ?? 'http://localhost:3003'
  const PAGE_SIZE = 100
  const MAX_PAGES = 20 // safety cap: 2000 fixtures max

  let allItems = []
  let page = 1
  let hasMore = true

  while (hasMore) {
    const url = `${baseUrl}/v2/fixtures/recent`
    const response = await axios.get(url, {
      params: {
        limit: PAGE_SIZE,
        page,
        status: 'notfinished',
      },
      timeout: 15_000,
    })

    const { items = [], totalItems = 0 } = response.data
    allItems = allItems.concat(items)

    const totalPages = Math.ceil(totalItems / PAGE_SIZE)
    hasMore = page < totalPages && page < MAX_PAGES
    page++
  }

  return allItems.map(fixture => {
    // homeCompetitor is the authoritative home team field.
    // For away, competitors[1] is the non-home competitor when homeCompetitor
    // matches competitors[0]. Fall back to parsing fixture.name if needed.
    const home = fixture.homeCompetitor?.name ?? fixture.competitors?.[0]?.name ?? ''
    const awayCompetitor = fixture.competitors?.find(c => c.id !== fixture.homeCompetitor?.id)
    const away = awayCompetitor?.name ?? fixture.competitors?.[1]?.name ?? ''

    return {
      geniusId:  String(fixture.id),
      home,
      away,
      startTime: fixture.startDate ?? '',
      status:    fixture.eventStatusType ?? 'UNKNOWN',
    }
  })
}
