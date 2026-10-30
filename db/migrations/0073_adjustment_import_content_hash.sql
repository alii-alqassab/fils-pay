-- Prevent applying the same parsed CSV more than once, including concurrent
-- uploads. NULL remains available for historical/import rows created before
-- content-based deduplication was introduced.
ALTER TABLE adjustment_imports
    ADD COLUMN content_hash TEXT;

CREATE UNIQUE INDEX adjustment_imports_content_hash_unique
    ON adjustment_imports (content_hash)
    WHERE content_hash IS NOT NULL;
