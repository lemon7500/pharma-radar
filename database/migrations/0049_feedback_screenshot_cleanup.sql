-- A screenshot can have a reusable Feishu image key while its private original still awaits deletion.
-- Keep the original key on the existing feedback row, including legacy rows without attempt receipts.
ALTER TABLE feedback ADD COLUMN screenshot_cleanup_key text
  CHECK (screenshot_cleanup_key IS NULL OR screenshot_cleanup_key ~ '^feedback-screenshots/[A-Za-z0-9_.-]+$');
CREATE INDEX feedback_screenshot_cleanup_idx ON feedback (created_at) WHERE screenshot_cleanup_key IS NOT NULL;
