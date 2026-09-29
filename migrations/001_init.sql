-- 001: Initial multi-tenant schema.
-- Runs as the ADMIN user. The app connects as "flowlite_app",
-- which is restricted by Row-Level Security (RLS).

-- ===== App database user (not a superuser, so RLS applies to it) =====
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'flowlite_app') THEN
    CREATE ROLE flowlite_app LOGIN PASSWORD 'flowlite_app';
  END IF;
END $$;

-- ===== Tenants (clinics) =====
CREATE TABLE tenants (
  id                    TEXT PRIMARY KEY,
  name                  TEXT NOT NULL,
  api_key               TEXT NOT NULL UNIQUE,
  rate_limit_per_minute INT  NOT NULL DEFAULT 1000,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ===== Scenario 1: Idempotency (provider level, not per tenant) =====
CREATE TABLE processed_events (
  event_id    TEXT PRIMARY KEY,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE payments (
  id         SERIAL PRIMARY KEY,
  event_id   TEXT NOT NULL UNIQUE REFERENCES processed_events(event_id),
  order_id   TEXT NOT NULL,
  amount     NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ===== Scenario 2-3: Orders + saga (per tenant) =====
CREATE TABLE inventory (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  sku       TEXT NOT NULL,
  stock     INT  NOT NULL CHECK (stock >= 0),
  PRIMARY KEY (tenant_id, sku)
);

CREATE TABLE orders (
  id             SERIAL PRIMARY KEY,
  tenant_id      TEXT NOT NULL REFERENCES tenants(id),
  sku            TEXT NOT NULL,
  qty            INT  NOT NULL CHECK (qty > 0),
  amount         NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
  status         TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'needs_attention')),
  failed_step    TEXT,
  simulate_fail  TEXT,
  simulate_crash TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX orders_tenant_status ON orders (tenant_id, status);

CREATE TABLE charges (
  order_id  INT PRIMARY KEY REFERENCES orders(id),
  tenant_id TEXT NOT NULL,
  amount    NUMERIC(12, 2) NOT NULL,
  status    TEXT NOT NULL
);

CREATE TABLE shipments (
  order_id   INT PRIMARY KEY REFERENCES orders(id),
  tenant_id  TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE saga_log (
  id         SERIAL PRIMARY KEY,
  tenant_id  TEXT NOT NULL,
  order_id   INT  NOT NULL REFERENCES orders(id),
  step       TEXT NOT NULL,
  status     TEXT NOT NULL,
  error      TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- A step can be "done" (or "compensated") only ONCE per order.
CREATE UNIQUE INDEX saga_log_once ON saga_log (order_id, step, status);

-- ===== Scenario 4: Reports (per tenant) =====
CREATE TABLE reports (
  slot       TIMESTAMPTZ NOT NULL,
  tenant_id  TEXT NOT NULL REFERENCES tenants(id),
  orders     INT  NOT NULL,
  completed  INT  NOT NULL,
  revenue    NUMERIC(12, 2) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (slot, tenant_id)
);

-- ===== Row-Level Security: each query sees only ONE tenant =====
-- The app sets the tenant per transaction: set_config('app.tenant_id', ..., true)
-- Not set -> current_setting(..., true) is NULL/empty -> no rows visible.
ALTER TABLE inventory ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders    ENABLE ROW LEVEL SECURITY;
ALTER TABLE charges   ENABLE ROW LEVEL SECURITY;
ALTER TABLE shipments ENABLE ROW LEVEL SECURITY;
ALTER TABLE saga_log  ENABLE ROW LEVEL SECURITY;
ALTER TABLE reports   ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON inventory
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation ON orders
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation ON charges
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation ON shipments
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation ON saga_log
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation ON reports
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

-- ===== Permissions for the app user =====
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO flowlite_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO flowlite_app;
REVOKE ALL ON schema_migrations FROM flowlite_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO flowlite_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO flowlite_app;

-- ===== Demo data =====
-- "tiny" has a very low rate limit, to test noisy-neighbour protection.
INSERT INTO tenants (id, name, api_key, rate_limit_per_minute) VALUES
  ('amina',  'Dr. Amina Clinic',    'demo-key-amina',  1000),
  ('berlin', 'Berlin Chest Center', 'demo-key-berlin', 1000),
  ('tiny',   'Tiny Test Clinic',    'demo-key-tiny',   5);

-- xray-scan = AI analysis slots. ct-scan = only 5 (to test "out of stock").
INSERT INTO inventory (tenant_id, sku, stock) VALUES
  ('amina',  'xray-scan', 1000), ('amina',  'ct-scan', 5),
  ('berlin', 'xray-scan', 1000), ('berlin', 'ct-scan', 5),
  ('tiny',   'xray-scan', 10);
