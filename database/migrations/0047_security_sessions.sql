-- Old opaque sessions have no credential version and require one fresh sign-in.
-- Versions are keyed digests; no password or OAuth client secret is stored here.
ALTER TABLE admin_sessions
  ADD COLUMN auth_method text CHECK (auth_method IN ('password', 'feishu')),
  ADD COLUMN credential_version text;

CREATE INDEX admin_sessions_user_id_idx ON admin_sessions (user_id);
