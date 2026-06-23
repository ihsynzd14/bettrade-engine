/**
 * The Betfair price tick ladder. Prices step by band (0.01 below 2.00, 0.02 to 3, 0.05 to 4,
 * 0.1 to 6, 0.2 to 10, 0.5 to 20, 1 to 30, 2 to 50, 5 to 100, 10 to 1000). "+N ticks" means
 * moving N steps along THIS ladder — never `price + 0.0N`. Built once with integer-cents math
 * to avoid float drift.
 */

const BANDS = [
  [1.01, 2,    0.01],
  [2,    3,    0.02],
  [3,    4,    0.05],
  [4,    6,    0.10],
  [6,    10,   0.20],
  [10,   20,   0.50],
  [20,   30,   1.00],
  [30,   50,   2.00],
  [50,   100,  5.00],
  [100,  1000, 10.00],
]

function buildLadder() {
  const ladder = []
  for (const [from, to, step] of BANDS) {
    const fromC = Math.round(from * 100)
    const toC   = Math.round(to * 100)
    const stepC = Math.round(step * 100)
    // The boundary price is already included by the previous band → start one step in.
    const start = ladder.length === 0 ? fromC : fromC + stepC
    for (let c = start; c <= toC; c += stepC) ladder.push(c / 100)
  }
  return ladder
}

export const LADDER = buildLadder()
const N = LADDER.length

/** Index of the nearest valid tick price (ties round UP to the higher price). */
function nearestIndex(price) {
  if (price <= LADDER[0]) return 0
  if (price >= LADDER[N - 1]) return N - 1
  let best = 0
  let bestDiff = Infinity
  for (let i = 0; i < N; i++) {
    const diff = Math.abs(LADDER[i] - price)
    if (diff < bestDiff || (diff === bestDiff && LADDER[i] > LADDER[best])) {
      best = i
      bestDiff = diff
    }
  }
  return best
}

/** Snap an arbitrary price to the nearest valid Betfair tick. */
export function snapToTick(price) {
  return LADDER[nearestIndex(price)]
}

/** Move `n` ticks along the ladder from the nearest valid tick to `price` (clamped to ends). */
export function addTicks(price, n) {
  const i = nearestIndex(price)
  const j = Math.max(0, Math.min(N - 1, i + Math.round(n)))
  return LADDER[j]
}

/** Clamp to [min,max] then snap to a valid tick (the result is always a tradable price). */
export function clampPrice(price, min, max) {
  let p = price
  if (min != null && p < min) p = min
  if (max != null && p > max) p = max
  return snapToTick(p)
}
