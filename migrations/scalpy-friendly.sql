-- Friendly-match strategy support: mark which strategy placed each bet (so Results can separate
-- "friendly" from normal "stoppage" bets) and record the 1st-half added minutes used for pricing.
ALTER TABLE scalpy_trades ADD COLUMN IF NOT EXISTS strategy text NOT NULL DEFAULT 'stoppage';
ALTER TABLE scalpy_trades ADD COLUMN IF NOT EXISTS first_half_added int;
