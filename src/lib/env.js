/**
 * Runtime mode, resolved ONCE at boot so every consumer agrees.
 * (No scattered `process.env.SCALPY_DRY_RUN` reads that could disagree mid-run.)
 */

// DRY_RUN is the default; real money requires an explicit opt-out.
export const DRY_RUN = process.env.SCALPY_DRY_RUN !== 'false'

// Live placement additionally requires an explicit confirmation token.
export const LIVE_CONFIRMED = process.env.SCALPY_LIVE_CONFIRM === 'I_UNDERSTAND'

// LIVE_ARMED: real-money order placement is only allowed when DRY_RUN is off AND the
// operator explicitly confirmed. Otherwise startup forces the kill-switch on (see index.js).
export const LIVE_ARMED = !DRY_RUN && LIVE_CONFIRMED
