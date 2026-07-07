-- Restart-safety for the club-friendly strategy.
--
-- The friendly strategy prices its 87/88/89' rungs off the 1st-half added time, which it reads from
-- the 1st-half END clock (`firstHalfEndSec` = max FirstHalf phase-elapsed seconds). That value was
-- in-memory only, so a mid-match engine restart — or a fixture first picked up after half-time —
-- lost it, and the friendly strategy then silently skipped the whole match ("1st half not observed").
--
-- Persist it here so it can be rehydrated on boot. NULL until the 1st half is observed.
ALTER TABLE scalpy_match_states ADD COLUMN IF NOT EXISTS first_half_end_sec int;
