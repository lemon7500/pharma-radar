-- Additive provenance and validation diagnostics; historical material and URLs stay intact.
ALTER TABLE articles ADD COLUMN research_processing_version text;
ALTER TABLE articles ADD COLUMN research_material_fingerprint text;
ALTER TABLE articles ADD COLUMN research_validation jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE articles ADD COLUMN research_material_kind text;
ALTER TABLE articles ADD COLUMN research_checked_at timestamptz;
