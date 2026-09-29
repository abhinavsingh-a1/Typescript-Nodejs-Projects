# RFC 0003: Single and distributed execution modes

**Status:** Accepted

## Problem
Two kinds of users:
- **Small / self-hosted:** one server, wants one process, no Redis to operate.
- **Cloud / large:** many clinics, needs several workers and schedulers, horizontal scaling.

Maintaining two code bases is not an option.

## Decision
One code base. Everything that differs between modes sits behind **four interfaces** in `types.ts`:

| Interface | `MODE=single` | `MODE=distributed` |
|---|---|---|
| `JobQueue` | In-memory queue, in the API process | BullMQ on Redis, separate `worker` processes |
| `EventBus` | Node `EventEmitter` | Redis pub/sub |
| `Lock` | In-memory map | Redis `SET NX PX` |
| `Counter` | In-memory map | Redis `INCR` + `EXPIRE` |

`getRuntime()` picks the implementation from `MODE`. No other file checks the mode, except entry points
(`server.ts` runs the worker + scheduler in-process when `single`).

**Durability does not depend on the queue.** Order state and `saga_log` live in Postgres.
- Distributed: a crashed worker's job lock expires; another worker resumes it.
- Single: on startup, `recoverUnfinishedOrders()` re-queues `pending` / `processing` orders; `runSaga` skips finished steps.

## Trade-offs
- Single mode = one process: a crash stops the API until restart (acceptable for small installs; use a process manager).
- The in-memory queue is lost on crash; recovery rebuilds it from the database.
- Distributed mode: an order row can be committed but the enqueue can fail (DB and Redis are not one transaction). Today the client gets an error and can retry. Future: **outbox pattern** (write the job to an `outbox` table in the same transaction; a relay publishes it).
- Both modes must be tested: CI runs `test:single` next to the distributed tests.

## Consequences
- New infrastructure (e.g. SQS instead of Redis) = one new implementation of the interfaces.
- Configuration is one variable: `MODE`.
