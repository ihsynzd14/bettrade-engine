import axios from 'axios'
import { getSessionToken } from './betfair-auth.service.js'

const BETTING_API = 'https://api.betfair.com/exchange/betting/rest/v1.0'

/**
 * Fetches upcoming and in-play Soccer Match Odds markets from Betfair.
 *
 * @returns {Promise<Array<{
 *   betfairEventId: string,
 *   betfairMarketId: string,
 *   home: string,
 *   away: string,
 *   startTime: string
 * }>>}
 */
export async function getBetfairFixtures() {
  const appKey = process.env.BETFAIR_APP_KEY
  const sessionToken = getSessionToken()

  const filter = {
    eventTypeIds: ['1'],           // 1 = Football/Soccer
    marketTypeCodes: ['MATCH_ODDS'],
    inPlayOnly: false,
    turnInPlayEnabled: true,
    marketStartTime: {
      // Fetch matches starting within the next 24 hours + already in-play
      from: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      to:   new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    },
  }

  const response = await axios.post(
    `${BETTING_API}/listMarketCatalogue/`,
    {
      filter,
      marketProjection: ['EVENT', 'RUNNER_DESCRIPTION', 'MARKET_START_TIME'],
      maxResults: 200,
      sort: 'FIRST_TO_START',
    },
    {
      headers: {
        'X-Application':   appKey,
        'X-Authentication': sessionToken,
        'Content-Type':    'application/json',
        Accept:            'application/json',
        'Accept-Encoding': 'gzip, deflate',
        Connection:        'keep-alive',
      },
    }
  )

  const markets = response.data

  return markets
    .filter(m => m.runners && m.runners.length === 2)
    .map(m => {
      // Betfair runner names are typically "Team A v Team B" — split on "v"
      // Or use runner descriptions directly
      const runnerNames = m.runners.map(r => r.runnerName)
      return {
        betfairEventId:  m.event?.id    ?? '',
        betfairMarketId: m.marketId,
        home:            runnerNames[0] ?? m.event?.name?.split(' v ')[0] ?? '',
        away:            runnerNames[1] ?? m.event?.name?.split(' v ')[1] ?? '',
        startTime:       m.marketStartTime ?? '',
      }
    })
}
