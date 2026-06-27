-- Goal(s) that busted an OPEN Under bet, as running match-clock times (e.g. "92:15", or
-- "91:03,93:40" for more than one). Lets the bets list show WHY a bet lost ("gol olunca patlıyoruz").
-- Nullable; only written when a goal lands after a bet was placed on that fixture.
ALTER TABLE scalpy_trades ADD COLUMN IF NOT EXISTS bust_goals text;
