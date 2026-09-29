# FlowLite – Fresher's Onboarding Guide

Sep 29, 2026 · @Abhinav

## 1. FlowLite in one minute

FlowLite is a small workflow engine: it runs business tasks step by step and makes sure every task happens correctly and exactly once, even when things go wrong. It is a mini version of what n8n does.

### The story that explains everything

Imagine **TBScan AI**, a company that checks chest X-rays for tuberculosis risk. A clinic (for example Dr. Amina's clinic) uploads an X-ray and pays 5 euros. The system then does three things in order:

1. Reserve an AI analysis slot (in code: `reserveStock`)
2. Charge the clinic (in code: `chargePayment`)
3. Deliver the report (in code: `createShipment`)

Every feature in FlowLite solves one real problem in this story:

| What can go wrong | What FlowLite does |
| --- | --- |
| The payment company sends the same message twice | Processes it only once (idempotency) |
| Step 2 or 3 fails | Undoes the finished steps, newest first (saga) |
| The AI server crashes in the middle | Another server continues from the last finished step (crash recovery) |
| 3 servers run the same daily email timer | Only one sends it (cron lock) |
| Clinic A could see clinic B's patients | The database hides other clinics' rows (multi-tenancy) |
| One huge hospital floods the system | It gets slowed down, others stay fast (rate limit) |
| A nurse wants to watch progress | Live updates in the browser (WebSocket) |
| A small clinic has only one server | Everything runs in one program (single mode) |
| The team must rename a database column | Done while the system keeps running (migrations) |

### The tools, in plain words

| Tool | Role in FlowLite | Everyday picture |
| --- | --- | --- |
| Node.js + TypeScript | All our code | The workers and their rulebook |
| PostgreSQL | Stores orders, payments, step history | A permanent notebook |
| Redis | Shared to-do list, locks, live messages | A whiteboard all servers can see |
| BullMQ | Job queue on top of Redis | The ticket machine at a counter |
| Docker | Starts PostgreSQL and Redis on your PC | A box that contains ready-made tools |
| Prometheus | Collects numbers about the system | A dashboard in a car |

The diagram at the end of this section shows how these parts talk to each other.

&#91;embedded content: FlowLite architecture · distributed mode\]

Read it top to bottom: a request enters the API, slow work goes through the queue to a worker, and every result is saved in PostgreSQL. In single mode the Redis box disappears and the API also plays worker and scheduler.

## 2. Where to start: reading order

Start with the README, then follow ONE order from the moment it arrives until it is finished. Do not read files alphabetically; read them in the order the data travels. Plan about 3 short sessions.

### Session 1: the big picture (about 45 minutes)

1. `README.md` - the table "What it solves" and the architecture diagram.
2. `GUIDE.md` - read only the "Real-World Story" chapters (TBScan AI). They explain the why without code.
3. `src/types.ts` - the rulebook. Every important word (Tenant, OrderStatus, SagaStep, JobQueue) is defined here in one place.
4. `migrations/001_init.sql` - the tables. Knowing the tables makes all code easier.

### Session 2: follow one order (about 90 minutes)

Open these files in this exact order. Each one calls the next.

1. `src/server.ts` - the front door. Find the line `app.use('/orders', tenantAuth, rateLimit, ordersRouter)`.
2. `src/tenants.ts` - checks the API key (who are you?) and the rate limit (not too many requests?).
3. `src/routes/orders.ts` - checks the order data, saves the order, then runs it.
4. `src/saga/processOrder.ts` - loads the order and starts the saga.
5. `src/saga/runSaga.ts` - the engine: runs steps, remembers progress, undoes on failure. This is the most important file. Read it twice.
6. `src/saga/orderSteps.ts` - the 3 real steps and their undo actions.
7. `src/db.ts` - `withTenant()`: how every database call is locked to one clinic.

### Session 3: the extra features (about 90 minutes)

1. `src/runtime/index.ts`, then `memory.ts` and `redis.ts` - the two modes.
2. `src/worker.ts` - the background server that takes queued orders.
3. `src/routes/webhooks.ts` - duplicate payment messages.
4. `src/reports.ts` - the daily email with a lock.
5. `src/plugins/registry.ts`, then `runWorkflow.ts` - workflow nodes.
6. `src/live.ts` and `public/live.html` - live updates.
7. `docs/rfc/` - why things are built this way.

### Skip at first

`config.ts`, `logger.ts`, `metrics.ts`, `redis.ts`, `migrations.ts` are helpers. Read them only when you need them.

### Best trick

Run the project (section 3) and read the logs while you read the code. Every log line tells you which file is working right now.

## 3. How to run the project

You need 3 commands to set up once, and 2 commands every day. All commands are for Windows PowerShell, run inside the `flowlite` folder.

### What you need installed

| Tool | Version | Check with |
| --- | --- | --- |
| Node.js | 20.6 or newer | `node -v` |
| Docker Desktop | any recent, must be running | `docker -v` |
| Git | any | `git --version` |

### First time only

```powershell
docker compose up -d          # starts PostgreSQL (port 5433) and Redis (port 6380)
Copy-Item .env.example .env   # creates your settings file
npm install                   # downloads libraries into node_modules
npm run typecheck             # checks all TypeScript rules; no output = OK
npm run migrate               # creates the tables, the app DB user and demo clinics
```

### Every day

```powershell
docker compose up -d   # if Docker was restarted
npm start              # starts the API on http://localhost:3000
```

Check it works: open http://localhost:3000/health in the browser. You should see `"status":"ok"`.

### Distributed mode (default, like the cloud)

The API only receives requests. Background work needs a worker. Open extra terminals:

```powershell
npm run worker      # terminal 2: processes queued orders (you can start 2 or 3)
npm run scheduler   # terminal 3: sends the daily report emails
```

### Single mode (like a small clinic server)

One program does everything, no Redis needed. In `.env` set `MODE=single`, then only run `npm start`.

### Run all automated tests

Keep `npm start` running (MODE=distributed), open a new terminal:

```powershell
npm run test:all
```

Expected: 10 test groups, each ending with `All tests PASSED.` (about 2 to 3 minutes). You do not need to start workers or schedulers; the tests start them.

### Try it by hand

Every clinic request needs an API key. Demo keys: `demo-key-amina`, `demo-key-berlin`, `demo-key-tiny`.

```powershell
$h = @{ 'X-Api-Key' = 'demo-key-amina' }
Invoke-RestMethod http://localhost:3000/inventory -Headers $h
Invoke-RestMethod -Method Post -Uri http://localhost:3000/orders -Headers $h -ContentType 'application/json' -Body '{"sku":"xray-scan","qty":1,"amount":5}'
```

Then open http://localhost:3000/live.html, click Connect, then Place order, and watch the steps appear live.

### Stop everything

Press `Ctrl + C` in each terminal. Then `docker compose down` (keeps data) or `docker compose down -v` (deletes all data, fresh start).

## 4. Understand it through scenarios

Each scenario is one real problem, told as a story, with the files that solve it and the test that proves it. Read the story, then open the files, then run the test.

| # | Scenario | Main files | Test command |
| --- | --- | --- | --- |
| 1 | Payment message arrives twice | `routes/webhooks.ts` | `npm run test:idempotency` |
| 2 | A step fails halfway | `saga/runSaga.ts`, `saga/orderSteps.ts` | `npm run test:saga` |
| 3 | Server crashes mid-order | `worker.ts`, `runtime/redis.ts`, `saga/runSaga.ts` | `npm run test:crash` |
| 4 | 3 servers, 1 daily email | `reports.ts`, `scheduler.ts` | `npm run test:cron` |
| 5 | Clinics must not see each other | `tenants.ts`, `db.ts`, `001_init.sql` | `npm run test:tenancy` |
| 6 | Small clinic, one server | `runtime/`, `recovery.ts`, `server.ts` | `npm run test:single` |
| 7 | Build new AI pipelines | `plugins/` | `npm run test:plugins` |
| 8 | Watch progress live | `live.ts`, `public/live.html` | `npm run test:live` |
| 9 | Rename a column, no downtime | `migrations/`, `migrations.ts` | `npm run test:migrations` |

### Scenario 1: the double payment message

**Story:** The payment company tells us "Amina paid 5 euros". The network is slow, so they send the same message again.

**Problem:** Without protection we record 2 payments.

**How FlowLite solves it:**

1. Every message has a unique `eventId`.
2. We try to save the `eventId` in table `processed_events`. The table allows each ID only once (PRIMARY KEY).
3. Saved = new message, create the payment. Not saved = seen before, answer `duplicate`.

**Key idea:** check and save in ONE database step (`INSERT ... ON CONFLICT DO NOTHING`). Never "first check, then save": two requests could both pass the check.

### Scenario 2: a step fails halfway (saga)

**Story:** The slot is reserved and Amina is charged, but report delivery fails.

**Problem:** Amina paid for nothing, and the slot stays blocked.

**How FlowLite solves it:** every step has an undo. On failure, finished steps are undone in reverse order: refund the charge, then free the slot. Final status: `failed`. If an undo also fails, the status is `needs_attention` so a human checks it.

**Key idea:** a saga = a list of steps + undo actions. Look at `orderSteps.ts`: each step has `run` and `compensate`.

### Scenario 3: the server crashes mid-order

**Story:** AI server A reserves the slot, then its power goes off.

**Problem:** The order is stuck forever, or someone restarts it from zero and charges twice.

**How FlowLite solves it:**

1. Orders wait in a queue (BullMQ on Redis). A worker "borrows" a job for 10 seconds and keeps renewing it while alive.
2. After every step, the worker writes a line in `saga_log`, in the same database transaction as the step itself.
3. Server A dies, so the borrow expires. Server B takes the job, reads `saga_log`, skips the finished step and continues.

**Key idea:** progress is stored in the database, not in the server's memory. A unique index `saga_log_once` makes each step happen at most once, even if two workers race.

### Scenario 4: three servers, one email

**Story:** For safety, 3 servers run the same timer: "every day at 08:00 email each clinic its report".

**Problem:** Each clinic gets 3 emails.

**How FlowLite solves it:** before sending, each server tries to put a lock in Redis for that time slot (`SET key NX PX`). Only the first one succeeds; the others log `skipped`.

**Key idea:** NX means "only if it does not exist yet". The test first runs WITHOUT the lock to show the problem, then WITH the lock.

### Scenario 5: clinics must not see each other (multi-tenancy)

**Story:** Dr. Amina's clinic and Berlin Chest Center share one database. A developer forgets a filter in a query.

**Problem:** Berlin could see Amina's patients.

**How FlowLite solves it:**

1. Each clinic sends its secret API key; `tenants.ts` finds the clinic.
2. `withTenant()` in `db.ts` tells PostgreSQL "this transaction belongs to clinic amina".
3. Row-Level Security rules (in `001_init.sql`) make PostgreSQL itself hide other clinics' rows.
4. Rate limit: each clinic may send a limited number of requests per minute. Too many = answer `429`, other clinics are not slowed down.

**Key idea:** security in the database, not only in code. A forgotten filter shows nothing instead of leaking data.

### Scenario 6: the small clinic with one server (single mode)

**Story:** A village clinic runs FlowLite on one small computer, without Redis. The power goes off during a scan.

**How FlowLite solves it:** with `MODE=single` the queue, locks and live messages live in memory, inside one program. On restart, `recovery.ts` finds unfinished orders in the database and runs them again. `runSaga` skips the finished steps.

**Key idea:** the same code runs in both modes. Only `runtime/index.ts` picks the memory version or the Redis version.

### Scenario 7: building AI pipelines (plugins)

**Story:** The data team wants a flow: prepare data, calculate TB risk, notify the clinic system.

**How FlowLite solves it:** a workflow is a list of nodes. Each node type is a plugin with `validate` (check settings before anything runs) and `execute` (do the work). The output of one node is the input of the next.

**Key idea:** add a feature by adding a plugin file, not by changing the engine. The `http` plugin only calls allowed hosts, so nobody can trick our server into calling internal systems (SSRF).

### Scenario 8: watching progress live

**Story:** Nurse Maria wants to see Ravi's scan progress without refreshing.

**How FlowLite solves it:** each step publishes an event. The API sends it over a WebSocket to the browsers of that clinic only.

**Key idea:** worker, then event bus (Redis or memory), then API, then WebSocket, then browser.

### Scenario 9: renaming a column without stopping

**Story:** Column `tenants.name` must become `display_name`, but clinics work 24/7.

**How FlowLite solves it:** 4 small migrations instead of 1 big one:

1. `001` creates the table with `name`.
2. `002` Expand: add `display_name` and a trigger that copies between both columns, so old and new app versions both work.
3. `003` Migrate: fill `display_name` for old rows.
4. `004` Contract: after all servers run the new app, delete `name`.

**Key idea:** each migration file runs once; table `schema_migrations` remembers which ones already ran.

## 5. Why every file exists

Every file has one job. If you delete it, one feature breaks. The tables below say which.

### Project root

| File | Why it exists |
| --- | --- |
| `package.json` | Lists libraries and the `npm run ...` commands |
| `package-lock.json` | Locks exact library versions so every PC installs the same |
| `tsconfig.json` | TypeScript rules (strict mode) used by `npm run typecheck` |
| `.env.example` | Template for settings; copied to `.env` (your real settings, never on GitHub) |
| `.nvmrc` | Tells tools to use Node.js 20 |
| `docker-compose.yml` | Starts PostgreSQL, Redis and (optional) Prometheus with one command |
| `.github/workflows/ci.yml` | GitHub runs type check + all tests on every push |
| `monitoring/prometheus.yml` | Tells Prometheus where to read `/metrics` |
| `README.md` | Project front page for GitHub visitors and recruiters |
| `GUIDE.md` | Step-by-step learning diary (Steps 1 to 7) + TBScan story |
| `LICENSE` | MIT: others may use the code |

### src/ - starting points (you run these)

| File | Why it exists |
| --- | --- |
| `server.ts` | The API: receives HTTP requests; in single mode also runs worker + scheduler |
| `worker.ts` | Background server that takes orders from the queue (distributed mode) |
| `scheduler.ts` | Runs the daily report timer (distributed mode) |
| `migrate.ts` | Command `npm run migrate`: updates the database |

### src/ - core helpers

| File | Why it exists |
| --- | --- |
| `types.ts` | The rulebook: shared types so all files speak the same language |
| `config.ts` | Reads `.env` in one place; fails early if a setting is missing |
| `db.ts` | Database connection + `withTenant()` for clinic isolation |
| `redis.ts` | Redis connection, created only when needed (single mode never connects) |
| `logger.ts` | Readable or JSON logs, with fields like service and order ID |
| `metrics.ts` | Numbers for Prometheus: requests, orders, queue size, rate limits |
| `tenants.ts` | API key check + per-clinic rate limit |
| `live.ts` | WebSocket server for live updates |
| `reports.ts` | Daily report logic + lock so it runs once |
| `recovery.ts` | Single mode: restart unfinished orders after a crash |
| `migrations.ts` | Runs SQL files in order, each once, with a lock |

### src/runtime/ - the two modes

| File | Why it exists |
| --- | --- |
| `index.ts` | Picks memory or Redis version based on `MODE` |
| `memory.ts` | Single mode: queue, events, lock, counter in memory |
| `redis.ts` | Distributed mode: BullMQ queue, Redis pub/sub, Redis lock and counter |

### src/saga/ - the order engine

| File | Why it exists |
| --- | --- |
| `runSaga.ts` | Generic engine: steps, progress log, resume, undo in reverse |
| `orderSteps.ts` | The 3 real steps (slot, charge, report) and their undo |
| `processOrder.ts` | Connects an order to the engine; publishes live events; crash demo |

### src/routes/ - the URLs

| File | URL | Why it exists |
| --- | --- | --- |
| `webhooks.ts` | `POST /webhooks/payment` | Receive payment messages without duplicates |
| `payments.ts` | `GET /payments` | See saved payments (for checking) |
| `tenantInfo.ts` | `GET /tenants/me` | Which clinic am I? |
| `inventory.ts` | `GET /inventory` | See slots left for your clinic |
| `orders.ts` | `/orders` | Create and read orders |
| `workflows.ts` | `/plugins`, `/workflows/run` | List and run plugin workflows |

### src/plugins/ - workflow nodes

| File | Why it exists |
| --- | --- |
| `registry.ts` | List of all plugins; add one line to add a plugin |
| `runWorkflow.ts` | Validates all nodes first, then runs them one by one |
| `helpers.ts` | Small checks shared by plugins |
| `transform.ts`, `delay.ts`, `http.ts`, `tbRiskMock.ts` | The 4 node types (tbRiskMock is a demo formula, not medical) |

### Other folders

| File | Why it exists |
| --- | --- |
| `migrations/001` to `004` | Database changes, in order (tables, security rules, column rename) |
| `public/live.html` | Small web page to watch orders live |
| `docs/rfc/` | 3 design decisions: problem, options, choice, trade-offs |
| `scripts/helpers.ts` | Shared test tools: call API, start workers, PASS/FAIL printing |
| `scripts/test-*.ts` | One test file per scenario; each injects a failure and checks the result |

## 6. Glossary

These 22 words cover almost every conversation about this project.

| Word | Simple meaning |
| --- | --- |
| API | The "front door" programs use to talk to FlowLite over HTTP |
| Tenant | One customer, here one clinic |
| API key | A secret password that says which clinic is calling |
| Idempotency | Doing the same request twice gives the same result as once |
| Transaction | A group of database changes: all happen, or none |
| Saga | Steps with undo actions, for work that cannot be one transaction |
| Compensation | The undo of a finished step |
| Queue | A waiting line of jobs, like tickets at a counter |
| Worker | A program that takes jobs from the queue and does them |
| Stalled job | A job whose worker died; the queue gives it to another worker |
| Cron / scheduler | A timer that runs a job at fixed times |
| Distributed lock | "Only one server may do this now", stored in Redis |
| Row-Level Security (RLS) | PostgreSQL rule that hides rows of other tenants |
| Rate limit | Maximum requests per minute; above it, answer `429` |
| Noisy neighbour | One busy customer slowing down everyone else |
| Plugin / node | One reusable building block of a workflow |
| SSRF | Tricking a server into calling internal addresses; blocked by an allowlist |
| WebSocket | An always-open connection so the server can push updates to the browser |
| Migration | A versioned change to the database structure |
| Expand / contract | Add the new thing first, remove the old thing last, so nothing breaks in between |
| Metrics | Numbers about the running system, read by Prometheus |
| RFC | A short document explaining a design decision |

## 7. Common problems and self-check

Most problems come from Docker not running, an old `.env`, or a missing `npm run migrate`.

### Problems and fixes

| You see | Fix |
| --- | --- |
| `ECONNREFUSED 127.0.0.1:5433` or `:6380` | Start Docker Desktop, then `docker compose up -d` |
| `password authentication failed for user "flowlite_app"` | Run `npm run migrate` (it creates this user) |
| `Missing DATABASE_URL in .env file` | `Copy-Item .env.example .env -Force` |
| `relation "tenants" already exists` | Old database: `docker compose down -v`, `docker compose up -d`, `npm run migrate` |
| `401 Missing or invalid X-Api-Key` | Add header `X-Api-Key: demo-key-amina` |
| `429 Rate limit exceeded` | Too many requests this minute; wait 1 minute |
| `EADDRINUSE :3000` | The API already runs in another terminal; close it |
| `test:crash` says "API must run with MODE=distributed" | Set `MODE=distributed` in `.env`, restart `npm start` |
| `TS18003: No inputs were found` | The zip was extracted into a sub-folder; copy the files so `src\server.ts` exists |
| `curl` behaves strangely in PowerShell | Use `curl.exe` or `Invoke-RestMethod` |

### Check yourself

You understand the project when you can answer these without looking:

- [ ] Why is "check, then save" wrong for duplicate messages?
- [ ] In which order are steps undone, and why?
- [ ] Why does a crashed order not get charged twice?
- [ ] What does `NX` mean in the Redis lock?
- [ ] Why is RLS safer than adding `WHERE tenant_id = ...` in code?
- [ ] Which single file decides between single and distributed mode?
- [ ] What 2 functions must every plugin have?
- [ ] Why does the column rename need 4 migrations instead of 1?

### Your next small exercise

Add a plugin called `uppercase` that turns `input.text` into capital letters. You need one new file in `src/plugins/` and one line in `registry.ts`. Then run `npm run typecheck` and call it with `POST /workflows/run`.
