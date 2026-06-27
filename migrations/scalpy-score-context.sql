-- Score AT BET TIME (home/away split) so the bets list can show "U/O 3.5 (2-1)" — the context Ersen
-- needs to analyse why a bet lost. total_goals already stores the sum; these add the breakdown.
ALTER TABLE scalpy_trades ADD COLUMN IF NOT EXISTS home_goals int;
ALTER TABLE scalpy_trades ADD COLUMN IF NOT EXISTS away_goals int;
