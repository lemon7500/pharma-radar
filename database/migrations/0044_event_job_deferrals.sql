-- Budget and in-flight waits outlive pg-boss's finite retry limit. No paid request is made here.
CREATE TABLE event_job_deferrals (
  queue text NOT NULL CHECK (queue IN ('events.group', 'events.digest')),
  job_key text NOT NULL,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  reason text NOT NULL CHECK (reason IN ('budget', 'busy')),
  service text,
  message text NOT NULL,
  next_retry_at timestamptz NOT NULL,
  source_job_id uuid,
  deferral_count integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (queue, job_key),
  CHECK (reason <> 'budget' OR service IS NOT NULL)
);

CREATE INDEX event_job_deferrals_due_idx ON event_job_deferrals (next_retry_at, created_at);

-- A historical failed job may be imported once, even after its deferred work was drained.
CREATE TABLE event_job_deferral_imports (
  source_job_id uuid PRIMARY KEY,
  queue text NOT NULL CHECK (queue IN ('events.group', 'events.digest')),
  job_key text NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now()
);

-- Operational payloads are private, including on Supabase's public schema REST surface.
ALTER TABLE event_job_deferrals ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_job_deferral_imports ENABLE ROW LEVEL SECURITY;
DO $$
DECLARE client_role text;
BEGIN
  FOREACH client_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=client_role) THEN
      EXECUTE format('REVOKE ALL ON public.event_job_deferrals, public.event_job_deferral_imports FROM %I', client_role);
    END IF;
  END LOOP;
END $$;
