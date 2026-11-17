# Build journal — how this project was built, what was decided, and what went wrong

This is the long-form story of building **NSE Paper Trading**, in the order it happened. It is written so you
can tell it in an interview: for each stage there is *what was built*, *the decisions and why*, and *the problems
hit along the way* — with the symptom, the root cause, the fix, and the lesson.

- [0. The brief and the plan](#0-the-brief-and-the-plan)
- [Stage 1 — the synchronous core (TDD)](#stage-1--the-synchronous-core-tdd)
- [Stage 2 — moving execution into a BullMQ worker](#stage-2--moving-execution-into-a-bullmq-worker)
- [Stage 3 — the frontend and live prices](#stage-3--the-frontend-and-live-prices)
- [Stage 4 — production readiness](#stage-4--production-readiness)
- [Stage 5 — shipping it: CI, an index rejig, a free deployment](#stage-5--shipping-it-ci-for-real-an-index-rejig-and-a-free-deployment)
- [Challenge log (all of them, in one table)](#challenge-log)
- [What I would do next](#what-i-would-do-next)
- [Numbers to remember](#numbers-to-remember)

---

## 0. The brief and the plan

**Goal:** a portfolio project for a backend SDE role (Node.js, microservices, caching, queues, TDD, AWS) — a
paper-trading platform for NSE stocks where users get virtual cash, place market and limit orders at real
prices, and track a portfolio.

The single most important framing decision came from the brief itself: **model a broker, not an exchange.**
There is no order book and no matching engine; orders fill at the latest market price. That decision shapes
everything after it — the hard problems become *money correctness, idempotency, concurrency, async execution
and market data*, not price-time priority. (The full argument is in
[DECISIONS.md → ADR-001](DECISIONS.md#adr-001-broker-model-no-order-book).)

Before writing code, a plan was agreed: folder structure, the 7-table schema, and the endpoint list. Three
details were settled up front:

1. **Limit-order fill rule.** OPEN limit orders are checked once a day after close: BUY fills if the day's
   `low ≤ limit`, SELL if `high ≥ limit`, **at the limit price** (conservative), and they stay OPEN (GTC-style)
   otherwise.
2. **Market data offline fallback.** If Yahoo Finance isn't reachable, tests use a fake provider — which they
   should anyway.
3. **Repository hosting.** The work environment was attached to an existing GitHub repository, and the `gh`
   CLI was not usable, so `gh repo create nse-paper-trading` could not run as written. Decision: build on
   `main` in the existing repo and rename it on GitHub later.

**Environment check before coding:** Node 22, PostgreSQL 16, Redis 7 and Docker were available. Yahoo
Finance returned **HTTP 403 through the sandbox's egress proxy** — the first real constraint (see Stage 1).

---

## Stage 1 — the synchronous core (TDD)

**Built:** monorepo scaffold, SQL schema + migration runner, auth, market data with a Redis cache, the full
order lifecycle executed synchronously, and 108 tests.

### Decisions

**Monorepo with npm workspaces + TypeScript project references.** `apps/api`, `apps/worker`, `apps/web`,
`packages/shared`. `tsc -b` builds packages in dependency order. Jest maps `@nse/*` straight to `src` so tests
never need a build step.

**A fifth package: `packages/core`.** The brief had repositories and services inside `apps/api`. But Stage 2
moves execution into a separate worker — if the fill logic lived in the API app, the worker would either
import from another *app* (wrong direction) or duplicate it (two sources of truth for money). So the domain,
services, repositories, market data and migrations live in `packages/core`, and both deployables import it.
*Interview line:* "two services, one implementation of the money logic."

**CommonJS, not ESM.** Jest + ts-jest is still smoothest with CommonJS. The one dependency that could have
forced ESM (`yahoo-finance2` v3) ships a CommonJS build — verified before committing to it.

**Strict layering.** routes → services → repositories. Routes only validate (zod) and map to HTTP. Services hold
business rules and own transactions but contain no SQL. Repositories are plain objects of functions whose first
argument is `db: Db` — either the pool or a transaction client — so a service can compose several repositories
inside one `BEGIN … COMMIT` without the repository knowing.

**A hand-written migration runner (60 lines) instead of a library.** Forward-only `.sql` files, a
`schema_migrations` table, each file in its own transaction, and a **Postgres advisory lock** so several
containers starting at once can't apply the same migration twice. Small enough to explain fully.

**Schema choices worth defending:**

- **Money is `NUMERIC(18,2)` in the DB and integer *paise* in code.** No floats anywhere near money.
- **`holdings.cost_basis` instead of `avg_price`.** Average price is *derived* (`cost_basis / quantity`). On a
  partial sell, a proportional share of cost is removed (`round(cost × sold / held)`); when the last share is
  sold the *entire* remaining cost is removed. Result: no paise ever lost to rounding — there's a unit test that
  sells 3 shares bought for ₹100 one at a time and asserts the cost basis lands on exactly 0.
- **The cash ledger is the source of truth.** Balance = `SUM(cash_ledger.amount)`. A new user's ₹10,00,000 is a
  `DEPOSIT` row, not a column default. Limit buys block cash with a negative `HOLD` row; fills/cancels add a
  positive `RELEASE`. **`UNIQUE (order_id, reason)`** means a retried fill physically cannot debit twice.
- **`UNIQUE (user_id, idempotency_key)`** on `orders` — idempotency enforced by the database, not by hope.
- **CHECK constraints** encode invariants: `quantity >= 0` on holdings, `(type = 'LIMIT') = (limit_price IS NOT
  NULL)`, `(status = 'FILLED') = (fill_price IS NOT NULL)`, `amount <> 0` on the ledger.
- **Indexes for the actual queries:** `orders (user_id, status, created_at DESC)`; a **partial index**
  `orders (symbol) WHERE status='OPEN' AND type='LIMIT'` so the EOD sweep only touches open limits;
  `daily_prices` PK `(symbol, date)` doubles as the range-scan index for candles.

**The order state machine** is a transition table in a pure module (`PLACED → VALIDATED → OPEN → FILLED`, plus
`CANCELLED` and `REJECTED`). Every status change goes through one function, `transitionOrder()`, which:
1. checks the table (`INVALID_STATE_TRANSITION`, HTTP 409, if not allowed),
2. runs a **compare-and-set** `UPDATE orders SET status=$to … WHERE id=$id AND status=$from`,
3. appends an `order_events` row with the request id.

Market orders go `VALIDATED → OPEN → FILLED` in one transaction (two events) to keep the state machine
honest rather than adding a `VALIDATED → FILLED` shortcut.

**Concurrency model: one row lock per user.** Every operation that reads-then-writes a user's cash or holdings
starts with `SELECT 1 FROM users WHERE id=$1 FOR UPDATE`. Two concurrent ₹6 L buys on a ₹10 L account
serialise; the second sees ₹4 L and is rejected. **Lock order is always user → order** in placement, execution
and cancellation, so there's no lock-ordering deadlock. There's a test that fires both buys with `Promise.all`.

**Pre-trade checks run twice.** At placement (fast feedback, inside the user lock) and again at fill time (the
authoritative check), because in Stage 2 the two happen in different processes and time can pass in between.
Sells check `held − reserved`, where *reserved* = quantity in the user's other in-flight sell orders — so you
can't place two limit sells for the same 10 shares.

**Business rejections are data, not errors.** Insufficient funds doesn't return HTTP 4xx; it creates an order
in `REJECTED` with `rejectReason: INSUFFICIENT_FUNDS`, like a broker's order book. HTTP errors are reserved for
malformed requests, auth, conflicts.

**Idempotency flow.**
1. Fast path: look up `(user, key)`; if found, compare a **SHA-256 of the canonical request body** — same body →
   return the original order (`200`, `Idempotent-Replayed: true`); different body → `422 IDEMPOTENCY_KEY_REUSED`.
2. Otherwise `INSERT … ON CONFLICT (user_id, idempotency_key) DO NOTHING RETURNING *` inside the transaction. If
   two identical requests race, the unique index makes the second wait for the first to commit, then do
   nothing — it falls back to the replay path. Test: 5 concurrent requests with one key → exactly 1 order, 1 fill.

**Market data behind an interface.** `PriceProvider` (Yahoo or fake) → `MarketDataService`, a read-through
Redis cache:
- `quote:{SYM}` with a short TTL (15 s) — what fills use;
- `quote:last:{SYM}` without TTL — last known price, *display-only* fallback if the provider is down;
- **single-flight**: concurrent misses for the same symbols share one in-flight provider call, so a burst of
  orders can't stampede Yahoo (test: 20 concurrent `getQuote` → 1 provider call).
- **Fills are strict** (`getQuote` throws `PRICE_UNAVAILABLE` rather than use a stale price); display is lenient.

**Request id end-to-end.** Middleware accepts a valid incoming `X-Request-Id` or generates a UUID, echoes it,
and binds it into **AsyncLocalStorage**. `getLogger()` returns a pino child logger with that id, so every log
line — and every `order_events.request_id` — carries it without passing it through every function signature.

**Consistent errors.** One `AppError(code, status, message, details)`, one error middleware, one envelope:
`{ error: { code, message, details?, requestId } }`. zod failures list every failing field with `in` (body/
query/params) and `path`.

**A typed route helper.** `handler({ body, query, params }, fn)` validates with zod and gives `fn` fully typed
input — routes stay one-liners and can't forget validation.

### TDD, concretely

The order-logic tests were written **before the implementation** and committed red (`2d7e968 test: specs for
order logic (red)`): state machine, P&L math, pre-trade checks, and the integration flow — market fills,
insufficient funds/holdings, limit fills, cancellation, duplicate and concurrent idempotency keys, concurrent
overspend, retry safety, P&L aggregation. They failed because the modules didn't exist. Then the
implementation went in until they passed. Integration tests use **real Postgres and Redis**: the guarantees
here are unique constraints, row locks and transaction boundaries — a mocked DB would make those tests
meaningless.

### Challenges in Stage 1

**1. `npm install` failed with ERESOLVE.**
*Symptom:* peer-dependency conflict on install. *Cause:* `@eslint/js@10` (latest) wants `eslint@10`, while
`typescript-eslint` at the time supported up to 9. *Fix:* pinned `eslint@9` and `@eslint/js@9`. *Lesson:* pin
the linter major explicitly in a monorepo; "latest" across an ecosystem isn't a consistent set.

**2. `yahoo-finance2` v2 is deprecated.**
*Symptom:* importing it printed "v2 is no longer maintained". *Fix:* moved to v3, which changed the API to
`new YahooFinance()`. Verified its `exports` map has a `require` entry, so it works in a CommonJS project.

**3. Yahoo Finance was unreachable from the build environment.**
*Symptom:* `curl` to `query1.finance.yahoo.com` → `CONNECT tunnel failed, response 403`. *Fix:* the market data
layer was already an interface; added a **deterministic `FakePriceProvider`** selected with
`MARKET_DATA_PROVIDER=fake`. *Turned into a feature:* offline dev, reproducible CI, and load tests that don't
hammer a third-party API. Production uses Yahoo.

**4. The first fake price model was over-engineered.**
*Symptom:* a "piecewise random walk" that looped over 30-day blocks from an anchor date — O(n) per price,
hard to read, odd sign handling for past dates. *Fix:* replaced with a closed-form function — two sine waves
with symbol-specific phases plus seeded daily noise — O(1), bounded around the base price, and still looks like
a market on a chart. Candle highs/lows are derived so `low ≤ open, close ≤ high` always holds (tested).

**5. One SQL statement failed 26 tests at once.**
*Symptom:* `error: inconsistent types deduced for parameter $3`. *Cause:* in the guarded status update, `$3`
was used both as `status = $3` (Postgres infers the `order_status` enum) and in `CASE WHEN $3 = 'FILLED'`
(infers `text`). *Fix:* explicit casts — `$3::order_status`, `$4::numeric`, `$5::text`. *Lesson:* with
node-postgres, cast any parameter that appears in more than one type context.

**6. Flaky integration tests (1–2 failures in 5 runs).**
*Symptom:* e.g. "rejects duplicate emails — promise resolved instead of rejected", only sometimes.
*Cause:* Jest ran test **files** in parallel workers; two files called `TRUNCATE` on the same test database
mid-test. *Fix:* `maxWorkers: 1` in the Jest config itself (not just the `--runInBand` CLI flag, which
`npx jest` callers can forget). Verified with 6 consecutive green runs. *Trade-off:* the suite takes ~10 s
instead of ~5 s; per-worker databases would be the upgrade.

**7. A tooling self-own: `pkill -f` killed its own shell (exit 144).**
`pkill -f "src/server.ts"` matched the shell command line containing that string. *Fix:* the bracket trick,
`pkill -f "[s]rc/server.ts"` — the regex matches the process but not itself.

**8. A Redis snapshot got committed.**
Redis had been started from the repo directory, so it wrote `dump.rdb` there. Removed from the commit and added
to `.gitignore`.

**9. Push to GitHub returned 403.**
The GitHub App didn't have write access to the repository. Work continued locally with commits per stage; the
push waits for the access fix.

**Stage 1 result:** 108 tests green, lint and type-check clean, end-to-end `curl` session working (login →
portfolio → market order → `Idempotency-Key` missing → 400), and the request id visible on every log line.

---

## Stage 2 — moving execution into a BullMQ worker

**Built:** a separate `apps/worker` process; the API now validates and enqueues; scheduled jobs for end-of-day
processing, live quote polling and reconciliation.

### Decisions

**The seam was already there.** Stage 1 introduced an `OrderDispatcher` interface with a `SyncDispatcher`
(execute in-process). Stage 2 added a `QueueDispatcher` and changed *one line* in the composition root, chosen
by `EXECUTION_MODE=sync|queue`. The service-level test suites keep running in sync mode; the worker suite tests
the queue path. *Interview line:* "I designed the dispatch boundary in Stage 1 so going async was a wiring
change, not a rewrite."

**The API returns `202 Accepted`** with the order in `VALIDATED` when it's been queued, `201` if it's already
in a resting/final state (e.g. REJECTED at pre-trade), `200` for an idempotent replay.

**At-least-once delivery, made safe.** BullMQ retries failed jobs (5 attempts, exponential backoff). That's only
safe if execution is **idempotent**: `executeOrder` re-reads the order *under the user lock* and does nothing
unless it's still `VALIDATED`. Ledger `UNIQUE(order_id, reason)` is the second safety net.

**`jobId = orderId`** dedupes dispatch: if an idempotent replay re-dispatches an order that's still in the
queue, BullMQ ignores the duplicate.

**The dual-write problem, handled with a reconciler.** The API commits the order, *then* enqueues. If the process
dies between the two, the order is stuck in `VALIDATED`. Options considered:
- *Transactional outbox* (write a job row in the same transaction; a relay publishes it) — the textbook fix;
- *Reconciler* — a repeatable job every 60 s re-dispatches `VALIDATED` orders older than 30 s (served by a
  partial index on `status='VALIDATED'`).

Chose the reconciler: much less machinery, and because execution is idempotent, re-dispatching is always safe.
Additionally, a client **retry** with the same Idempotency-Key re-dispatches a stuck `VALIDATED` order
immediately. There's a test that injects a dispatcher that drops the job ("API crashed"), then runs the
reconciler and watches the order fill. The outbox is documented as the upgrade.

**Scheduling with BullMQ job schedulers, not node-cron.** Schedules live in Redis, so running 3 worker replicas
does **not** run the EOD job 3 times. `upsertJobScheduler` is idempotent, so every worker start re-declares them.
- `eod-close` — cron `0 16 * * 1-5`, timezone `Asia/Kolkata` (NSE closes 15:30): ingest candles, sweep limits.
- `quote-poll` — every 5 s: refresh all 50 quotes in one provider call, write the cache, **publish** on Redis.
- `reconcile` — every 60 s.

**Catch-up EOD.** The EOD job ingests the last ~7 days and sweeps every date in a 5-day look-back window, oldest
first. If the worker was down on Tuesday, Wednesday's run still fills Tuesday's crossings. Safe because ingest
upserts and filled orders are no longer OPEN. Orders are only eligible for a candle if placed **before that
session's 15:30 IST close** — an order placed at 6 pm can't be filled by that afternoon's low.

**The request id crosses the process boundary.** It travels in the job payload; the worker wraps the job in
`runWithContext({ requestId })`, so `grep <request-id>` across API and worker logs shows one order's whole
life. Verified live: the API logged `order placed VALIDATED`, the worker logged `order executed FILLED`, same id.

**Order updates are published, not pushed.** After commit, the worker `PUBLISH`es `{userId, order}` on a Redis
channel. It doesn't know which API instance holds the user's WebSocket — that's Stage 3's job.

### Challenges in Stage 2

**10. BullMQ deduplication can swallow a legitimate retry.** (Caught at design time.) With `jobId = orderId`, if
the original job ended in BullMQ's *failed* set, re-adding the same id is silently ignored — so the reconciler
would never actually re-run it. *Fix:* reconciler dispatches use a suffixed job id (`{orderId}-r{minute}`);
normal dispatch keeps the plain id for dedupe. Safe because execution is idempotent.

**11. A lost-update race in single-threaded JavaScript.**
*Symptom:* the EOD job logged `bars: 42` but the database clearly had 50 rows per trading day.
*Cause:* `PriceIngestService` runs 5 concurrent async loops, each doing
`bars += await pricesRepo.upsertMany(...)`. JavaScript evaluates `bars` (the left side) **before** the `await`,
then adds after resuming — so loops overwrite each other's increments. Single-threaded doesn't mean no races
once `await` is involved.
*Fix:* `const written = await …; bars += written;`.
*Proof:* a regression test ingests 5 trading days × 50 symbols and asserts the reported count is exactly 250;
it was run against the old code (fails) and the fix (passes).
*Lesson:* never `x += await y` on shared state.

**12. Duplicate keys in JSON logs.** The sweep's child logger bound `date` and the result object also had
`date`, producing `{"date":"…","date":"…"}`. Removed the binding.

**Stage 2 result:** 117 tests; API and worker as separate processes with the queue between them; a manual
`npm run eod` swept 4 dates and correctly left an uncrossed limit order OPEN.

---

## Stage 3 — the frontend and live prices

**Built:** a `/ws` WebSocket endpoint in the API and a Groww-style React app: Explore (gainers/losers, live
NIFTY 50 table, search), stock page (candlesticks + order ticket), Orders (event timeline, cancel), Holdings
(live P&L, cash ledger), auth with a one-click demo account.

### Backend decisions

**Redis pub/sub as the fan-out bus.** Every API instance subscribes to `quotes` and `orders` and forwards to
*its own* sockets. So the API scales horizontally with no sticky routing for price updates, and the worker
never needs to know who's connected.

**Socket protocol:** `{"type":"subscribe","symbols":[…]}`; the server immediately sends a **snapshot from the
cache** for newly subscribed symbols (no blank prices until the next tick), then only ticks for those symbols.
Auth is **optional**: anonymous sockets get prices; a JWT in `?token=` (browsers can't set WebSocket headers)
also gets *that user's* order updates. A bad token closes with code **4401**.

**Production hygiene on sockets:** 30 s ping/pong heartbeat to drop dead connections; **slow-consumer
protection** (skip ticks when `bufferedAmount > 1 MB` rather than buffering unbounded memory); 16 KB max
message; 100-symbol cap per socket.

### Frontend decisions

- **React 19 + Vite + Tailwind 4 + React Query + React Router + lightweight-charts 5.** No `old-frontend/`
  existed, so the Groww look was built fresh: white canvas, green `#00b386`, red `#eb5b3c`, rounded cards,
  Indian number formatting (`₹10,00,000.00` via `Intl.NumberFormat('en-IN')`).
- **Shared validation.** The order ticket validates with the **same `placeOrderSchema`** the API uses (Vite
  aliases `@nse/shared` to its TypeScript source).
- **Idempotency in the UI.** The order ticket generates an `Idempotency-Key` **per intent**: kept when the user
  presses *Retry* after a network error (so a retry can't double-buy), regenerated as soon as any input changes
  or an order is accepted.
- **One socket per tab, shared.** A small `QuoteStore` owns the WebSocket, **ref-counts** symbol subscriptions
  across components, re-subscribes after reconnect, and reconnects with **exponential backoff + jitter**.
  Components read quotes through **`useSyncExternalStore`** keyed by symbol — when RELIANCE ticks, only
  components showing RELIANCE re-render, not the 50-row table.
- **Live candles.** The chart loads daily candles over REST; each tick updates *today's* candle in place
  (high/low/close) or appends one, so the chart moves with the feed.
- **Order updates** from the socket invalidate React Query caches (orders, portfolio, cash) and show a toast:
  "BUY 3 RELIANCE filled at ₹1,564.34".
- **Code splitting.** The chart library is the heaviest dependency; the stock page is lazy-loaded. Initial JS
  went from **559 kB → 330 kB**.

### Verification

Not just "it compiles": **Playwright drove a real Chromium** through the whole flow — demo login, live
indicator, price changing over the socket between two reads, a market buy (202 → toast "Order placed:
VALIDATED" → socket toast "filled"), a limit order, opening its event timeline, cancelling it, the holdings
page, and a 390 px mobile viewport (asserting no horizontal overflow). Screenshots in `docs/screenshots/` come
from these runs.

### Challenges in Stage 3

**13. Users were logged out on every page reload — the best bug of the project.**
*Symptom:* after a full reload, the header showed "Log in", and the order button was missing.
*Investigation:* tracing requests in Playwright showed `/auth/me` sent **with** a token (200), then **again
without** one (401), and the token had vanished from `localStorage`.
*Cause:*
```ts
useEffect(() => setUnauthorizedHandler(signOut), [signOut]);
```
`setUnauthorizedHandler` was `(fn) => (onUnauthorized = fn)` — an assignment expression, so it **returns
`signOut`**. The arrow body's implicit return handed that function to React **as the effect's cleanup**. React
18+/19 **StrictMode** deliberately mounts → cleans up → re-mounts effects in development, so it called
`signOut()` immediately after every mount.
*Fix:* block body for the effect, and make both setters return `void` so it can't happen again. A grep for
other expression-bodied effects found none.
*Lesson:* an effect's return value is semantically meaningful; StrictMode exists precisely to surface this.

**14. The candlestick chart rendered blank.**
*Symptom:* empty chart area, and `RangeError: Invalid language tag: en-US@posix` in the console.
*Cause:* lightweight-charts formats dates with `navigator.language`; the headless browser reported a POSIX
locale string that `Intl` rejects, and the exception killed rendering.
*Fix:* explicit `localization.locale: 'en-IN'` — more correct for Indian users anyway. *Lesson:* never let a
third-party widget depend on an unvalidated environment value.

**15. Volume shown as "₹4401303.00".** The global `₹` price formatter also applied to the volume histogram's
last-value label. Hid the label and price line on the volume series.

**16. A card ignored its spacing.** The "Your investments" card touched the heading below it because it was
wrapped in an inline `<a>`, and vertical margins from `space-y-*` don't apply to inline elements. `display:
block` fixed it — found only by looking at the screenshot.

**17. Vite's WebSocket proxy logged `ECONNRESET`.** Benign: emitted when the test browser closed its socket.
Noted and ignored.

**Stage 3 result:** 121 tests; full UI flow verified in a real browser on desktop and mobile; zero console
errors after the fixes.

---

## Stage 4 — production readiness

**Built:** OpenAPI/Swagger, rate limiting, GitHub Actions, Dockerfiles, Docker Compose, a k6 load test (run
for real), a Caddy + EC2 deployment, and this documentation.

### Decisions

**OpenAPI generated from zod** (`@asteasolutions/zod-to-openapi`). Request bodies and query params come from
the *same* schemas the routes validate with, so the docs cannot drift. A test asserts the spec covers all 16
operations and that `POST /orders` documents the `Idempotency-Key` header. Swagger UI needs inline scripts, so
it gets a relaxed CSP **only on `/docs`**; everything else keeps helmet's defaults.

**Rate limiting in Redis** (fixed window, `INCR` + `EXPIRE NX` in one `MULTI`): 20/min per IP on
login/register (brute force), 120/min per user on order placement. Shared across API replicas. It **fails
open** — if Redis is down we'd rather serve than reject. Returns `429` with `Retry-After` and `RateLimit-*` headers.

**Dockerfiles: three stages.** `build` (full install + `tsc -b`) → `prod-deps` (`npm ci --omit=dev --workspace
@nse/api`) → `runtime` (copies only `dist`, migrations and prod `node_modules`; runs as the image's unprivileged
`node` user, uid 1000; `HEALTHCHECK` built in). Package manifests are copied before sources so the dependency
layer stays cached until a lockfile changes. Result: ~70 MB compressed per image.

**Compose orchestrates start-up with health checks:** postgres/redis healthy → one-shot `migrate` container
(migrations + idempotent seed) must **complete successfully** → api and worker start → web. Redis runs with
**AOF** and `noeviction` because it holds queued orders and schedules, not just cache. An optional nginx `web`
service serves the production build and proxies `/api` and `/ws` same-origin, so `docker compose up` gives the
whole product at `localhost:8080`.

**Production overlay** (`docker-compose.prod.yml`): adds **Caddy** (automatic Let's Encrypt HTTPS, HSTS,
WebSocket proxying), unpublishes the API port, disables the nginx web (Vercel serves the frontend), and sets
memory limits. Both compose files and the Caddyfile were validated with the real tools
(`docker compose config`, `caddy validate`).

**CI:** lint → type-check (every package + web) → Jest against Postgres/Redis **service containers** with
coverage → web build → Docker builds for all three images (buildx + GitHub Actions cache).

### The load test (actually run)

Full methodology and analysis: [LOAD_TESTING.md](LOAD_TESTING.md). In short, against the full Compose stack on
one 4-vCPU machine:

- **Baseline (50 VUs):** 353 req/s, order placement p95 **105 ms**, **0 errors / 31,240**; all 3,103
  idempotent replays returned the original order id.
- **Correctness under load,** checked with SQL afterwards across 27,924 orders: no missing/duplicate ledger
  rows, no negative balances, every hold exact, holdings equal fills, complete event trails — **0 violations**.
- **Async fill latency:** p50 **23 ms**, p95 **40 ms** from API commit to worker fill.
- **Finding the bottleneck:** at 200 VUs one API replica pegs its Node event loop (~95% of a core) while Postgres
  idles at ~140%-of-a-core; throughput plateaus at ~325 req/s and latency rises — **no errors**, just queueing.
  Scaling to **3 API replicas** behind nginx raised throughput only 13% (397 req/s): each API dropped to ~50%
  CPU and **Postgres became the bottleneck** on the shared host. That's the honest result, and the next steps
  (fewer round trips per order, a balance snapshot, connection pooling, a bigger DB box) follow from it.

### Challenges in Stage 4

**18. `docker build` failed inside `npm ci`: "Exit handler never called" / "self-signed certificate in chain".**
*Cause:* the build environment intercepts TLS with its own CA (like many corporate proxies); the host trusts it,
fresh containers don't. *Fix:* an **optional BuildKit secret**:
```dockerfile
RUN --mount=type=secret,id=extra_ca,required=false NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca npm ci
```
Pass `--secret id=extra_ca,src=ca.pem` behind such a proxy; omit it everywhere else (Node ignores a missing
file). The CA is mounted only for that step and never lands in an image layer. *Lesson:* make environment
quirks opt-in at build time, never baked into the artifact.

**19. The web image build failed: `failed to resolve "extends": "../../tsconfig.base.json"`.**
Vite's esbuild reads the nearest `tsconfig.json` for files in `packages/shared`, which extends the root base
config — not copied into that Docker stage. One-line fix in the Dockerfile.

**20. The k6 script's remote import would hit the same TLS problem.** Replaced `jslib.k6.io`'s `uuidv4` with
k6's built-in WebCrypto `crypto.randomUUID()` — one less network dependency in a load test.

**21. k6 couldn't write its JSON summary** (`permission denied`): the k6 image runs as a non-root user and the
bind-mounted results folder wasn't writable by it. Ran the artifact-producing runs with `-u 0`.

**22. Rate limiting vs load testing.** The per-IP auth limit (20/min) would reject k6's setup, which registers
50–200 users from one IP. The limits are configuration, so the load-test run raises them via environment
variables, and the Jest setup sets them high — except for a dedicated test that sets them low and asserts
the 429s (and that one user's limit doesn't affect another).

**23. My own miscount.** I'd reported "15 endpoints" after Stage 1; the OpenAPI test I wrote asserted 17; the
generated spec said **16**. The test was right to fail — the spec, generated from the actual routes, is the
source of truth. (16 REST operations + 1 WebSocket.)

**24. A contaminated benchmark.** A k6 re-run happened while the Jest suite was also running on the same
machine: p95 went from 105 ms to 126 ms. Discarded it and re-ran on a quiet machine (p95 105 ms again — the
first result was reproducible). *Lesson:* benchmarks need an idle host, and you should run them twice.

**25. Scaling out didn't scale.** Expected roughly 3× from 3 API replicas; got +13%. `docker stats` showed why
(Postgres + a CPU-saturated 4-vCPU host). Kept the result and wrote up the analysis instead of tuning the test
until it looked good.

---

## Stage 5 — shipping it: CI for real, an index rejig, and a free deployment

**Built:** the first real CI run, a fix for NIFTY 50 index changes, AWS tooling (later shelved), and a
**US$0 deployment**: Render + Neon + Redis Cloud + Vercel, with a GitHub Actions cron.

### Getting it onto GitHub, and CI's first run

Once the Claude GitHub App was installed on the repository, the 11 local commits were pushed and **GitHub
Actions ran for the first time: all four jobs green on the first attempt.** That covered lint, type-check, the
full test suite against Postgres/Redis service containers, the web build, and the api/worker/web Docker images.
Until then CI had only ever been validated as YAML, so this closed the biggest "never actually ran" gap.

### The NIFTY 50 changed under us

A web search for the current constituents found that NSE's September 2026 review **replaced Wipro with BSE
Ltd**. Updating the list was easy. The interesting part was what the change exposed:

**26. A test failed because the database remembered Wipro.**
*Symptom:* the ingest test expected 250 candles (50 symbols × 5 days) and got 255. *Cause:* seeding only
*upserted* instruments and never retired removed ones, so the "NIFTY 50" quietly became 51 stocks. Index
reviews happen twice a year, so this would recur. *Fix:* `syncUniverse()` upserts the current members and
marks the rest inactive. *Design decision:* a retired stock is **exit-only**. BUY orders are rejected with
`INSTRUMENT_NOT_TRADABLE`, but SELLs still fill, so users holding Wipro aren't trapped. That mirrors how a
broker treats a restricted scrip. Tests cover both the sync and the exit-only behaviour.

### AWS, then not AWS

The plan was a single EC2 host. Two discoveries reshaped it:

**27. The sandbox can't SSH anywhere** (outbound port 22 is blocked), but it **can** reach AWS APIs over HTTPS.
So I designed for **SSM Run Command** instead of SSH: a CloudFormation template (EC2 with IMDSv2 and an
encrypted disk, an 80/443-only security group, an SSM instance role, a private S3 artifact bucket, and an
operator IAM policy scoped to *that one instance*), a `ssm-run.sh` helper (tested against a stubbed `aws` CLI
for polling, output and exit-code propagation), and `ship.sh`, which delivers unpushed commits as a `git bundle`
through S3. `cfn-lint` clean. It's kept as the self-hosted option.

**28. "Don't spend AWS credits."** The deciding requirement was cost: free, or not at all. That ruled out EC2
and led to the free-tier design below. The lesson for the story: the architecture didn't change. Only where it
runs did, plus two settings that the hosting forced.

### The free-tier design

Research on current free tiers (they change often, so I checked rather than relied on memory) gave:

- **Postgres → Neon Free**: 1 GB per project, scale-to-zero, no card.
- **Redis → Redis Cloud Free (30 MB), not Upstash.** Upstash's free plan caps usage at 500K commands a month,
  and BullMQ keeps traffic flowing even when idle (users report millions of commands a month on idle queues).
  A command quota is the wrong shape for a queue.
- **Compute → Render free web service.** It has two constraints: **no free background workers**, and it
  **sleeps after 15 minutes idle**. (Oracle's Always Free VM would run Compose unchanged, but needs a card and
  capacity is unreliable.)
- **Frontend → Vercel Hobby.**

Each constraint got a small, explicit feature rather than a hack:

| Constraint | Feature |
|---|---|
| No free worker service | `RUN_WORKER=true` starts the *same* BullMQ consumers and schedulers inside the API process. To make that possible without one app importing another, `createWorkers`/`registerSchedules` moved from `apps/worker` into `packages/core`. Both deployables now just wire them up. |
| No pre-deploy step | `MIGRATE_ON_START=true`. The advisory lock built in Stage 1 makes concurrent boots safe, so the earlier design paid off. |
| Sleeps when idle, so Redis-stored schedules can't fire | `POST /internal/jobs/:job`, protected by `CRON_SECRET` (constant-time compare of SHA-256 digests; returns **404** when no secret is configured, so the route doesn't even exist). A GitHub Actions workflow wakes the API at 16:00 IST and enqueues `eod-close`. If the BullMQ scheduler also fires while awake, the job runs twice, which is harmless because EOD is idempotent. |
| Empty managed database | `SEED_ON_START=true` runs a shared `bootstrapData()` (also used by `npm run seed`) in the background after `listen`, so health checks pass while candles load. It ingests **only missing days** on restarts. |
| Free Redis ops/sec cap | A quote refresh used **2 commands per symbol**; last-known prices now live in **one hash** written by a single `HSET`, so it's N + 1. A test reads `total_commands_processed` on the real server to lock that in. Polling is also **market-hours aware**: outside 09:15–15:30 IST on weekdays, at most every 10 minutes. |

**29. Is the Redis URL really honoured?** A hosted Redis URL carries a host, port, password and TLS. A quick
check showed **ioredis silently ignores a `url` key in its options object** and falls back to `localhost:6379`.
That's exactly how a local test could pass while production broke. Reading BullMQ's source showed it
explicitly unpacks `url` and passes it to ioredis as the connection string, and our own clients use the string
form. So there was no bug. But I verified it, including a `rediss://user:pass@host:port` URL, rather than
assume it.

**30. The Docker health check hard-coded port 4000.** Render injects its own `PORT` (10000). The `HEALTHCHECK`
now uses shell form with `${PORT:-4000}`. Found by running the image with Render's settings, not by reading it.

**31. `sslmode=require` doesn't mean what it says in node-postgres.** Recent `pg` treats it as `verify-full`
and prints a deprecation warning. Neon's certificates are publicly trusted, so the guide asks for
`sslmode=verify-full` explicitly. `channel_binding=require` in Neon's URL is ignored by the parser, so pasting
Neon's default string doesn't break anything.

### Verifying a deployment without the accounts

The sandbox can't create Render, Neon or Redis Cloud accounts, so everything that *could* be proven locally was:

1. `render.yaml` validated against **Render's published JSON schema**; workflows against GitHub's schema.
2. The **production image** run exactly as Render would run it (`PORT=10000`, in-process worker, migrate and
   seed on start) against an **empty** database: healthy, non-root, migrated, seeded, queued orders filled.
3. A **restart** shown to be incremental and idempotent: 0 migrations, about 7 days of candles, still 6 demo orders.
4. The **cron endpoint**: 404 without a secret, 401 with a wrong one, 202 with the right one, and `eod complete`
   in the logs.
5. The **frontend built the way Vercel builds it** (`VITE_API_URL` on another origin), served from a different
   port and driven in Chromium. REST and the WebSocket both went cross-origin, the CORS preflight allowed
   `Idempotency-Key`, unknown origins got no CORS headers, and a market order was filled through the queue and
   confirmed over the socket.

**Stage 5 result:** 140 tests green locally and in CI; a free deployment that's one Blueprint click plus three
pasted connection strings ([FREE_DEPLOYMENT.md](FREE_DEPLOYMENT.md)).

---

## Challenge log

| # | Stage | Problem | Root cause | Fix |
|---|---|---|---|---|
| 1 | 1 | npm ERESOLVE | `@eslint/js@10` vs `eslint@9` peer range | Pin eslint 9 |
| 2 | 1 | yahoo-finance2 v2 deprecated | Upstream | v3 (`new YahooFinance()`), verified CJS build |
| 3 | 1 | Yahoo blocked (403) | Sandbox egress | `PriceProvider` + deterministic fake |
| 4 | 1 | Fake prices O(n), unreadable | Over-engineering | Closed-form waves + seeded noise |
| 5 | 1 | 26 tests failed on one query | `$3` inferred as enum and text | Explicit `::casts` |
| 6 | 1 | Flaky tests | Parallel files truncating one DB | `maxWorkers: 1` in config |
| 7 | 1 | Shell killed itself | `pkill -f` matched own cmdline | `[s]rc/...` pattern |
| 8 | 1 | `dump.rdb` committed | Redis started in repo dir | Remove + `.gitignore` |
| 9 | 1 | Push 403 | GitHub App not installed | Pending access; commits kept locally |
| 10 | 2 | Reconciler retry would be deduped | BullMQ keeps failed job ids | Suffixed job id for re-dispatch |
| 11 | 2 | Ingest count 42 instead of 250 | `x += await y` lost updates | Await first, then add; regression test |
| 12 | 2 | Duplicate `date` in logs | Child binding + payload | Remove binding |
| 13 | 3 | Logged out on reload | Effect returned `signOut` as cleanup; StrictMode | Block body; setters return void |
| 14 | 3 | Blank chart | Invalid `navigator.language` | Explicit `en-IN` locale |
| 15 | 3 | Volume shown in ₹ | Global price formatter | Hide volume last value |
| 16 | 3 | Card spacing | Margin on inline `<a>` | `block` |
| 17 | 3 | `ECONNRESET` noise | Browser closing socket via proxy | Benign |
| 18 | 4 | `npm ci` fails in Docker | TLS-intercepting proxy CA | Optional BuildKit secret |
| 19 | 4 | Web image build fails | tsconfig base not copied | Copy it |
| 20 | 4 | k6 remote import | TLS interception | Built-in `crypto.randomUUID()` |
| 21 | 4 | k6 summary permission | Non-root container on bind mount | Run as root for artifacts |
| 22 | 4 | Rate limits block load test | Correct behaviour | Limits are config; dedicated tests |
| 23 | 4 | Endpoint count wrong | My miscount | Spec-generated test is the truth |
| 24 | 4 | Noisy benchmark | Tests running concurrently | Re-run on idle host |
| 25 | 4 | 3× replicas → +13% | Postgres/host CPU bound | Analysed and documented |
| 26 | 5 | NIFTY 50 had 51 members | Seed never retired removed stocks | `syncUniverse()`; retired stocks exit-only |
| 27 | 5 | Can't SSH to a VM | Sandbox blocks port 22 | SSM Run Command + CloudFormation (kept as option) |
| 28 | 5 | "Don't spend credits" | Cost requirement | Free tiers: Render + Neon + Redis Cloud + Vercel |
| 29 | 5 | Would hosted Redis URLs work? | ioredis ignores `url` in options | Verified BullMQ unpacks it; string form everywhere |
| 30 | 5 | Health check on wrong port | `HEALTHCHECK` hard-coded 4000 | `${PORT:-4000}` (shell form) |
| 31 | 5 | Confusing `sslmode` semantics | pg treats `require` as `verify-full` | Document `verify-full` |

---

## What I would do next

In priority order, each grounded in something measured or observed above:

1. **Cut Postgres round trips per order.** Placement does ~10 queries; caching the instrument list in memory,
   dropping the post-dispatch re-read in queue mode, and folding the idempotency lookup into the insert would
   remove ~3 — the load test says Postgres is the next bottleneck.
2. **Balance snapshot column** on `users`, updated in the same transaction as each ledger insert; keep
   `SUM(ledger)` as a nightly reconciliation check instead of the hot-path read.
3. **Transactional outbox** to replace the reconciler's up-to-90-second recovery window.
4. **Intraday limit fills** from the live quote stream (the quote poller already has the data), keeping the EOD
   sweep as the backstop.
5. **Per-worker test databases** so integration tests run in parallel again.
6. **Observability:** OpenTelemetry traces using the existing request id as the trace correlation id; RED
   metrics (rate, errors, duration) on placement and queue latency.
7. **Managed services:** RDS + ElastiCache + ECS when one host stops being enough — nothing in the code assumes
   a single process.

## Numbers to remember

| | |
|---|---|
| Endpoints | 16 REST + 1 WebSocket |
| Tables | 7 |
| Tests | 140 (59 unit, 81 integration) · 90% statements · CI green |
| Throughput (1 API, 50 VUs) | 353 req/s, p95 105 ms, 0 errors |
| Async fill latency | p50 23 ms, p95 40 ms |
| Correctness under load | 0 violations / 27,924 orders |
| Image size | ~70 MB compressed |
| Hosting | US$0: Render + Neon + Redis Cloud + Vercel + GitHub Actions cron |
