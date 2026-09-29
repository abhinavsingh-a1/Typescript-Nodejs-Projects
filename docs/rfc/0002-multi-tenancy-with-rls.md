# RFC 0002: Multi-tenancy with Postgres Row-Level Security

**Status:** Accepted

## Problem
Many clinics (tenants) use one system. A clinic must **never** see or change another clinic's data,
and one very busy clinic must not slow down the others (noisy neighbour).

## Options
| Option | Isolation | Cost / complexity |
|---|---|---|
| Database per tenant | Strongest | Expensive; migrations × N; connection count explodes |
| Schema per tenant | Strong | Migrations × N; many tables |
| Shared tables + `WHERE tenant_id = ?` in code | Weak: one forgotten filter = data leak | Cheapest |
| **Shared tables + Row-Level Security** | Enforced by the database | Cheap; needs care with DB roles |

## Decision
Shared tables with a `tenant_id` column, protected by **Postgres RLS**.

- The app connects as `flowlite_app` (not a superuser, so RLS applies). Migrations use a separate admin user.
- Every tenant query runs in `withTenant(tenantId, …)`, which sets `app.tenant_id` **for that transaction only** (`set_config(..., true)`), so pooled connections never leak a tenant.
- Policy: `tenant_id = current_setting('app.tenant_id', true)`. No tenant set → no rows.
- Tenants authenticate with an `X-Api-Key` header.
- **Noisy neighbour:** per-tenant rate limit (fixed 1-minute window, counter in Redis or memory). Exceeded → `429` + `Retry-After`.
- Live WebSocket events are filtered by tenant.

## Trade-offs
- A forgotten `withTenant` fails **closed** (sees nothing), never open. Good default.
- Superusers bypass RLS. The app must never use the admin user.
- Cross-tenant jobs (metrics, reports, recovery) must loop over tenants.
- Demo API keys are stored in plain text. Production: store a hash, rotate keys, use short-lived tokens for WebSockets (not a query-string key).
- Fixed-window rate limiting allows short bursts at window edges. A token bucket would be smoother.

## Consequences
- `test:tenancy` proves isolation at the **database** level, not just the API.
- Adding a tenant table = add `tenant_id`, enable RLS, add the policy.
