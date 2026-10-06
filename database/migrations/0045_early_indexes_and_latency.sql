-- Bibliographic indexes become readable before paid processing; historical public
-- rows keep an unknown first-public timestamp rather than fabricating past latency.
ALTER TABLE publications ADD COLUMN index_only boolean NOT NULL DEFAULT false;
ALTER TABLE publications ADD COLUMN first_public_at timestamptz;
ALTER TABLE publications ADD COLUMN first_public_tracking boolean NOT NULL DEFAULT false;
ALTER TABLE publications ALTER COLUMN first_public_tracking SET DEFAULT true;
CREATE INDEX publications_first_public_at_idx ON publications(first_public_at)
  WHERE first_public_at IS NOT NULL;
COMMENT ON COLUMN publications.first_public_at IS 'First known public availability; NULL for legacy rows without a trustworthy observation';
COMMENT ON COLUMN publications.index_only IS 'Checked source bibliographic index, research notes still pending; never automatically selected';
