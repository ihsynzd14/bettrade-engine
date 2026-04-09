# Booking Coverage Filter for Live Fixtures

## Problem

The live fixtures page currently shows all fixtures matched between Genius Sports and Betfair. Only a subset of these have booking coverage (Venue/Tv feeds) via the Genius Booking API. We need to filter the fixture list to only show fixtures that also appear in the booking coverage data.

## Context

- **bettrade-engine** polls every 60s: fetches Betfair markets + Genius v2 fixtures, fuzzy-matches them into overlapped fixtures, enriches with live market data.
- **geniusBackend** exposes `GET /api/booking/fixtures/coverage` which returns fixtures that have Venue/Tv feed coverage. These fixtures use different IDs than the v2 fixtures API, so matching must be by name + time.
- **bettrade frontend** fetches from `GET /api/v1/fixtures/overlap` and displays the fixtures.

## Design

### Data Flow

```
Every 60s polling cycle:
  1. getBetfairFixtures()                    (existing)
  2. getGeniusFixtures()                     (existing)
  3. Fuzzy match → overlappedFixtures        (existing)
  4. getBookingCoverage()                    ← NEW
  5. Filter overlappedFixtures by booking    ← NEW
  6. Enrich with market data                 (existing)
  7. Store in memory                         (existing)
```

### New Files

**`src/services/booking-coverage.service.js`** — Fetches from `GENIUS_BACKEND_URL/api/booking/fixtures/coverage`, caches for 5 minutes.

### Modified Files

**`src/services/overlap.service.js`** — After building overlapped fixtures, calls booking coverage service. For each overlapped fixture, matches against booking fixtures using:
- Normalized team names via existing `normalize.js`
- Time window +/- 1 hour
- String-similarity threshold >= 0.65
- Removes overlapped fixtures without a booking coverage match

**`.env.example`** — Add `BOOKING_COVERAGE_ENABLED=true` and `GENIUS_BACKEND_URL` env vars.

### Matching Algorithm

1. Parse booking fixture `name` field (e.g., "Manchester City v Wolverhampton Wanderers") into home/away parts.
2. For each overlapped fixture, compare against each booking fixture:
   - Split booking name by " v " separator.
   - Normalize all team names using existing `normalizeName()`.
   - Compute similarity of home names and away names using `similarity()`.
   - Average the two scores.
   - Compare start times within +/- 1 hour.
3. If score >= 0.65 and time matches, the overlapped fixture is kept.
4. Fixtures without any booking match are removed.

### Configuration

| Variable | Purpose | Default |
|---|---|---|
| `BOOKING_COVERAGE_ENABLED` | Enable/disable booking filter | `true` |
| `GENIUS_BACKEND_URL` | Genius backend base URL for booking coverage | `http://localhost:3002` |

### Impact on Other Projects

- **bettrade frontend**: No changes. Same endpoint, same data shape — fewer fixtures.
- **geniusBackend**: No changes. Existing endpoint consumed as-is.
