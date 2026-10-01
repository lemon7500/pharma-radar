-- An additive source abstract keeps historical article bodies/revisions and translations intact.
ALTER TABLE articles ADD COLUMN research_abstract text;
ALTER TABLE articles ADD COLUMN research_source_url text;
