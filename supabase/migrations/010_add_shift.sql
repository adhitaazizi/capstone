-- Add shift_number to production_session.
-- Values: 1 = 00:00–08:40, 2 = 08:40–15:45, 3 = 15:45–00:00
ALTER TABLE production_session
ADD COLUMN IF NOT EXISTS shift_number SMALLINT CHECK (shift_number IN (1, 2, 3));
