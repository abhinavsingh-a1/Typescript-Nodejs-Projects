# FlowLite – Project Guide

A mini workflow engine that runs tasks **safely, exactly once, even when things fail**.

| Scenario | Problem | Status |
|---|---|---|
| 1. Idempotency | Same payment arrives twice | ✅ Step 2 |
| 2. Saga | Step fails midway → undo earlier steps | ✅ Step 3 |
| 3. Crash recovery | Worker dies mid-job | ✅ Step 4 |
| 4. Cron lock | 5 servers, job must run once | ✅ Step 5 |

---

## Step 1 – Project Setup ✅

### Goal
Start the app and confirm it can talk to Postgres and Redis.

### Key words
- **Node.js** – runs JavaScript on your computer.
- **Postgres** – database. Our *notebook* (remembers task progress).
- **Redis** – fast memory store. Our *ticket line* (queue).
- **Docker** – runs Postgres and Redis without installing them.
- **Health check** – a URL that says "all systems OK".

### Files
| File | Purpose |
|---|---|
| `package.json` | Project info + libraries |
| `docker-compose.yml` | Starts Postgres (port 5433) and Redis (port 6380) |
| `.env.example` | Settings template |
| `src/config.js` | Reads settings |
| `src/db.js` | Postgres connection |
| `src/redis.js` | Redis connection |
| `src/server.js` | Web server + `/health` |

### Prerequisites
- Node.js 20+ → check: `node -v`
- Docker Desktop (running) → check: `docker -v`

### Run
```bash
docker compose up -d        # 1. start Postgres + Redis
cp .env.example .env        # 2. create settings (Windows: copy .env.example .env)
npm install                 # 3. install libraries
npm start                   # 4. start app
```

Expected:
```
FlowLite running on http://localhost:3000
```

### Test
Open a new terminal:
```bash
curl http://localhost:3000/health
```
Expected:
```json
{"status":"ok","db":"up","redis":"up"}
```
(Or open the URL in a browser.)

> **Windows PowerShell:** `curl` is a different tool there. Use `curl.exe` instead:
> ```powershell
> curl.exe http://localhost:3000/health
> ```

**Failure test:**
```bash
docker compose stop redis
curl http://localhost:3000/health   # → {"status":"error","db":"up","redis":"down"}
docker compose start redis
```

### Stop
- App: `Ctrl + C`
- Docker: `docker compose down`

### Troubleshooting
| Error | Fix |
|---|---|
| `Missing DATABASE_URL` | Run step 2 (create `.env`) |
| `ECONNREFUSED` | Docker not running → `docker compose up -d` |
| PowerShell "Security Warning" on `curl` | Use `curl.exe` instead of `curl` |
| `port is already allocated` | Change port in `docker-compose.yml` and `.env` |

---

## Step 2 – Scenario 1: Idempotency ✅

### Problem
Payment provider sends the **same event twice** (network retry). Naive app → customer charged twice.

### Solution
Every event has a unique **eventId** (like a receipt number).
Save it first. Already saved? → ignore.

### Key words
- **Idempotency** – doing it twice = same result as once.
- **Primary key** – database column that can never have duplicates.
- **Transaction** – several DB actions that succeed or fail *together* (`BEGIN` … `COMMIT` / `ROLLBACK`).
- **Race condition** – two requests at the same moment both think "not seen yet".

### How it works
```
POST /webhooks/payment  { eventId, orderId, amount }
        │
        ▼
BEGIN
INSERT eventId into processed_events  (ON CONFLICT DO NOTHING)
        │
   saved? ──no──► ROLLBACK → 200 "duplicate"
        │yes
        ▼
INSERT payment
COMMIT → 201 "processed"
```

**Why not "SELECT, then INSERT"?**
Two parallel requests can both SELECT "not found" → both pay. ❌
`INSERT … ON CONFLICT` checks and saves in **one atomic step**. The database guarantees only one wins. ✅

### New / changed files
| File | Purpose |
|---|---|
| `src/migrate.js` | Creates tables `processed_events`, `payments` |
| `src/routes/webhooks.js` | `POST /webhooks/payment` (idempotent) |
| `src/routes/payments.js` | `GET /payments` (view results) |
| `src/server.js` | Registers routes + error handler |
| `scripts/test-idempotency.js` | Automatic test |
| `package.json` | New scripts: `migrate`, `test:idempotency` |

### Run
```powershell
# stop running app first (Ctrl + C)
docker compose up -d
npm run migrate          # → Migration done: tables are ready.
npm start                # → FlowLite running on http://localhost:3000
```

### Test (automatic) – new terminal
```powershell
cd flowlite              # new terminals start in the parent folder!
npm run test:idempotency
```
Expected:
```
PASS  First request is processed (201)
PASS  Same event again is a duplicate (200)
PASS  Only 1 payment in database
PASS  5 parallel requests -> 1 processed, 4 duplicates
PASS  Only 1 payment in database

All tests PASSED.
```

### Test (manual) – PowerShell
```powershell
$body = '{"eventId":"evt_manual_1","orderId":"order_1","amount":500}'
Invoke-RestMethod -Method Post -Uri http://localhost:3000/webhooks/payment -ContentType 'application/json' -Body $body
# 1st time → status: processed
# 2nd time → status: duplicate

Invoke-RestMethod http://localhost:3000/payments
```

### See the database directly
```powershell
docker compose exec postgres psql -U flowlite -c "SELECT * FROM payments;"
```

### Interview answer (1 line)
> "I store the event ID with a unique constraint inside the same transaction as the payment, so duplicates — even concurrent ones — are rejected by the database."

### Troubleshooting
| Error | Fix |
|---|---|
| `ENOENT … package.json` | Wrong folder. `cd` into `flowlite` (folder with `package.json`). Check: `dir package.json` |
| `relation "payments" does not exist` | Run `npm run migrate` |
| `Could not reach the app` | Start app: `npm start` |
| `400 Body must be...` | Check JSON fields: `eventId`, `orderId`, `amount` (number) |

---

## Step 3 – Scenario 2: Saga ✅

### Problem
Order = 3 steps: **reserve stock → charge money → ship**.
Payment fails after stock is reserved → item blocked forever. ❌

### Solution
Every step has an **undo** (compensation).
A step fails → undo finished steps in **reverse order**. ✅

### Key words
- **Saga** – a chain of steps where each step has an undo.
- **Compensation** – the undo action (refund, put stock back).
- **Orchestrator** – the code that runs steps in order (`runSaga.js`).
- **Saga log** – a diary of every step: `done`, `failed`, `compensated`.

### The 3 steps
| Step | Do | Undo |
|---|---|---|
| `reserveStock` | stock − qty | stock + qty |
| `chargePayment` | charge = `charged` | charge = `refunded` |
| `createShipment` | create shipment | delete shipment |

### How it works
```
Payment fails:
reserveStock ✅ → chargePayment ❌ → undo reserveStock ↩️

Shipping fails:
reserveStock ✅ → chargePayment ✅ → createShipment ❌
               → undo chargePayment ↩️ → undo reserveStock ↩️
```

**Why reverse order?** Undo the newest thing first, like taking off shoes before socks.

### Order status
| Status | Meaning |
|---|---|
| `completed` | All steps done |
| `failed` | A step failed, everything undone |
| `needs_attention` | An **undo** also failed → a human must check |

### New / changed files
| File | Purpose |
|---|---|
| `src/saga/runSaga.js` | Generic saga runner (reusable) |
| `src/saga/orderSteps.js` | The 3 order steps + undos |
| `src/routes/orders.js` | `POST /orders`, `GET /orders/:id` |
| `src/routes/inventory.js` | `GET /inventory`, `GET /inventory/:sku` |
| `src/migrate.js` | New tables + demo products (`book`, `laptop`) |
| `scripts/test-saga.js` | Automatic test |

**Failure simulation:** send `"simulateFail": "payment"` or `"shipping"` to force a failure.

### Run
```powershell
# Ctrl + C to stop the app first
npm run migrate
npm start
```

### Test (automatic) – new terminal
```powershell
npm run test:saga
```
Expected: all lines `PASS`, then `All tests PASSED.`

### Test (manual) – PowerShell
```powershell
Invoke-RestMethod http://localhost:3000/inventory

$body = '{"sku":"book","qty":1,"amount":20,"simulateFail":"shipping"}'
Invoke-RestMethod -Method Post -Uri http://localhost:3000/orders -ContentType 'application/json' -Body $body -SkipHttpErrorCheck
# (Windows PowerShell 5: remove -SkipHttpErrorCheck; a failed order shows as a 422 error — that is expected)

Invoke-RestMethod http://localhost:3000/orders/1
```

### See the diary directly
```powershell
docker compose exec postgres psql -U flowlite -c "SELECT order_id, step, status FROM saga_log ORDER BY id DESC LIMIT 10;"
```

### Interview answer (1 line)
> "Each step has a compensating action; on failure the orchestrator runs compensations in reverse order and logs every transition, so the system always ends in a consistent state or is flagged for manual review."

### Troubleshooting
| Error | Fix |
|---|---|
| `relation "orders" does not exist` | Run `npm run migrate` |
| Stock test fails | Run tests one at a time (not in parallel) |
| `422` on manual test | Expected when `simulateFail` is used |

---

## Step 4 – Scenario 3: Crash Recovery ✅

### Problem
A worker (cook) dies in the middle of an order.
Order lost? Or restarted from zero → stock reserved **twice**? ❌

### Solution
1. Orders go into a **queue**. **Workers** take them.
2. After each step, progress is saved in `saga_log`.
3. Worker dies → its job **lock expires** → another worker takes the job.
4. New worker reads `saga_log` → **skips finished steps** → continues. ✅

### Key words
- **Queue (BullMQ)** – list of jobs waiting in Redis.
- **Worker** – separate program that processes jobs. Run many copies.
- **Lock** – "this job is mine". Renewed every few seconds while the worker is alive.
- **Stalled job** – lock expired because the owner died. It gets put back in the queue.
- **Durable execution** – progress is saved, so work can resume after a crash.
- **Atomic step** – step work + its log line saved in **one transaction**. Both or neither.

### How it works
```
POST /orders/async ──► queue ──► Worker A
                                   reserveStock ✅ (saved)
                                   💥 crash
                        lock expires (~10s)
                                   │
                        queue ──► Worker B
                                   reads saga_log
                                   reserveStock ⏭️ skip (already done)
                                   chargePayment ✅
                                   createShipment ✅ → completed
```

### Two safety rules (important!)
1. **Step + log in one transaction.** A crash can never leave "stock reduced but not logged".
2. **Unique index on `saga_log (order_id, step, status)`.** A step can be `done` only once, even if 2 workers try at the same time. (Same idea as Step 2!)

### Timing settings (`src/worker.js`)
| Setting | Value | Meaning |
|---|---|---|
| `lockDuration` | 10s | Job ownership time (auto-renewed while alive) |
| `stalledInterval` | 5s | How often workers look for dead jobs |
| `maxStalledCount` | 2 | Give up after 2 crashes on the same job |
| `attempts` | 3 | Retries on normal errors (e.g. DB briefly down) |

### New / changed files
| File | Purpose |
|---|---|
| `src/queue.js` | BullMQ queue + `enqueueOrder()` |
| `src/worker.js` | Worker program (`npm run worker`) |
| `src/saga/runSaga.js` | Now **durable**: resumes from `saga_log` |
| `src/saga/processOrder.js` | Runs one order (used by API + worker) |
| `src/saga/orderSteps.js` | Steps now use the transaction (`db`) |
| `src/routes/orders.js` | New `POST /orders/async` |
| `src/migrate.js` | Unique index + demo columns |
| `scripts/test-crash.js` | Automatic test (starts 2 workers itself) |
| `package.json` | New library `bullmq`, scripts `worker`, `test:crash` |

**Crash simulation:** `"simulateCrash": "afterReserve"` → worker exits right after `reserveStock` (only first time).

### Run
```powershell
# Ctrl + C to stop the app first
npm install              # new library: bullmq
npm run migrate
npm start
```

### Test (automatic) – new terminal
```powershell
npm run test:crash
```
Expected (worker lines like `A | [worker-1234] ...` also appear):
```
PASS  2 workers ready
--- Test 1: order via queue ---
PASS  Order completed by a worker
PASS  Stock reduced by 1
--- Test 2: worker crashes mid-order ---
PASS  One worker crashed
PASS  Order still completed
PASS  Resumed: each step done exactly once
PASS  Stock reduced by 1 (not 2)
PASS  Money charged once
PASS  Shipment created

All tests PASSED.
```
Test 2 waits ~10–15 seconds (lock expiry). Normal.

**Old tests still work:**
```powershell
npm run test:idempotency
npm run test:saga
```

### Test (manual) – see it with your eyes
Terminal 2 and 3:
```powershell
npm run worker
```
Terminal 4:
```powershell
$body = '{"sku":"book","qty":1,"amount":20,"simulateCrash":"afterReserve"}'
Invoke-RestMethod -Method Post -Uri http://localhost:3000/orders/async -ContentType 'application/json' -Body $body
```
Watch: one worker prints `💥 simulated crash!`, the other finishes the order ~10s later.
Check: `Invoke-RestMethod http://localhost:3000/orders/<orderId>`

### Interview answer (1 line)
> "Jobs are leased with a lock; if a worker dies, the lock expires and another worker picks the job up. Each step and its progress record are committed in one transaction with a unique constraint, so resumed work never repeats a step."

### Troubleshooting
| Error | Fix |
|---|---|
| `Cannot find package 'bullmq'` | Run `npm install` |
| `Is the API running?` | Start API: `npm start` |
| `0 ready` workers | Redis down → `docker compose up -d` |
| Order stuck `processing` > 60s | Stop all workers, start one: `npm run worker` |

---

## Step 5 – Scenario 4: Cron Lock ✅

### Problem
A "daily report" email runs on a timer.
The app runs on **3 servers** → all 3 wake up → boss gets **3 emails**. ❌

### Solution
Before running, each server tries to grab a **lock** in Redis.
Only the first one gets it → runs. Others → skip. ✅

### Key words
- **Cron job** – a task that runs on a schedule (every day, every hour…).
- **Distributed lock** – a "key" shared by all servers. Only one can hold it.
- **Slot** – the scheduled time of one run (e.g. `09:00:00`).
- **`SET key value NX PX ttl`** – Redis command: save *only if it doesn't exist* (NX), auto-delete after `ttl` ms (PX).

### How it works
```
09:00:00  Server A ─┐
09:00:00  Server B ─┼─► Redis: SET lock:report:<slot> NX
09:00:00  Server C ─┘
                       A → "OK"  → sends email 📧
                       B → null  → skip
                       C → null  → skip
```

### Why one lock key **per slot**?
Simple lock `lock:report` + delete when done → A finishes in 50 ms, deletes lock, B (a bit late) grabs it → **2 emails**. ❌
Key `lock:report:<slot>` is never reused → a late server still sees "taken". ✅
The TTL deletes old keys automatically.

### Extra safety
- Redis down → **skip** (better no email than two).
- `reports.slot` is a **primary key** → database also blocks a 2nd row.

### New / changed files
| File | Purpose |
|---|---|
| `src/scheduler.js` | Timer + Redis lock + report job (`npm run scheduler`) |
| `src/migrate.js` | New table `reports` |
| `scripts/test-cron.js` | Automatic test (starts 3 schedulers itself) |

**Settings (env variables):**
| Variable | Default | Meaning |
|---|---|---|
| `REPORT_INTERVAL_SECONDS` | 60 | How often. Daily = 86400 |
| `USE_LOCK` | true | `false` = see the problem |
| `INSTANCE_NAME` | `scheduler-<pid>` | Name in logs |

### Run
```powershell
npm run migrate
```
(API not needed for this test. Docker must be running.)

### Test (automatic)
```powershell
npm run test:cron
```
Expected (~25 seconds):
```
--- Round 1: 3 servers, lock OFF (shows the problem) ---
   [A] slot 12:00:03 -> EMAIL SENT ...
   [B] slot 12:00:03 -> EMAIL SENT ...
   [C] slot 12:00:03 -> EMAIL SENT ...
PASS  Problem shown: same report sent up to 3 times

--- Round 2: 3 servers, lock ON (the fix) ---
   [B] slot 12:00:18 -> EMAIL SENT ...
   [A] slot 12:00:18 -> skipped (another instance has the lock)
   [C] slot 12:00:18 -> skipped (another instance has the lock)
PASS  At least 3 slots ran
PASS  Every slot sent exactly 1 email
PASS  1 report row per slot in database

All tests PASSED.
```
(Round 1 "PASS" = problem shown successfully.)

### Test (manual) – 3 terminals
```powershell
$env:REPORT_INTERVAL_SECONDS=10; $env:INSTANCE_NAME="A"; npm run scheduler
```
Terminals 2 and 3: same, with `"B"` and `"C"`. Watch: each slot → 1 `EMAIL SENT`, 2 `skipped`.
Add `$env:USE_LOCK="false";` to see duplicates.

### See the database
```powershell
docker compose exec postgres psql -U flowlite -c "SELECT slot, instance, orders, revenue FROM reports ORDER BY slot DESC LIMIT 5;"
```

### Interview answer (1 line)
> "Every instance fires on schedule, but each run first does an atomic `SET NX` on a slot-specific Redis key with a TTL; only the winner executes, and a unique slot column in Postgres is a second safety net."

> Bonus: "In production you could also use BullMQ job schedulers or a single leader-elected scheduler."

### Troubleshooting
| Error | Fix |
|---|---|
| `relation "reports" does not exist` | `npm run migrate` |
| `only 0 of 3 schedulers started` | `docker compose up -d` |
| Round 2: a slot with 2 emails | Should never happen → paste output |

---

## 🎉 Project Complete – Summary

| Scenario | Technique | Test |
|---|---|---|
| Duplicate webhook | Unique key + `ON CONFLICT` in a transaction | `npm run test:idempotency` |
| Failed order | Saga + reverse compensation | `npm run test:saga` |
| Worker crash | Queue lock + durable `saga_log` + atomic steps | `npm run test:crash` |
| Cron on many servers | Redis `SET NX` slot lock | `npm run test:cron` |

### Run everything (cheat sheet)
```powershell
docker compose up -d
npm install
npm run migrate
npm start                    # terminal 1: API
npm run test:idempotency     # terminal 2
npm run test:saga
npm run test:crash
npm run test:cron
```

### Project structure
```
flowlite/
├── docker-compose.yml        Postgres + Redis
├── package.json
├── GUIDE.md                  this file
├── src/
│   ├── config.js  db.js  redis.js  queue.js
│   ├── server.js             API
│   ├── worker.js             queue worker
│   ├── scheduler.js          cron + lock
│   ├── migrate.js            tables
│   ├── routes/               webhooks, payments, orders, inventory
│   └── saga/                 runSaga, orderSteps, processOrder
└── scripts/                  4 automatic tests
```

---

## Step 6 – TypeScript + Observability + GitHub ✅

### Goal
Make the project **professional**: typed contracts, logs/metrics, CI, README.

### Part A – TypeScript (~10%)
TS only where **contracts** matter. The rest stays JavaScript.

| File | Why TypeScript here |
|---|---|
| `src/types.ts` | One source of truth: order statuses, step contract, job data |
| `src/saga/runSaga.ts` | Core engine. A bug here breaks every order |
| `src/saga/orderSteps.ts` | Every step **must** have `run` + `compensate` |
| `src/queue.ts` | API (producer) and worker (consumer) share the same job type |

- **tsx** – runs `.ts` files directly. No build step. (`npm start` now uses it.)
- **`npm run typecheck`** – finds type errors without running the app.
- JS files still import `./runSaga.js` → tsx finds `runSaga.ts` automatically.

Try it: in `orderSteps.ts`, delete a `compensate` function → `npm run typecheck` → error. ✅ Put it back.

### Part B – Observability
"Can I see what the system is doing?"

| Pillar | Tool | Where |
|---|---|---|
| **Logs** | pino (structured) | Terminal. Each line has fields: `service`, `orderId`, `step`… |
| **Request ID** | `X-Request-Id` header | Find all logs of one request |
| **Metrics** | prom-client | `http://localhost:3000/metrics` |
| **Dashboard** | Prometheus (optional) | `http://localhost:9090` |

Key words:
- **Structured log** – log as data (`{"orderId":42,"step":"reserveStock"}`), not just text. Searchable.
- **Metric** – a number over time (requests/sec, orders by status).
- **RED metrics** – **R**ate, **E**rrors, **D**uration of requests.
- **Label** – metric dimension, e.g. `status="500"`. Use `/orders/:id`, never `/orders/42` (too many labels).

Log format (`.env`):
```
LOG_FORMAT=pretty   # easy to read (default)
LOG_FORMAT=json     # for tools / production
```

### Part C – GitHub-ready
| File | Purpose |
|---|---|
| `README.md` | Project page: problems solved, diagrams, how to run |
| `LICENSE` | MIT (put your name in it) |
| `.github/workflows/ci.yml` | Runs typecheck + all tests on every push |
| `.nvmrc` | Node version |
| `monitoring/prometheus.yml` | Prometheus config |

### Update your project
**Important:** 3 old JS files are now TS. Delete them first:
```powershell
Remove-Item src\saga\runSaga.js, src\saga\orderSteps.js, src\queue.js -ErrorAction SilentlyContinue
```
Then extract the zip over your `flowlite` folder.

### Run
```powershell
# Ctrl + C to stop the app first
npm install
npm run typecheck        # → no output = OK
npm run migrate
npm start                # colored logs now
```

### Test – new terminal
```powershell
npm run test:all
```
Expected: 5 test groups, each ending with `All tests PASSED.` (~1 minute)

Only the new test:
```powershell
npm run test:observability
```

See metrics:
```powershell
curl.exe http://localhost:3000/metrics
```

Optional Prometheus UI:
```powershell
docker compose --profile monitoring up -d
```
Open `http://localhost:9090` → query `flowlite_orders` → **Execute**.

### Push to GitHub
1. Replace `YOUR_USER` in `README.md` and `YOUR NAME` in `LICENSE`.
2. Create an **empty** repo `flowlite` on github.com (no README).
3. Run:
```powershell
git init
git add .
git commit -m "FlowLite: idempotency, saga, crash recovery, cron lock"
git branch -M main
git remote add origin https://github.com/YOUR_USER/flowlite.git
git push -u origin main
```
4. GitHub → **Actions** tab → CI should turn green ✅ (~2 min).

Check before pushing: `.env` must **not** be in `git status` (it's ignored). `package-lock.json` **must** be committed (CI needs it).

### Interview answer (1 line)
> "I use TypeScript for the contracts between components, structured logs with request IDs for tracing, and RED metrics plus DB-backed business gauges in Prometheus, all verified by CI against real Postgres and Redis."

### Troubleshooting
| Error | Fix |
|---|---|
| `Cannot find module ... runSaga.js` | Old/new file mix → delete old files (command above), extract again |
| `tsx is not recognized` | `npm install` |
| `npm ci` fails in CI | Commit `package-lock.json` |
| Prometheus target `DOWN` | API must run on port 3000; Docker Desktop updated |
| Logs unreadable | Set `LOG_FORMAT=pretty` in `.env` |

---

## Step 7 – Demo GIF ✅

`docs/demo-crash.gif` shows the crash test (Scenario 3) in ~20 seconds. The README displays it at the top.

**Note:** it is a *rendered* animation of the real test output. A **real screen recording** is even more convincing. How to make one (Windows):

1. Install **ScreenToGif** (free): `winget install NickeManarin.ScreenToGif`
2. Start API: `npm start`. Open a 2nd terminal, make it large, font ≥ 14.
3. ScreenToGif → **Recorder** → frame the terminal → **Record**.
4. Run `npm run test:crash`. Stop when `All tests PASSED.` appears.
5. Editor → delete dead frames → **Save as** → GIF → `docs/demo-crash.gif` (replace).
6. Push:
```powershell
git add docs/demo-crash.gif README.md
git commit -m "Add demo GIF"
git push
```
Tip: keep it < 5 MB and < 30 s.
---

## 📖 The Whole Project as One Story

### Meet "BookBazaar" 📚
Riya runs an **online bookshop**. FlowLite is the system behind her shop.
Let's follow **one busy day**.

| Shop world | FlowLite |
|---|---|
| Shop counter | **API** (`server.js`) |
| Notebook of records | **Postgres** |
| Ticket line on the wall | **Redis queue** (BullMQ) |
| Packers in the back room | **Workers** (`worker.js`) |
| Alarm clock | **Scheduler** (`scheduler.js`) |

---

### 🌅 8:00 AM – Opening the shop → *Health check*
Riya checks: lights on? Notebook on the desk?
FlowLite asks: Postgres up? Redis up?
`GET /health` → `{"status":"ok","db":"up","redis":"up"}`

---

### 💳 10:00 AM – Aman pays twice? → *Idempotency*
Aman pays ₹500. The bank sends "payment received" — **twice** (network glitch).

- 1st message, receipt `evt_001` → new → **payment saved** ✅
- 2nd message, `evt_001` again → "already seen" → **ignored** ✅

Aman is charged **once**.
📁 `routes/webhooks.js` · ▶️ `npm run test:idempotency`

---

### 📦 11:00 AM – Ordering a book → *Saga*
An order has 3 steps. Each step has an **undo**:

| Step | Do | Undo |
|---|---|---|
| 1 | Keep book aside | Put book back |
| 2 | Take money | Refund |
| 3 | Book courier | Cancel courier |

**Story A – All good:** 1 ✅ 2 ✅ 3 ✅ → order `completed`.
**Story B – Card declined:** 1 ✅ 2 ❌ → put book back ↩️ → `failed`.
**Story C – Courier down:** 1 ✅ 2 ✅ 3 ❌ → refund ↩️ → put book back ↩️ → `failed`.
**Story D – Out of stock:** 1 ❌ → nothing to undo → `failed`.

No money is taken without a book. No book stuck forever.
📁 `saga/orderSteps.ts`, `saga/runSaga.ts` · ▶️ `npm run test:saga`

---

### 🔥 2:00 PM – Festival rush + a packer faints → *Queue, workers, crash recovery*
100 orders arrive. The counter can't pack them all, so:

1. Each order becomes a **ticket in the line** (queue). Customer hears "received ✅" immediately.
2. Two packers, **A** and **B**, take tickets one by one.
3. After every step, the packer **writes it in the notebook** (`saga_log`).

Packer A keeps a book aside, writes "step 1 done"… and **faints** 💥.
- A's ticket had a 10-second "mine" tag (**lock**). A can't renew it.
- Tag expires → ticket goes back to the line.
- Packer B takes it, reads the notebook: "step 1 done" → **skips it** → does steps 2 and 3.

Book kept aside **once**, not twice. Order still `completed`.
📁 `queue.ts`, `worker.js` · ▶️ `npm run test:crash`

---

### ⏰ 9:00 PM – Daily sales report → *Cron lock*
Riya has **3 branch computers**. Each has an alarm: "send the sales report at 9 PM".

- Without lock: 3 alarms → Riya gets **3 emails** ❌
- With lock: all 3 grab for **one key** named "9 PM report". Only the fastest gets it → **1 email** ✅. The others: "taken, skip".

Tomorrow's 9 PM report has a **new key**, so it runs again (once).
📁 `scheduler.js` · ▶️ `npm run test:cron`

---

### 📋 All day – Rules every packer must follow → *TypeScript*
Riya prints a **checklist form**: every step MUST have "do" and "undo". An order status can ONLY be `pending / processing / completed / failed / needs_attention`.
Someone forgets the "undo" box → form rejected **before** work starts.
📁 `types.ts` · ▶️ `npm run typecheck`

---

### 📹 All day – Watching the shop → *Observability*
| Shop | FlowLite |
|---|---|
| CCTV recording | **Logs** – every action written with details (`orderId`, `step`) |
| Token number for each customer | **Request ID** – follow one customer's whole visit in the logs |
| Scoreboard: orders today, errors, speed | **Metrics** – `GET /metrics` |
| Big TV showing the scoreboard | **Prometheus** – `http://localhost:9090` |

Something goes wrong? Riya **sees it** instead of guessing.
📁 `logger.js`, `metrics.js` · ▶️ `npm run test:observability`

---

### 🧪 Every night – Fire drills + inspector → *Tests + CI*
- **Tests** = fire drills: fake double payments, fake crashes, 3 alarms at once. Check the shop survives.
- **CI (GitHub Actions)** = inspector: every time someone changes the shop, all drills run automatically. Any fail → change rejected.

▶️ `npm run test:all` · 📁 `.github/workflows/ci.yml`

---

### 🗺️ Cheat map
| Story moment | Problem | Solution | File |
|---|---|---|---|
| Bank sends twice | Double charge | Idempotency | `routes/webhooks.js` |
| Card declined | Book stuck | Saga + undo | `saga/*` |
| Packer faints | Lost / repeated work | Queue + lock + notebook | `worker.js`, `queue.ts` |
| 3 alarms at 9 PM | 3 emails | Redis lock per slot | `scheduler.js` |
| Forgotten "undo" | Broken step | TypeScript contract | `types.ts` |
| "What's happening?" | Blind system | Logs + metrics | `logger.js`, `metrics.js` |
| Someone changes code | New bugs | Tests + CI | `scripts/`, `ci.yml` |

---

## Real-World Story: "TBScan AI" 🩻

A story that explains **every feature** of FlowLite using one business.

### The business
**TBScan AI** is a startup. It sells a **machine-learning service** that looks at a chest X-ray and predicts the **risk of tuberculosis (TB)**.

- **Customer:** Dr. Amina's clinic.
- **Product:** 1 X-ray analysis = **€5**.
- **How it works:** the clinic uploads an X-ray → the AI model analyzes it → the clinic gets a report ("TB risk: high, 87%").

> Note: in real life the AI only **supports** the doctor; the doctor makes the diagnosis. A real medical AI product also needs medical-device approval and GDPR-safe patient data.

### Project word → Story word
| FlowLite | TBScan AI |
|---|---|
| `inventory` (stock) | Free **AI analysis slots** (GPU capacity) |
| `order` | One **X-ray scan request** |
| `reserveStock` | Reserve an AI slot |
| `chargePayment` | Charge the clinic €5 |
| `createShipment` | Deliver the TB report |
| `webhook` | Payment company says "clinic paid" |
| `worker` | AI server that runs the model |
| `scheduler` | Daily summary email |
| `/metrics`, logs | Control room screens |

---

### Chapter 1 – Buying credits (Idempotency)
Dr. Amina buys a **100-scan pack** for €500. The payment company (Stripe) sends TBScan a message: *"Payment evt_777 received"*.
Internet glitch → Stripe sends the **same message again**.

- ❌ Without FlowLite: clinic gets 200 credits, or is charged twice.
- ✅ With FlowLite: `evt_777` is saved once. The second message → **"duplicate, ignored"**.

📁 `routes/webhooks.js` · 🧪 `npm run test:idempotency`

---

### Chapter 2 – A scan that fails halfway (Saga)
The clinic uploads Ravi's X-ray. FlowLite does 3 steps:
1. **Reserve an AI slot**
2. **Charge €5**
3. **Deliver the report**

Step 3 fails: the report server is down.

- ❌ Without FlowLite: clinic paid €5, slot is blocked, no report.
- ✅ With FlowLite: automatic **undo in reverse**: refund €5 ↩️ → free the slot ↩️. Status: `failed`. Clinic can retry, nothing lost.

If even the **refund** fails → status `needs_attention` → a human checks.

📁 `saga/orderSteps.ts`, `saga/runSaga.ts` · 🧪 `npm run test:saga`

---

### Chapter 3 – The AI server crashes (Crash recovery)
Monday morning: 300 X-rays arrive. They wait in the **queue** (the waiting line). 2 AI servers (workers) take them one by one.

AI server A reserves a slot for Priya's X-ray… then **crashes** (out of memory). 💥

- ❌ Without FlowLite: Priya's scan is lost, or restarted → slot reserved **twice**, clinic charged twice.
- ✅ With FlowLite: server A's lock expires (~10 s) → server B takes the job → reads the diary (`saga_log`) → "slot already reserved" → **skips it** → charges once → delivers the report.

Priya's doctor gets the report 10 seconds late. Nobody notices a problem. ✅

📁 `worker.js`, `queue.ts` · 🧪 `npm run test:crash`

---

### Chapter 4 – The daily email (Cron lock)
Every morning at 08:00, each clinic gets an email: *"Yesterday: 42 scans, 3 high-risk."*
TBScan runs on **3 servers** for safety. At 08:00 all 3 wake up.

- ❌ Without FlowLite: Dr. Amina gets **3 identical emails**. Looks unprofessional.
- ✅ With FlowLite: all 3 try to grab the lock `lock:report:08:00`. One wins → sends. Two skip. **1 email.**

📁 `scheduler.js` · 🧪 `npm run test:cron`

---

### Chapter 5 – Rules everyone must follow (TypeScript)
A new developer adds a 4th step: **"send SMS to patient"**. He forgets to write the undo.

- ❌ Plain JavaScript: nobody notices until a real failure.
- ✅ TypeScript: `npm run typecheck` fails immediately → *"compensate is missing"*. Bug caught before release.

📁 `types.ts` · 🧪 `npm run typecheck`

---

### Chapter 6 – The control room (Observability)
**Support call:** Dr. Amina says *"Ravi's scan failed!"*. She shares the request ID `a1b2-c3d4` from the error.
Support searches logs for `a1b2-c3d4` → sees every step of that request → *"report server was down, €5 refunded."* Solved in 2 minutes.

**Dashboard (`/metrics`):** the team sees live numbers:
| Metric | Story meaning |
|---|---|
| `flowlite_orders{status="completed"}` | Scans delivered |
| `flowlite_orders{status="needs_attention"}` | Scans a human must check |
| `flowlite_queue_jobs{state="waiting"}` | X-rays waiting → too many? add AI servers |
| `flowlite_http_requests_total{status="500"}` | Errors → something is broken |
| `flowlite_webhook_events_total{result="duplicate"}` | How often Stripe sends duplicates |

📁 `logger.js`, `metrics.js` · 🧪 `npm run test:observability`

---

### Chapter 7 – Safe updates (CI)
A developer changes the saga code and pushes to GitHub.
GitHub Actions runs **all tests automatically**: duplicate payments, crashes, 3 servers…
One test fails → code is **blocked** before clinics are affected. ✅

📁 `.github/workflows/ci.yml`

---

### A day at TBScan AI (summary)
| Time | Event | FlowLite feature |
|---|---|---|
| 07:00 | Clinic buys 100 credits, Stripe sends twice | Idempotency |
| 08:00 | 3 servers, 1 daily email | Cron lock |
| 09:00 | 300 X-rays queued | Queue + workers |
| 09:15 | AI server crashes, other continues | Crash recovery |
| 11:00 | Report server down → refund + free slot | Saga |
| 11:05 | Support finds problem by request ID | Logs |
| 11:10 | Dashboard shows queue growing → add a server | Metrics |
| 16:00 | New code tested automatically | CI |

**One sentence:** FlowLite makes sure every clinic is **charged once, gets every report, and gets one email**, even when networks, servers, and code fail.

---

## Step 7 – Closing the Job Gaps ✅

### Goal
Add what the n8n Staff job asked for and FlowLite was missing.

| # | Gap | What we built | Test |
|---|---|---|---|
| 1 | Strong TypeScript | **100% TypeScript** (src + tests) | `npm run typecheck` |
| 2 | Multi-tenancy | API keys, Postgres **RLS**, per-clinic **rate limit** | `test:tenancy` |
| 3 | RFCs / leadership | 3 design documents in `docs/rfc/` | read them |
| 4 | Configurable, cloud + self-hosted | `MODE=single` / `MODE=distributed` | `test:single` |
| 5 | Plugin platform | Workflow **nodes** (like n8n) | `test:plugins` |
| 6 | Zero-downtime migrations | Versioned SQL, expand → migrate → contract | `test:migrations` |
| 7 | Real-time | **WebSocket** live updates + `live.html` | `test:live` |

### ⚠️ What changed for you
- Every clinic route needs header **`X-Api-Key`** (e.g. `demo-key-amina`).
- Products renamed: `book` → **`xray-scan`**, `laptop` → **`ct-scan`**.
- New `.env` settings (MODE, two database users).
- Fresh database (old demo data is deleted).
- Manual commands in Steps 1–6 now need the key: add `-Headers @{ 'X-Api-Key' = 'demo-key-amina' }`.

### Update your project (PowerShell, inside `flowlite`)
```powershell
# 1. Stop API / workers (Ctrl + C), then:
docker compose down -v                      # delete old demo database
Remove-Item -Recurse -Force src, scripts    # old files (keeps .git, node_modules)
# 2. Extract the zip (it contains a "flowlite" folder, so copy its CONTENT):
Expand-Archive -Path "$HOME\Downloads\flowlite-step7.zip" -DestinationPath "$env:TEMP\fl7" -Force
Copy-Item -Recurse -Force "$env:TEMP\fl7\flowlite\*" .
Remove-Item -Recurse -Force "$env:TEMP\fl7"
Test-Path src\server.ts                     # must print True
Copy-Item .env.example .env -Force
docker compose up -d
npm install
npm run typecheck                           # no output = OK
npm run migrate                             # → applied 001 ... 004
npm start
```

### Test – new terminal
```powershell
npm run test:all
```
Expected: 10 test groups, each `All tests PASSED.` (~2–3 minutes).

---

### Part A – 100% TypeScript
- Every `.js` in `src/` and `scripts/` is now `.ts`. Run by **tsx**, no build step.
- `types.ts` = the rulebook: `Tenant`, `OrderStatus`, `SagaStep`, `NodePlugin`, `JobQueue`, `EventBus`, `Lock`, `Counter`.
- Try: in `plugins/delay.ts`, rename `execute` → `run` → `npm run typecheck` → error. Put it back.

### Part B – Multi-tenancy
**Tenant** = one customer (clinic). All clinics share the same tables.

| Protection | How | File |
|---|---|---|
| Who are you? | `X-Api-Key` header → tenant | `tenants.ts` |
| See only your data | **Row-Level Security**: Postgres adds `WHERE tenant_id = <you>` to every query | `001_init.sql`, `db.ts` |
| Fair share | Max requests per minute per clinic → `429 Too Many Requests` | `tenants.ts` |

Key words:
- **RLS** – a database rule that hides other tenants' rows. Even buggy code can't leak data.
- **`withTenant(id, …)`** – runs a transaction "as" one clinic.
- **Two DB users** – `flowlite` (admin, migrations only) and `flowlite_app` (the app, restricted by RLS).
- **Noisy neighbour** – one customer using so much that others get slow.

Try:
```powershell
$h = @{ 'X-Api-Key' = 'demo-key-amina' }
Invoke-RestMethod http://localhost:3000/tenants/me -Headers $h
Invoke-RestMethod http://localhost:3000/inventory -Headers $h
```

### Part C – RFCs
`docs/rfc/` = **why** we built it this way. Format: problem → options → decision → trade-offs.
In interviews: "I wrote RFCs for durable execution, multi-tenancy and runtime modes."

### Part D – Two modes
| | `MODE=single` | `MODE=distributed` |
|---|---|---|
| For | Small clinic, one server, self-hosted | Cloud, many clinics |
| Processes | 1 (API does everything) | API + workers + schedulers |
| Redis | Not needed | Needed |
| Crash recovery | On restart: re-run unfinished orders | Another worker takes over |

Only **one file** decides: `runtime/index.ts`. The rest uses 4 interfaces.

Try single mode (in a **new** terminal; close it afterwards, the settings stay in that window):
```powershell
$env:MODE="single"; $env:PORT="3100"; npm start
```
Then `curl.exe http://localhost:3100/health` → `"mode":"single","redis":"not used"`.

### Part E – Plugins (workflow nodes)
A **workflow** = list of **nodes**. Output of one = input of the next. Like n8n.

| Node | Does |
|---|---|
| `transform` | Keep fields (`pick`) / add fields (`set`) |
| `delay` | Wait |
| `http` | Call a URL (only allowed hosts) |
| `tbRiskMock` | Demo TB risk score (not a medical model) |

New node = 1 file + 1 line in `plugins/registry.ts`.

Try:
```powershell
$h = @{ 'X-Api-Key' = 'demo-key-amina' }
$body = '{"nodes":[{"type":"tbRiskMock"},{"type":"transform","params":{"pick":["patientRef","tbRisk"]}}],"input":{"patientRef":"P-001","opacityScore":0.9,"coughWeeks":6}}'
Invoke-RestMethod -Method Post -Uri http://localhost:3000/workflows/run -Headers $h -ContentType 'application/json' -Body $body
```

**SSRF** – a customer tricks OUR server into calling internal addresses. Blocked by `ALLOWED_HTTP_HOSTS`.

### Part F – Zero-downtime migrations
Rename column `tenants.name` → `display_name` **while the app keeps running**:
```
001  initial schema            (old app uses "name")
002  EXPAND   add display_name + trigger keeps both in sync   ← old AND new app work
003  MIGRATE  copy old values into display_name
     ── deploy new app everywhere ──
004  CONTRACT drop "name"
```
- `schema_migrations` table remembers what ran. Each file runs **once**.
- **Advisory lock**: two deploys can't migrate at the same time.
- `npm run migrate -- --to=002` stops after version 002.

### Part G – Live updates
Open **http://localhost:3000/live.html** → choose clinic → **Connect** → **Place order**.
Watch steps appear live. Open a 2nd tab as Berlin → sees nothing of Amina's orders.

How: worker → **event bus** (Redis pub/sub or in-memory) → API → **WebSocket** → browser, filtered by tenant.

### Interview answer (1 line)
> "FlowLite is multi-tenant with database-enforced isolation, runs as a single process or distributed from one code base via four runtime interfaces, is extensible through typed plugins, evolves its schema without downtime, and streams live state over WebSockets. Each decision is documented in an RFC."

### Troubleshooting
| Error | Fix |
|---|---|
| `password authentication failed for user "flowlite_app"` | Run `npm run migrate` first (it creates this user) |
| `relation "tenants" already exists` / old tables | `docker compose down -v`, `docker compose up -d`, `npm run migrate` |
| `401 Missing or invalid X-Api-Key` | Add header `X-Api-Key: demo-key-amina` |
| `test:crash`: "API must run with MODE=distributed" | `.env` → `MODE=distributed`, restart API |
| `test:tenancy` rate limit fails right after a re-run | Wait 1 minute (limit window) and run again |
| `Cannot find module …js` | Old files left → `Remove-Item -Recurse -Force src, scripts`, extract again |
| `TS18003: No inputs were found` | Zip extracted into a sub-folder → use the `Expand-Archive` + `Copy-Item` lines above |
| `npm run typecheck` shows an error | Paste it here (the app still runs with tsx) |

---

## Real-World Story – Part 2: TBScan AI grows 🩻

TBScan AI is successful. Now it has **many clinics**, **small and big customers**, and a **data-science team**.

### Chapter 8 – Many clinics, one system (Multi-tenancy)
Berlin Chest Center signs up. Now two clinics use the same database.
Each clinic gets a secret **API key**. Every request says: *"I am Berlin."*

A developer writes a new report page and **forgets** the "only this clinic" filter.
- ❌ Without RLS: Berlin sees Amina's patients. Data leak. 💥
- ✅ With RLS: the **database itself** hides other clinics' rows. The buggy page shows **nothing** instead of leaking.

📁 `tenants.ts`, `db.ts`, `001_init.sql` · 🧪 `test:tenancy`

### Chapter 9 – The noisy neighbour (Rate limit)
A big hospital runs a script that uploads 10,000 X-rays in one minute.
- ❌ Without limit: servers are busy with the hospital → Dr. Amina waits 20 minutes.
- ✅ With limit: the hospital gets **`429 – slow down, retry in 30 s`**. Amina's scans stay fast.

📁 `tenants.ts` (rateLimit) · metric `flowlite_rate_limited_total`

### Chapter 10 – The village clinic (Single mode)
A small clinic in a village wants TBScan **on its own server**. No IT team, no Redis.
- ✅ `MODE=single`: **one program** does everything.
- Power cut in the middle of Priya's scan → server restarts → FlowLite finds the **unfinished scan** and continues from the last finished step. Charged once.

The big cloud uses `MODE=distributed` with many AI servers. **Same code.**

📁 `runtime/`, `recovery.ts` · 🧪 `test:single` · 📄 RFC 0003

### Chapter 11 – The AI pipeline builder (Plugins)
The data team wants to try new screening flows **without changing the core engine**:
```
prepare data → TB risk model → notify clinic system → keep only needed fields
 (transform)    (tbRiskMock)       (http)               (transform)
```
Each box is a **plugin**. A new model = a new plugin file.

A customer tries to use the `http` node to call `169.254.169.254` (a secret internal cloud address).
- ✅ Blocked **before anything runs**: *"host not allowed"*.

📁 `plugins/` · 🧪 `test:plugins`

### Chapter 12 – The live screen (WebSocket)
Nurse Maria at Amina's clinic opens the **live screen**. She sees Ravi's scan move:
`processing → slot reserved → charged → report delivered ✅`
No refreshing. Berlin's nurse sees only Berlin's scans.

📁 `live.ts`, `public/live.html` · 🧪 `test:live`

### Chapter 13 – Renaming without closing the shop (Migrations)
Marketing wants clinic **"display names"**. The database column `name` must become `display_name`.
TBScan can't stop: clinics upload X-rays 24/7.
1. **Expand:** add `display_name`; a trigger copies between old and new. Old and new app versions **both** work.
2. **Migrate:** copy all old names.
3. Deploy the new app to all servers.
4. **Contract:** delete the old column.

Zero minutes of downtime. ✅

📁 `migrations/` · 🧪 `test:migrations`

### Chapter 14 – Why did we build it this way? (RFCs)
A new CTO joins: *"Why not one database per clinic?"*
The team sends **RFC 0002**: options, costs, decision, risks. Discussion takes 10 minutes, not 2 weeks.

📁 `docs/rfc/`

### Chapter 15 – Strict rules for a growing team (100% TypeScript)
TBScan now has 10 developers. Every part has a typed contract: a plugin **must** have `validate` + `execute`, a queue job **must** have `tenantId` + `orderId`.
Mistakes are caught by `npm run typecheck` and CI, **before** clinics see them.

### A day at TBScan AI – Part 2
| Time | Event | Feature |
|---|---|---|
| 06:00 | Village clinic server restarts after power cut → unfinished scan resumes | Single mode + recovery |
| 08:00 | Each clinic gets its own daily email, once | Cron lock + tenants |
| 09:00 | Hospital script floods API → 429; Amina unaffected | Rate limit |
| 10:00 | Buggy query → returns nothing, no leak | RLS |
| 11:00 | Nurse watches scans live | WebSocket |
| 13:00 | Data team adds a new pipeline node | Plugins |
| 15:00 | Column renamed, no downtime | Expand → contract |
| 16:00 | New CTO reads the RFCs | RFCs |

**One sentence:** FlowLite keeps every clinic's data **separate**, every clinic's service **fair**, and every scan **correct**, from one village server to a busy cloud.
