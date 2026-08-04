/**
 * Schema types for the Supabase client.
 *
 * Written by hand — there is no Supabase CLI wired into this repo. Keep in sync
 * with supabase/migrations/, in particular 011_inference_pipeline.sql, which
 * reconciled spindle_pass onto `pass_id` + `toy_number` and added the sampling
 * provenance columns on detection_event.
 *
 * This file was previously `export type Database = any`, which is how the
 * `spindle_pass_id` / `pass_id` drift between migrations 002 and 009 went
 * unnoticed in every route handler that touched the table.
 *
 * Everything here is a `type` alias rather than an `interface` on purpose:
 * postgrest-js constrains each row to `Record<string, unknown>`, and only type
 * aliases get an implicit index signature. Converting any of these to an
 * interface makes every query in the app resolve to `never`.
 */

type Timestamptz = string
type Uuid = string
type Json = unknown

/** A table whose insert/update shapes are derived from its row shape. */
type TableShape<Row, Optional extends keyof Row = never> = {
  Row: Row
  Insert: Omit<Row, Optional> & Partial<Pick<Row, Optional>>
  Update: Partial<Row>
  Relationships: []
}

export type CameraRow = {
  camera_id: number
  camera_code: string
  name: string
  location: string | null
  position_type: 'entry' | 'exit'
  status: 'active' | 'inactive' | 'error'
  resolution: string | null
  created_at: Timestamptz
}

export type DetectionModelRow = {
  model_id: number
  model_name: string
  version: string
  architecture: string
  accuracy: number | null
  mlflow_run_id: string | null
  is_active: boolean
  deployed_at: Timestamptz | null
}

export type ProductionSessionRow = {
  session_id: Uuid
  shift_label: string | null
  shift_number: number | null
  start_time: Timestamptz
  end_time: Timestamptz | null
  total_spindles: number
  total_matched: number
  total_mismatched: number
  operator_id: string | null
}

export type SpindlePassStatus = 'in_progress' | 'matched' | 'mismatched'

export type SpindlePassRow = {
  pass_id: Uuid
  session_id: Uuid
  toy_number: string
  entry_count: number
  exit_count: number | null
  entry_time: Timestamptz
  exit_time: Timestamptz | null
  status: SpindlePassStatus
  /** Signed: positive means the exit camera saw more than the entry camera. */
  mismatch_delta: number | null
}

export type DetectionEventRow = {
  event_id: Uuid
  /** Denormalized shift reference; an orphaned observation has no pass to join. */
  session_id: Uuid | null
  /** Optional since 011 — the pipeline keys on camera_code instead. */
  camera_id: number | null
  model_id: number | null
  /** Null for an observation that could not be paired to a spindle pass. */
  spindle_pass_id: Uuid | null
  frame_timestamp: Timestamptz
  raw_count: number
  confidence_avg: number | null
  processing_time_ms: number | null
  bboxes: Json
  camera_code: string | null
  interval_count: number | null
  sample_count: number | null
  spindle_box: Json
  window_start: Timestamptz | null
  window_end: Timestamptz | null
}

export type UserRow = {
  id: string
  name: string
  email: string
  email_verified: boolean
  image: string | null
  role: string | null
  is_active: boolean | null
  created_at: Timestamptz
  updated_at: Timestamptz
}

export type Database = {
  public: {
    Tables: {
      camera: TableShape<
        CameraRow,
        'camera_id' | 'created_at' | 'status' | 'location' | 'resolution'
      >
      detection_model: TableShape<
        DetectionModelRow,
        'model_id' | 'accuracy' | 'mlflow_run_id' | 'is_active' | 'deployed_at'
      >
      production_session: TableShape<
        ProductionSessionRow,
        | 'session_id'
        | 'start_time'
        | 'end_time'
        | 'total_spindles'
        | 'total_matched'
        | 'total_mismatched'
        | 'shift_label'
        | 'shift_number'
        | 'operator_id'
      >
      spindle_pass: TableShape<
        SpindlePassRow,
        | 'pass_id'
        | 'toy_number'
        | 'entry_time'
        | 'exit_count'
        | 'exit_time'
        | 'status'
        | 'mismatch_delta'
      >
      detection_event: TableShape<
        DetectionEventRow,
        | 'event_id'
        | 'session_id'
        | 'camera_id'
        | 'model_id'
        | 'spindle_pass_id'
        | 'confidence_avg'
        | 'processing_time_ms'
        | 'bboxes'
        | 'camera_code'
        | 'interval_count'
        | 'sample_count'
        | 'spindle_box'
        | 'window_start'
        | 'window_end'
      >
      user: TableShape<
        UserRow,
        'role' | 'is_active' | 'image' | 'created_at' | 'updated_at'
      >
    }
    Views: Record<string, never>
    Functions: Record<string, never>
  }
}
