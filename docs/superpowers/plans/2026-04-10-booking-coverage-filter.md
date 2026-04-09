# Booking Coverage Filter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Filter the overlapped fixtures list in bettrade-engine to only include fixtures that have booking coverage (Venue/Tv feeds) from the Genius Booking API.

**Architecture:** Add a booking-coverage service that fetches from the geniusBackend's `/api/booking/fixtures/coverage` endpoint. During each polling cycle, after building overlapped fixtures, fuzzy-match them against booking coverage fixtures by team name + time window. Remove fixtures without a booking match.

**Tech Stack:** Node.js (ES modules), Express, axios, string-similarity (existing)

---

### Task 1: Create Booking Coverage Service

**Files:**
- Create: `src/services/booking-coverage.service.js`

- [ ] **Step 1: Create `src/services/booking-coverage.service.js`**

```js
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
```

- [ ] **Step 2: Commit**

```bash
git add src/services/booking-coverage.service.js
git commit -m "feat: add booking coverage service"
```

---

### Task 2: Add Booking Name Matcher to normalize.js

**Files:**
- Modify: `src/lib/normalize.js`

- [ ] **Step 1: Add `bookingFixtureSimilarity` function to `src/lib/normalize.js`**

Append to end of file (after the existing `fixtureSimilarity` function):

```js
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
```

Also add `TIME_WINDOW_MS` as a named export at the top (after `SIMILARITY_THRESHOLD` line in overlap.service.js — actually, define it in normalize.js):

Add this constant at the top of normalize.js (after the import):

```js
export const TIME_WINDOW_MS = 60 * 60 * 1000
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/normalize.js
git commit -m "feat: add booking fixture similarity matcher"
```

---

### Task 3: Integrate Booking Coverage Filter into Overlap Polling

**Files:**
- Modify: `src/services/overlap.service.js`

- [ ] **Step 1: Add imports and filter logic to `src/services/overlap.service.js`**

Add imports at the top (after existing imports):

```js
import { getBookingCoverage } from './booking-coverage.service.js'
import { fixtureSimilarity, bookingFixtureSimilarity } from '../lib/normalize.js'
```

Remove the old `fixtureSimilarity` import line (replace with the new one above).

- [ ] **Step 2: Add filter step in `syncOnce()` after the `matched` array is built (after line 105) and before the market book enrichment (before line 110)**

Insert this block between the matching loop and the "Enrich with live Betfair market data" comment:

```js
  if (process.env.BOOKING_COVERAGE_ENABLED !== 'false') {
    try {
      const bookingFixtures = await getBookingCoverage()
      console.log(`[overlap] Booking coverage: ${bookingFixtures.length} fixtures`)

      const before = matched.length
      for (let i = matched.length - 1; i >= 0; i--) {
        const fixture = matched[i]
        let found = false
        for (const booking of bookingFixtures) {
          const score = bookingFixtureSimilarity(fixture, booking)
          if (score >= SIMILARITY_THRESHOLD) {
            found = true
            break
          }
        }
        if (!found) {
          matched.splice(i, 1)
        }
      }
      console.log(`[overlap] Booking filter: ${before} → ${matched.length} fixtures`)
    } catch (err) {
      console.error('[overlap] Booking coverage filter failed:', err.message)
    }
  }
```

- [ ] **Step 3: Commit**

```bash
git add src/services/overlap.service.js
git commit -m "feat: integrate booking coverage filter into overlap polling"
```

---

### Task 4: Update .env.example

**Files:**
- Modify: `.env.example`

- [ ] **Step 1: Add `BOOKING_COVERAGE_ENABLED` variable**

Append to end of `.env.example`:

```
# Booking coverage filter (set to 'false' to disable)
BOOKING_COVERAGE_ENABLED=true
```

- [ ] **Step 2: Commit**

```bash
git add .env.example
git commit -m "docs: add BOOKING_COVERAGE_ENABLED to env example"
```

---

### Task 5: Verify Integration

- [ ] **Step 1: Ensure geniusBackend is running and booking coverage endpoint responds**

Run: `curl http://localhost:3002/api/booking/fixtures/coverage?sportId=10 | head -c 500`
Expected: JSON array of fixture objects with `fixtureId`, `name`, `date`, etc.

- [ ] **Step 2: Start bettrade-engine and check logs**

Run: `node src/index.js` (from bettrade-engine directory)
Expected in logs:
- `[booking-coverage] Fetched N fixtures`
- `[overlap] Booking coverage: N fixtures`
- `[overlap] Booking filter: X → Y fixtures`
- Final fixture count should be lower than before if some overlapped fixtures lack booking coverage.

- [ ] **Step 3: Verify the /api/v1/fixtures/overlap endpoint returns only filtered fixtures**

Run: `curl http://localhost:4001/api/v1/fixtures/overlap`
Expected: JSON response with `ok: true` and fixtures array containing only booking-covered fixtures.
