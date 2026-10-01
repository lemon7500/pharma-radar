-- Additive: old applications and external category/feed identities continue to work.
ALTER TABLE articles ADD COLUMN bibliography jsonb;
ALTER TABLE articles ADD COLUMN research_profile jsonb;
ALTER TABLE articles ADD COLUMN research_support jsonb;
ALTER TABLE articles ADD COLUMN research_revision integer;
ALTER TABLE articles ADD COLUMN canonical_article_id text REFERENCES articles(id);
ALTER TABLE article_discoveries ADD COLUMN source_url text;
ALTER TABLE articles ADD COLUMN research_enriched_at timestamptz;
ALTER TABLE articles ADD COLUMN research_retry_at timestamptz;
ALTER TABLE articles ADD COLUMN research_backfill_attempted_at timestamptz;
ALTER TABLE publications ADD COLUMN research jsonb;
CREATE INDEX publications_research_idx ON publications USING gin (research jsonb_path_ops) WHERE eligible AND visibility = 'public';
CREATE INDEX articles_research_doi_idx ON articles ((bibliography->>'doi')) WHERE bibliography->>'doi' IS NOT NULL;
CREATE INDEX articles_research_pending_idx ON articles (research_enriched_at, discovered_at) WHERE research_enriched_at IS NULL;
