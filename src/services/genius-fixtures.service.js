import axios from 'axios'

/**
 * Fetches active football fixtures from the geniusBackend.
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
  const baseUrl    = process.env.GENIUS_BACKEND_URL ?? 'http://localhost:3002'
  const sportId    = process.env.GENIUS_SOCCER_SPORT_ID ?? '1'

  const response = await axios.get(
    `${baseUrl}/fixtures/sports/${sportId}/active-fixtures`
  )

  const fixtures = response.data

  // Genius Fixture API structure (adjust field paths to match actual response):
  // fixture.id
  // fixture.competitors[0].name  (home)
  // fixture.competitors[1].name  (away)
  // fixture.startDatetime or fixture.fixture.startDatetime
  // fixture.statusId or fixture.fixture.status

  return fixtures.map(fixture => ({
    geniusId:  String(fixture.id),
    home:      fixture.fixturecompetitors?.[0]?.competitor?.name ?? '',
    away:      fixture.fixturecompetitors?.[1]?.competitor?.name ?? '',
    startTime: fixture.startDate ?? '',
    status:    fixture.statusType ?? 'UNKNOWN',
  }))
}
