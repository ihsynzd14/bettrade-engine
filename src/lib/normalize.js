import stringSimilarity from 'string-similarity'

export const TIME_WINDOW_MS = 60 * 60 * 1000

/**
 * Strips common football club name noise so "Man Utd" and "Manchester United"
 * become closer to each other before similarity scoring.
 *
 * @param {string} name
 * @returns {string} normalized lowercase string
 */
export function normalizeName(name) {
  return name
    .toLowerCase()
    // Remove common prefixes/suffixes
    .replace(/\b(fc|cf|ac|sc|afc|bfc|1\.|vfb|fsv|rb|bv|sv|vfl|tsv|1fc)\b/g, '')
    // Expand common abbreviations
    .replace(/\bman\b/g, 'manchester')
    .replace(/\butd\b/g, 'united')
    .replace(/\bspurs\b/g, 'tottenham')
    .replace(/\bwolves\b/g, 'wolverhampton')
    .replace(/\bvilla\b/g, 'aston villa')
    // Remove punctuation, extra spaces
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Dice Coefficient similarity between two strings, via string-similarity package.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number} 0–1, where 1 is identical
 */
export function similarity(a, b) {
  return stringSimilarity.compareTwoStrings(normalizeName(a), normalizeName(b))
}

/**
 * Combined similarity score for a fixture pair.
 * Averages home-vs-home and away-vs-away scores.
 *
 * @param {{ home: string, away: string }} genius
 * @param {{ home: string, away: string }} betfair
 * @returns {number} 0–1 combined score
 */
export function fixtureSimilarity(genius, betfair) {
  const homeScore = similarity(genius.home, betfair.home)
  const awayScore = similarity(genius.away, betfair.away)
  return (homeScore + awayScore) / 2
}

export function bookingFixtureSimilarity(overlapFixture, bookingFixture) {
  const parts = bookingFixture.name.split(' v ')
  if (parts.length !== 2) return 0

  const bookingHome = parts[0].trim()
  const bookingAway = parts[1].trim()

  const timeA = new Date(overlapFixture.startTime).getTime()
  const timeB = new Date(bookingFixture.date).getTime()
  if (isNaN(timeA) || isNaN(timeB)) return 0
  if (Math.abs(timeA - timeB) > TIME_WINDOW_MS) return 0

  const homeScore = similarity(overlapFixture.homeTeam, bookingHome)
  const awayScore = similarity(overlapFixture.awayTeam, bookingAway)
  return (homeScore + awayScore) / 2
}
