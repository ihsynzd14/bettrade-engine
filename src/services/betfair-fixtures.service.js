import axios from 'axios'
import { getSessionToken } from './betfair-auth.service.js'

const BETTING_API = 'https://api.betfair.com/exchange/betting/rest/v1.0'

/**
 * Fetches upcoming and in-play Soccer Match Odds markets from Betfair.
 * Includes competition name and runner details for each market.
 *
 * @returns {Promise<Array<{
 *   betfairEventId: string,
 *   betfairMarketId: string,
 *   home: string,
 *   away: string,
 *   startTime: string,
 *   competition: string | null,
 *   runners: Array<{ selectionId: number, runnerName: string, sortPriority: number }>
 * }>>}
 */
export async function getBetfairFixtures() {
  const appKey = process.env.BETFAIR_APP_KEY
  const sessionToken = getSessionToken()

  const filter = {
    eventTypeIds: ['1'],           // 1 = Football/Soccer
    marketTypeCodes: ['MATCH_ODDS'],
    marketStartTime: {
      from: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      to:   new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    },
  }

  const response = await axios.post(
    `${BETTING_API}/listMarketCatalogue/`,
    {
      filter,
      marketProjection: ['EVENT', 'RUNNER_DESCRIPTION', 'MARKET_START_TIME', 'COMPETITION'],
      maxResults: 1000,
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
    .filter(m => m.runners && m.runners.length >= 2)
    .map(m => {
      const eventName = m.event?.name ?? ''
      const parts = eventName.split(' v ')
      const home = parts[0]?.trim() || m.runners[0]?.runnerName || ''
      const away = parts[1]?.trim() || m.runners[2]?.runnerName || m.runners[1]?.runnerName || ''

      return {
        betfairEventId:  m.event?.id    ?? '',
        betfairMarketId: m.marketId,
        home,
        away,
        startTime:       m.marketStartTime ?? '',
        competition:     m.competition?.name ?? null,
        runners:         (m.runners ?? []).map(r => ({
          selectionId:  r.selectionId,
          runnerName:   r.runnerName,
          sortPriority: r.sortPriority ?? 0,
        })),
      }
    })
}
