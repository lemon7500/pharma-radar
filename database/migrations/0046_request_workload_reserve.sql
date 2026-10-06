-- Class is recorded once when a request is admitted. Prior attempts are conservatively background.
ALTER TABLE receipt_attempts ADD COLUMN workload_class text NOT NULL DEFAULT 'background'
  CHECK (workload_class IN ('recent', 'background'));
CREATE INDEX receipt_attempts_workload_window_idx ON receipt_attempts (service, workload_class, started_at DESC) WHERE origin = 'live';

CREATE FUNCTION preserve_receipt_attempt_workload() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.workload_class IS DISTINCT FROM OLD.workload_class THEN
    RAISE EXCEPTION 'receipt attempt workload_class is immutable';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER receipt_attempt_workload_immutable BEFORE UPDATE OF workload_class ON receipt_attempts
  FOR EACH ROW EXECUTE FUNCTION preserve_receipt_attempt_workload();

-- This allocates existing allowance; it does not change any service's total budget.
INSERT INTO settings (key, value) VALUES ('processing.request-reserve', '{"enabled":true,"perHour":40,"perDay":200}')
  ON CONFLICT (key) DO NOTHING;
