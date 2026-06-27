import axios from 'axios'
import { getSessionToken } from './betfair-auth.service.js'

const BETTING_API = 'https://api.betfair.com/exchange/betting/rest/v1.0'

// How far BACK to look for markets by scheduled start. A match runs ~90' + halftime + stoppage ≈ 2h+
// (more with extra time), so a 2h lookback dropped long-running matches from the query ~2h after
// kickoff — which finalised + SETTLED them BEFORE real full time, missing late goals and mis-settling
// (a 2-3 final settled as a WON Under 4.5). 4h keeps a live match in the query until its Betfair
// market actually closes; settled/closed markets aren't returned, so the wider window never re-adds
// finished matches. Override with BETFAIR_FIXTURES_LOOKBACK_HOURS if a competition runs even longer.
const FIXTURE_LOOKBACK_MS = parseFloat(process.env.BETFAIR_FIXTURES_LOOKBACK_HOURS ?? '4') * 60 * 60 * 1000

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
      from: new Date(Date.now() - FIXTURE_LOOKBACK_MS).toISOString(),
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
