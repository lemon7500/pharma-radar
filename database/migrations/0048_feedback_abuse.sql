-- Private abuse bookkeeping contains opaque source/payload digests, never an IP or user agent.
ALTER TABLE feedback ADD COLUMN screenshot_bytes bigint CHECK (screenshot_bytes >= 0);
ALTER TABLE feedback ADD COLUMN screenshot_remote boolean;

CREATE TABLE feedback_submission_attempts (
  id uuid PRIMARY KEY,
  source_hash text NOT NULL,
  state text NOT NULL CHECK (state IN ('pending', 'succeeded', 'failed')),
  screenshot_bytes bigint NOT NULL DEFAULT 0 CHECK (screenshot_bytes >= 0),
  storage_key text,
  storage_remote boolean NOT NULL DEFAULT false,
  cleanup_needed boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz NOT NULL,
  finished_at timestamptz
);
CREATE INDEX feedback_attempts_source_time_idx ON feedback_submission_attempts (source_hash, created_at DESC);
CREATE INDEX feedback_attempts_time_idx ON feedback_submission_attempts (created_at DESC);
CREATE INDEX feedback_attempts_cleanup_idx ON feedback_submission_attempts (lease_until) WHERE state = 'pending' OR cleanup_needed;

CREATE TABLE feedback_submission_receipts (
  source_hash text NOT NULL,
  submission_id uuid NOT NULL,
  payload_hash text NOT NULL,
  feedback_id bigint REFERENCES feedback (id) ON DELETE SET NULL,
  active_attempt uuid REFERENCES feedback_submission_attempts (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source_hash, submission_id)
);
CREATE INDEX feedback_receipts_updated_idx ON feedback_submission_receipts (updated_at);

ALTER TABLE feedback_submission_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE feedback_submission_receipts ENABLE ROW LEVEL SECURITY;
DO $$
DECLARE client_role text;
BEGIN
  FOREACH client_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = client_role) THEN
      EXECUTE format('REVOKE ALL ON feedback_submission_attempts, feedback_submission_receipts FROM %I', client_role);
    END IF;
  END LOOP;
END $$;
