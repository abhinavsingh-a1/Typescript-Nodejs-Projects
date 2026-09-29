-- 004 (CONTRACT): run ONLY after every app instance uses "display_name".
DROP TRIGGER tenants_sync_display_name ON tenants;
DROP FUNCTION tenants_sync_display_name();
ALTER TABLE tenants ALTER COLUMN display_name SET NOT NULL;
ALTER TABLE tenants DROP COLUMN name;
