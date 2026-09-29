-- 002 (EXPAND): rename tenants.name -> tenants.display_name, zero downtime.
-- Old app code still writes "name". New app code writes "display_name".
-- A trigger keeps both columns in sync, so BOTH app versions work.
ALTER TABLE tenants ADD COLUMN display_name TEXT;

CREATE FUNCTION tenants_sync_display_name() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.display_name := COALESCE(NEW.display_name, NEW.name);
    NEW.name := COALESCE(NEW.name, NEW.display_name);
  ELSIF NEW.name IS DISTINCT FROM OLD.name AND NEW.display_name IS NOT DISTINCT FROM OLD.display_name THEN
    NEW.display_name := NEW.name;           -- old app changed "name"
  ELSIF NEW.display_name IS DISTINCT FROM OLD.display_name AND NEW.name IS NOT DISTINCT FROM OLD.name THEN
    NEW.name := NEW.display_name;           -- new app changed "display_name"
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER tenants_sync_display_name
  BEFORE INSERT OR UPDATE ON tenants
  FOR EACH ROW EXECUTE FUNCTION tenants_sync_display_name();
