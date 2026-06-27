-- ============================================
-- Production Dashboard Seed — Mon–Sat, 3 Shifts/Day
-- ============================================
-- Shift schedule (24-hour manufacturing):
--   Shift 1 : 00:00 – 08:40
--   Shift 2 : 08:40 – 15:45
--   Shift 3 : 15:45 – 00:00 (midnight)
--
-- Run AFTER 010_add_shift.sql.
-- Safe to re-run: closes existing active sessions before re-seeding.
-- ============================================

-- Ensure shift_number column exists
ALTER TABLE production_session
ADD COLUMN IF NOT EXISTS shift_number SMALLINT CHECK (shift_number IN (1, 2, 3));

-- Ensure spindle_pass table exists with toy_number support
CREATE TABLE IF NOT EXISTS spindle_pass (
    pass_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id     UUID NOT NULL REFERENCES production_session(session_id),
    toy_number     VARCHAR(50) NOT NULL,
    entry_count    INT NOT NULL,
    exit_count     INT,
    entry_time     TIMESTAMPTZ NOT NULL DEFAULT now(),
    exit_time      TIMESTAMPTZ,
    status         VARCHAR(20) NOT NULL DEFAULT 'in_progress'
                   CHECK (status IN ('in_progress', 'matched', 'mismatched')),
    mismatch_delta INT
);

DO $$
DECLARE
  v_op_id       TEXT;
  v_monday      DATE;
  v_day         DATE;
  v_dow         INT;     -- 0 = Mon, 1 = Tue, ..., 5 = Sat
  v_shift       INT;
  v_shift_start TIMESTAMPTZ;
  v_shift_end   TIMESTAMPTZ;
  v_cur_time    TIME;
  v_cur_shift   INT;
  v_session_id  UUID;
  v_active_sid  UUID;

  -- Shift times: S1 00:00–08:40, S2 08:40–15:45, S3 15:45–00:00
  shift_starts  TIME[]  := ARRAY['00:00'::TIME, '08:40'::TIME, '15:45'::TIME];
  shift_ends    TIME[]  := ARRAY['08:40'::TIME, '15:45'::TIME, '00:00'::TIME];

BEGIN

  -- Use any existing user as operator (NULL if no users exist yet)
  SELECT id INTO v_op_id FROM "user" LIMIT 1;

  -- Determine the current shift from the server clock
  v_cur_time := CURRENT_TIME;
  IF    v_cur_time >= '00:00' AND v_cur_time < '08:40' THEN v_cur_shift := 1;
  ELSIF v_cur_time >= '08:40' AND v_cur_time < '15:45' THEN v_cur_shift := 2;
  ELSE                                                        v_cur_shift := 3;
  END IF;

  -- Find the Monday of the current week
  -- EXTRACT(DOW): 0=Sun,1=Mon,...,6=Sat  →  we want Mon=0 offset
  v_monday := CURRENT_DATE - ((EXTRACT(DOW FROM CURRENT_DATE)::INT + 6) % 7);

  -- Close any existing active sessions so we start clean
  UPDATE production_session SET end_time = NOW() WHERE end_time IS NULL;

  -- ── Build sessions for Mon–Sat (past & current shifts only) ─────────────
  FOR v_dow IN 0..5 LOOP   -- 0=Mon … 5=Sat
    v_day := v_monday + v_dow;

    -- Skip future days
    CONTINUE WHEN v_day > CURRENT_DATE;

    FOR v_shift IN 1..3 LOOP

      -- Compute start/end timestamps for this shift
      v_shift_start := v_day + shift_starts[v_shift];

      -- Shift 3 ends at midnight (start of next day)
      IF v_shift = 3 THEN
        v_shift_end := v_day + INTERVAL '1 day';
      ELSE
        v_shift_end := v_day + shift_ends[v_shift];
      END IF;

      -- Skip shifts that haven't started yet
      CONTINUE WHEN v_shift_start > NOW();

      v_session_id := gen_random_uuid();

      IF v_day = CURRENT_DATE AND v_shift = v_cur_shift THEN
        -- ── Current active shift ────────────────────────────────────────
        INSERT INTO production_session
          (session_id, shift_label, shift_number, start_time, end_time, operator_id)
        VALUES
          (v_session_id, 'Shift ' || v_shift, v_shift, v_shift_start, NULL, v_op_id);

        v_active_sid := v_session_id;

      ELSE
        -- ── Completed past shift ────────────────────────────────────────
        -- Cap end_time at NOW() for shifts still technically running
        INSERT INTO production_session
          (session_id, shift_label, shift_number, start_time, end_time, operator_id)
        VALUES
          (v_session_id, 'Shift ' || v_shift, v_shift,
           v_shift_start, LEAST(v_shift_end, NOW()), v_op_id);

      END IF;
    END LOOP;
  END LOOP;

  -- ── Spindle passes for the active session ───────────────────────────────
  -- Toy HW-A101 : 5 spindles, each 12 toys  →  4 matched, 1 mismatched
  INSERT INTO spindle_pass (pass_id, session_id, toy_number, entry_count, exit_count, entry_time, exit_time, status, mismatch_delta) VALUES
    (gen_random_uuid(), v_active_sid, 'HW-A101', 12, 12, NOW()-INTERVAL '55 min', NOW()-INTERVAL '54 min', 'matched',    0),
    (gen_random_uuid(), v_active_sid, 'HW-A101', 12, 12, NOW()-INTERVAL '50 min', NOW()-INTERVAL '49 min', 'matched',    0),
    (gen_random_uuid(), v_active_sid, 'HW-A101', 12, 11, NOW()-INTERVAL '45 min', NOW()-INTERVAL '44 min', 'mismatched', -1),
    (gen_random_uuid(), v_active_sid, 'HW-A101', 12, 12, NOW()-INTERVAL '40 min', NOW()-INTERVAL '39 min', 'matched',    0),
    (gen_random_uuid(), v_active_sid, 'HW-A101', 12, 12, NOW()-INTERVAL '35 min', NOW()-INTERVAL '34 min', 'matched',    0);

  -- Toy HW-B205 : 4 spindles, each 8 toys  →  3 matched, 1 mismatched (−2)
  INSERT INTO spindle_pass (pass_id, session_id, toy_number, entry_count, exit_count, entry_time, exit_time, status, mismatch_delta) VALUES
    (gen_random_uuid(), v_active_sid, 'HW-B205', 8, 8, NOW()-INTERVAL '30 min', NOW()-INTERVAL '29 min', 'matched',    0),
    (gen_random_uuid(), v_active_sid, 'HW-B205', 8, 8, NOW()-INTERVAL '25 min', NOW()-INTERVAL '24 min', 'matched',    0),
    (gen_random_uuid(), v_active_sid, 'HW-B205', 8, 6, NOW()-INTERVAL '20 min', NOW()-INTERVAL '19 min', 'mismatched', -2),
    (gen_random_uuid(), v_active_sid, 'HW-B205', 8, 8, NOW()-INTERVAL '15 min', NOW()-INTERVAL '14 min', 'matched',    0);

  -- Toy HW-C300 : 3 spindles, each 10 toys  →  2 matched, 1 still in zone
  INSERT INTO spindle_pass (pass_id, session_id, toy_number, entry_count, exit_count, entry_time, exit_time, status, mismatch_delta) VALUES
    (gen_random_uuid(), v_active_sid, 'HW-C300', 10, 10, NOW()-INTERVAL '10 min', NOW()-INTERVAL '9 min', 'matched',     0),
    (gen_random_uuid(), v_active_sid, 'HW-C300', 10, 10, NOW()-INTERVAL '5 min',  NOW()-INTERVAL '4 min', 'matched',     0),
    (gen_random_uuid(), v_active_sid, 'HW-C300', 10, NULL, NOW()-INTERVAL '1 min', NULL,                  'in_progress', NULL);

END $$;
