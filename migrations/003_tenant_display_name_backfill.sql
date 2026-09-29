-- 003 (MIGRATE): copy old values into the new column.
-- Small table -> one UPDATE. Big table in production -> batches of ~1000 rows.
UPDATE tenants SET display_name = name WHERE display_name IS NULL;
