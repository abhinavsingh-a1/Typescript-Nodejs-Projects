# RFC 0001: Durable execution with sagas

**Status:** Accepted

## Problem
An order touches three systems: capacity (reserve a slot), payments (charge), delivery (report).
There is no single transaction across them. A step can fail, or the process can crash between steps.
We must never: charge twice, lose an order, or leave a slot reserved for a failed order.

## Options
| Option | Pros | Cons |
|---|---|---|
| Two-phase commit (2PC) | Strong consistency | External systems rarely support it; blocking coordinator |
| Retry the whole order | Simple | Repeats side effects (double charge) |
| **Saga + durable step log** | Works with any system; resumable | Needs an undo per step; temporary inconsistency |
| Workflow engine (Temporal) | Very powerful | Big new dependency; hides the concepts this project demonstrates |
| Event sourcing | Full history, replay | More complex reads and schema evolution |

## Decision
Saga orchestrated by `runSaga`, with progress stored in `saga_log` in Postgres.

1. Each step has `run` and `compensate` (enforced by the `SagaStep` type).
2. **Step work and its log row are committed in one transaction.** A crash can never leave a step half-recorded.
3. **Unique index `(order_id, step, status)`** makes each transition happen at most once, even when two workers race.
4. On restart, `runSaga` reads the log and skips finished steps.
5. On failure, finished steps are compensated in reverse order. If compensation fails: `needs_attention`.

## Trade-offs
- Steps that call **external** systems still need their own idempotency keys (the DB transaction cannot roll back an external call). In this demo all steps are local.
- Between steps the system is temporarily inconsistent (e.g. slot reserved, not yet charged). Acceptable for this domain.
- One extra DB round trip per step.

## Consequences
- Adding a step = one object with `run` + `compensate`. TypeScript rejects a step without an undo.
- Crash recovery works the same in both runtime modes (see RFC 0003).
