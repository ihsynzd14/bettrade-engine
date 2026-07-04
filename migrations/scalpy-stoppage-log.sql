-- Full post-90' event timeline for a bet: every feed event (danger states, corners, VAR, goals,
-- fouls, shots…) plus the bot's own decisions (announced / deferred / placed), each with the running
-- match clock. Captured from the 2nd-half stoppage announcement to full time and stored as newline-
-- joined text. Lets Ersen replay exactly what happened after 90' — "where did it buy, was there
-- danger, should it have waited / priced higher" — long after the live feed is gone.
ALTER TABLE scalpy_trades ADD COLUMN IF NOT EXISTS stoppage_log text;
