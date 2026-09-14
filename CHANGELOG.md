# Changelog — arcaeon-witness

## 2026-09-13 — Merkle batching, the caller: the sealer exists, and the batch does not seal early

`6c0bb93` left one sentence in `MERKLE_BATCHING_DESIGN.md`: *"Until the sealer exists,
nothing calls `sealBatch` in production. The library is complete and the caller is not."*
This is the caller. Suite 236 → 258.

- **`lib/_pending.js` — the state a serverless function cannot hold.** §11 Q3's premise is
  that "a serverless request cannot reliably close a batch it did not open," and the reason
  is that nothing in `_batch.js` or `_merkle.js` survives an invocation. One JSON document
  under CAS in the private usage repo holds the open batch's leaves in acceptance order and
  §6.1's pending head per namespace. **A read that fails throws; a 404 returns null** —
  "I cannot see it" and "there is nothing there" stay different answers, which is the whole
  fail-closed hinge.
- **The trigger is `lib/_batch.js`'s, quoted and called, not restated.** §3.4: *"Seal when
  any of these fires, whichever comes first: 1. `batch_interval_seconds` elapsed since the
  batch opened (default proposal: 60s). 2. `max_leaves` reached... 3. A deadline forces it
  — any pending leaf whose `next_pin_due_by` is within `seal_safety_margin` of expiring."*
  `lib/_sealer.js` asks `sealTrigger` and does **nothing, not one write anywhere**, when the
  answer is null. One addition, a carry and not a cadence: leaves left behind by a seal that
  already failed seal on the next run regardless of the interval (§10 T4).
- **Fail closed, and it is the sealer that refuses.** A sealer that cannot read the pending
  head returns `pending_head_unreadable`, writes nothing — no root, not even an orphan leaf
  list — and never seals a batch it cannot prove complete. Every read that can refuse (the
  pending head, the chain tip, the leaf shapes) happens **before any write**. Sabotaged both
  ways before shipping: collapsing the unreadable case into `no_open_batch` turns both
  fail-closed tests red; making the trigger always fire turns "does not seal before the
  interval" and "a deadline forces it" red.
- **The close is the boundary, and it is before the seal, never after.** A leaf appended
  after a root is computed would claim membership in a tree it is not in. Closing first
  freezes the leaf set; the close and `api/pin.js`'s append contend for the same document
  sha, so a pin racing a seal either wins (its leaf is inside the sealed batch — the close
  409s, re-reads, and absorbs it) or loses (its append 409s, re-reads, and lands in the next
  batch). Both directions are tested from the *published* leaf list, not from the sealer's
  own report.
- **A published root is never re-sealed.** The hazard: a root that commits and then fails to
  clear its bookkeeping slot looks exactly like a seal that failed, and re-sealing would put
  the same leaves under a second root. The sealer asks the **pin repo** whether a root exists
  at that batch id rather than trusting its own note-to-self — a question about our memory
  turned into a question about the published record.
- **§6.3 is finally a backstop.** §6.1's pending head refuses a same-rows/different-chain
  leaf into the tree at accept time. The seal-time re-check stays, and is not redundant: the
  contents API gives no read-your-writes across instances, so a stale cross-instance read can
  still admit a conflicting leaf, and a test seats exactly that shape and proves the later
  leaf is still dropped and the observation still written.
- **`api/pin.js` gains nine lines that cannot fail a pin.** The accumulation hook runs after
  the record is committed, on both the advance and the heartbeat path (§11 Q4, decided:
  heartbeats stay in the tree), and swallows every error to a loud log. §9 Phase 1 is "Keep
  per-pin commits exactly as they are" — a shadow-run bookkeeping failure must not turn a
  committed pin into a 502 after the fact. The dropped leaf is exactly what Phase 1's week of
  reconciliation exists to catch.
- **`tools/seal_batch.js` — §11 Q3 decided: an operator command, not a 13th function.** `api/`
  is at the Vercel Hobby 12-function cap (`9e8b060`); opportunistic sealing is refused by the
  design's own parenthesis ("starves a quiet witness"); a seal mode on a public endpoint would
  need a new operator-auth surface built before the first seal, and a command needs none —
  running it already requires the token the seal spends. Exit 1 means **refused, nothing
  written**, so a scheduler can alert on fail-closed specifically.
- **Phase 1 is off until someone starts it.** Accumulation requires `WITNESS_BATCH_SHADOW`.
  §9 Phase 1 is "Run it until a full week reconciles clean" — an operator act with a start
  date and a week of watching, not a state that arrives with the next unrelated deploy. The
  start procedure and the reconciliation check are written into §9.
- **The one that matters, re-proved against the caller.** With the accumulator live on every
  pin and a root committed by the sealer, an old-style pin verifies through the real
  `api/verify` handler with a byte-identical body — and the claim "by exactly the path it does
  today" is checked against the mock store's own **read log**: the verifier read
  `pins/<ns>/latest.json` and nothing under `batches/`. A frozen hand-written pre-batching
  record still verifies `witnessed:true` the same way.
- **Two corrections written into the design.** §6.1 called the meter/balance store "a durable
  non-GitHub store"; it is a private GitHub repo (`lib/_meter.js:22-24`, `lib/_balance.js:64`),
  so §11 Q2's read-your-writes requirement is **not** satisfied and the honest statement is
  first-guard-plus-backstop. And §6.1's pin-refusing 502 is deliberately **not** built: its
  premise is "if `latest.json` is only written at seal time," which is Phase 4, not Phase 1 —
  adding a 502 class to a live money path for a window that is not yet open would be paying a
  real availability cost for a hypothetical one.

## 2026-09-13 — Merkle batching, the mechanism: N pins, one tree, one root, a proof each (`6c0bb93`)

`MERKLE_BATCHING_DESIGN.md` §3 and §5 implemented, plus §6.3. Its own statement of the
contract, §1: *"Group every pin accepted in an interval into one Merkle tree and commit
only the root. Write cost becomes O(1) per interval — a fixed small number of commits
regardless of whether the interval held 1 pin or 10,000."* Suite 204 → 236.

- **`lib/_merkle.js` — the tree, and nothing else.** No store, no clock, no network,
  because §8 requires `verify_inclusion` to be "pure and dependency-free. If proving
  inclusion requires calling us, the proof is not a proof," and a require list is how a
  stranger checks that. Leaf = `SHA256(0x00 || json_c14n_v1(leaf_object))` over §3.1's
  nine fields; node = `SHA256(0x01 || left || right)`; **odd node PROMOTED, not
  duplicated** (§3.2 — the Bitcoin shape makes distinct trees collide, CVE-2012-2459
  lineage, and a test asserts the two roots differ); leaf order is acceptance order and is
  part of the commitment.
- **The canonicalizer was already here.** §3.1 forbids a second one. `lib/_distill_core.js`
  already carries the JS side of `json-c14n:v1` (`jdump(value, true)`), so `_merkle.js`
  calls it. Residual, documented at the call site rather than discovered later: JS cannot
  tell `24.0` from `24`, so an integral `cadence_hours` canonicalizes as `"24"`.
- **`verifyInclusion` is §5's published algorithm verbatim**, including the derived path
  direction — no left/right flags, because "a verifier that trusts the flags over the index
  is exploitable." It returns a **typed reason, not a boolean**: §5 requires inclusion and
  publication to stay "two separate claims, never merged into one boolean," and an unknown
  recipe label returns `unknown_recipe` rather than passing with a warning.
- **`lib/_batch.js` — two writes per batch, whatever the leaf count.** `leaves.json` then
  `root.json`. **The failure atom is the single `root.json` write**, and it is enforced
  structurally, not described: `buildProof` throws on an unsealed batch, so no pin can be
  handed a proof citing a root that was never published. A failed seal leaves no root, no
  proof, an unmoved chain tip, and a leaf set handed back for the next batch to absorb
  (§10 T4, which is honest that correlated failure is a real cost of batching).
- **`prev_root` is the equivocation fence and it costs no extra write.** The chain tip is
  read off the previous published `root.json`, which already carries its own root — no
  pointer file, so no third write per batch and nothing that can rewind.
- **§6.3's seal-time conflict re-check drops the LATER leaf** — `api/pin.js:183-184`'s rule
  is that a conflict "never advances accepted state" — and writes its observation
  immediately and unbatched, per §6.2: "the one write in this system with a live adversary
  attached."
- **The 409 retry from `aaa1378` governs every write here and is not reimplemented.** Every
  write is a `store.putFile`; a test greps `lib/_batch.js` for `fetch(`, for
  `maxAttempts|PUT_RETRY|putOnce`, and counts the `store.putFile` call sites, so the absence
  claim names its searches instead of asserting itself.
- **Nothing about publication changed, and that is the point.** `api/pin.js`,
  `api/latest.js` and `api/verify.js` are untouched — §9 Phase 1, "Keep per-pin commits
  exactly as they are." Two tests hold the line the hard way: one runs the real pin handler,
  snapshots the real `api/verify` response, seals that pin into a batch, and asserts the
  response is unchanged; the other verifies a frozen hand-written pre-batching record with a
  batch root sitting in the same repo.
- **MEASURED, not estimated.** Counted from the fixture's own `putLog`, not a number the
  code reports about itself: 10 pins through `api/pin.js` cost **20** pin-repo writes
  (**2.0 per pin**); one sealed batch of 10 leaves costs **2** (**0.2 per pin**); 1 leaf and
  100 leaves both cost 2.
- **Found while building.** A seal that dies before its root write **retires** its batch id
  — the orphan `leaves.json` is still there and §9 promises nothing is ever rewritten — so
  id gaps are normal and `batch_id > 1` stopped being the same question as "something came
  before me." `readPrevRoot` now walks back over the gaps and refuses to *claim* a chain
  start it did not establish: an exhausted lookback is a typed `chain_break`, not a null.
- **Deliberately not built, listed in the design's status block rather than left to be
  discovered:** the pending-head store (§6.1), `inclusion_due_by` / `inclusion_state` / the
  `cannot_determine` pending grade (§4), the `/status` self-grading counters (§7), the
  `GET /api/proof` endpoint (§5 — `api/` is at the Vercel Hobby 12-function cap, confirmed
  at `9e8b060`, so it needs an `?op=` mode, not a 13th file), the client verifier (§8,
  another repo), and the scheduled sealer (§11 Q3). Until the sealer exists nothing calls
  `sealBatch` in production: the library is complete and the caller is not.

## 2026-09-13 — `putFile` retries the 409 that was losing concurrent pins (task 093)

The ceiling probe measured the defect on its way to measuring something else: ten
concurrent writers on one branch issued 532 requests and took **465 409s**. Every one of
those writers was creating its own distinct file, so nothing raced for a path — the
**branch ref** moved under each PUT. `lib/_store.js:putFile` did not retry, so a pin that
raced another pin simply failed. Production pins run on serverless instances that
overlap, so this was live, not a lab curiosity. This is not the batching design; it is
the correctness floor under it.

- **`putFile` now retries a 409**, and only a 409 — the 422 create-race keeps its
  existing one-shot `err.conflict` contract, and a 5xx is still a plain failure. Four
  attempts, ~1 s base, doubling, jittered 0.5x–1.5x. The backoff is ours to invent
  because the probe found the secondary limit carries **no `Retry-After`** and refills in
  ~16 s, so there is no server hint to honour.
- **It re-reads before it re-writes, and the two 409s are not the same event.** If the
  path is *unchanged* since the caller read it, the 409 was branch-ref contention and the
  caller's object is re-PUT verbatim — nothing was overwritten because nothing moved.
  If the path *moved*, another writer owns it now, and a blind re-PUT would erase that
  writer's row, so it is never done: the caller's optional `rebuild` hook is handed the
  fresh json and decides, and with no hook the call fails typed (`err.stale`, with
  `err.conflict` still true so every pre-existing caller behaves exactly as before).
- **The result carries `attempts`.** A pin that took three tries says so instead of
  reporting a clean single write; `POST /api/pin` surfaces it as `write_attempts`. A
  budget that runs out throws — there is no fabricated success anywhere on this path.
- **`api/pin.js` supplies the one rebuild that is actually needed**, for `latest.json`.
  The merge rule is short because `latest.json` is a *pointer*, not a row: the rows are
  the numbered seq records, which are created and never rewritten, so racing here can
  never overwrite another pin's row. What it could do is rewind the pointer over a newer
  record, and that is forbidden — a witness never goes backward. So a fresh `latest` at a
  seq >= ours abandons the write (`latest_pointer_advanced:false`); only a
  strictly-behind pointer is advanced. Our record stays recorded at its own numbered path
  either way.
- **Tests** (`test/store_put_retry.test.js`, 9 new): 409-twice-then-201 lands on attempt 3
  with the *fresh* sha on the wire (bound to a sha the fixture authored, not one the code
  reported about itself); 409 five times gives up with a plain typed error and an
  untouched file; and — the one that matters — after a genuine race the merged content
  contains **both** writers' rows, with a paired no-rebuild case proving the racer's row
  survives rather than being clobbered. Sabotage check: replacing the retry branch with an
  unconditional `break` turns 6 of the 9 red (`attempts: 1`, `Error: github PUT
  race/t1.json -> 409`); restoring turns them green.
- `test/pin.test.js`'s wedge-refund regression had its forced-conflict budget raised
  10 → 40. `putFile` now spends up to four PUTs per call, so four passes issue up to 16,
  and a budget of 10 would have let the 11th **succeed** — turning that regression green
  for the wrong reason. The test's intent is unchanged.

Suite: **195 → 204**, all green.

## 2026-09-13 — the GitHub write ceiling, measured (task 083, open question 1 closed)

`MERKLE_BATCHING_DESIGN.md` §1 had said "we have not measured GitHub's secondary rate
limits for sustained contents-API writes to one branch" since August, and §11 carried it
as open question 1. It blocked any customer-facing throughput claim by its own standing
rule. Measured now; §1 and §11 rewritten with the numbers and the date.

- **New `tools/ceiling_probe.js`** — sustained contents-API PUTs until GitHub refuses.
  **Scratch-repo only**: it refuses to run unless the target repo name contains "probe",
  and refuses outright if the target is the live pin repo. The reason is not squeamishness
  about junk commits (though the pin log's whole value is that its history is meaningful)
  — GitHub enforces secondary limits **per authenticated identity, not per repository**,
  so tripping the limit on any repo puts the *serving* token into cooldown. The scratch
  repo avoids the junk history; only running in a quiet window avoids the cooldown. The
  token is read from `GITHUB_PIN_TOKEN` (the same var `lib/_store.js` reads) and every
  string leaving the process goes through a redactor.
- **Numbers** (personal User account, plan `free`, classic PAT, 2026-09-13): 577
  sequential writes accepted in 360 s (96/min) with **zero** refusals — the sequential run
  never found a ceiling, it hit the probe's own time cap. A 4 KB payload gave 279 in 180 s
  (93/min), median latency 626 ms vs 603 ms at 64 bytes: **payload size does not move it**,
  a single writer is latency-bound at ~95/min.
- **What actually trips it is concurrency, and the recovery is fast.** Ten concurrent
  writers took a 429 ("You have exceeded a secondary rate limit", **no `Retry-After`**)
  after 65 accepted writes in 49 s, and recovered in **~16 s**. So it is a burst allowance
  that refills in seconds, not an hourly ban.
- **The finding with teeth, which a sequential-only probe would have missed:** the limiter
  counts *requests*, not accepted writes, and **branch contention bites before the rate
  limit does**. Of that burst's 532 requests, 465 were **409s** — ten writers committing to
  one branch move the ref under each other and `lib/_store.js:putFile` has no retry. Ten-way
  concurrency moved *less* (80/min accepted) than one sequential writer (96/min) for eight
  times the request budget. Adding write concurrency to a single branch is not a throughput
  lever; removing writes is, which is the batching case.
- **Two scratch repos created and deleted** (`arcaeon-ceiling-probe-2026-09-13`, `…-13b`),
  each `DELETE -> 204` with a confirming `GET -> 404`. The live pin repo was never written
  to. The primary hourly limit was never approached (5,000/hr; never below 3,600 remaining).
- Standing rule kept, not weakened: **no customer-facing pins-per-hour figure without a
  dated measurement.** ~47 pins/min (two writes per pin) is an internal planning figure.

## 2026-09-12 — bulk verify: `POST /api/verify?op=bulk` (K-017/K-018/K-019, BATCH_500 lane K)

No 13th function — `api/` is at the Vercel Hobby cap of 12 (confirmed by direct
listing before this shipped: badge/balance/credit/distill/fulfill/health/latest/
pin/renew/status/stripe-webhook/verify). Bulk verify is a MODE on the existing
`api/verify.js`, dispatched on `?op=bulk` the same way `api/fulfill.js` already
dispatches `?op=prefix-available` — no new vercel.json rewrite required for the
internal call shape. Design: `BULK_VERIFY_DESIGN.md`.

- **Request:** `POST /api/verify?op=bulk` with `{items: [{ns, rows, chain|digest}, ...]}`
  — the same three fields the single-item `GET /api/verify` already takes, per item.
- **Cap:** fixed at 20 items. An over-cap batch (or a non-array/empty `items`) is
  refused WHOLE with a 400, before any store read — zero partial processing, mirroring
  `arcaeon_receipt/cite_batch.py`'s cap-or-refuse pattern. Chosen because a single
  verify lookup can already cost up to `MAX_HISTORY_SCAN` (50) store reads in the
  worst case; 20 bounds a batch's worst case to 1,000 reads rather than leaving it
  unbounded.
- **Response:** `{ok, count, results: [...]}`, one result per input item, in request
  order, each carrying `http_status` plus exactly the body the single-item endpoint
  would have returned for that input. **No new verdict word** — `witnessed`
  (`true`/`false`/`null`) and every `reason` string are the identical set
  `api/verify.js` already emitted, because bulk mode calls the SAME `verifyItem`
  function the single-item path calls, once per item — not a second hand-copy of the
  lookup logic.
- **Never short-circuits:** a malformed item (bad `ns`/`rows`/`chain`) or a store-read
  error on one item produces that item's own error-shaped result and processing
  continues to the next item; the loop is a plain sequential `for`/`await`, never a
  `Promise.all` that would let one rejection take down the whole response.
- `api/verify.js`'s existing single-item logic was refactored (not rewritten) into
  `verifyItem()` returning `{status, body}` instead of writing to `res` directly, so
  both the GET single-item path and the new bulk path share one implementation.
  Existing single-item behavior is byte-identical; the full pre-existing suite
  (`test/verify.test.js`, 6 tests) still passes unchanged.
- New `test/verify_bulk.test.js` (9 tests): mixed valid/invalid/never-witnessed batch
  with per-item verdicts in order, the `digest` alias inside a bulk item, over-cap
  refusal with zero store reads, exactly-at-cap acceptance, malformed `items` shapes,
  and a mid-batch miss not aborting its neighbors.
- `npm test`: 186 → 195, all green.
- **What's still open, not decided here:** whether the per-IP rate limiter should
  scale with batch size (currently counts a bulk call as one hit, same as any other
  request — see BULK_VERIFY_DESIGN.md's "Rate limiting" section for the reasoning and
  the flagged trade-off) and whether a public `/api/verify-bulk` alias is worth adding
  via a vercel.json rewrite. Neither blocks this pass; both are named for whoever
  picks this lane up next.

## 2026-08-30 — independence disclosure: k=1, stated plainly

The status page and its JSON twin now disclose the root count directly: a
k=1 stat cell + explainer paragraph on /status, and an `independence` block
(`roots: 1, disclosed: true`) on /api/status.json. Rationale (owed to an
external reviewer, sram): eight namespaces signed by one operator is k=1,
a count of derivation roots, not signatures — and the determinate number
beats an indeterminate impression. The health tri-state (ok/degraded/
indeterminate) is unchanged; it grades freshness/gradeability, a different
axis. The k value changes only when a namespace under someone else's root
actually exists — that claim stays behind the publish gate until real.

Reverse-chronological. Every entry says what changed and why, and names the
reviewer whose objection forced it where there was one. Public review is the
reason this thing works; the credit belongs in the record, not in a thank-you.

## 2026-08-30 — Rev-2b: the prefix picker learns to answer (`/api/prefix-available`), and the commands become copyable

**COMMITTED NOWHERE AND DEPLOYED NOWHERE — working tree only; no Vercel action, no
Stripe action.** Founder design, Daniel 12288/12291: *"shouldnt we let our users pick a
prefix that isnt selected"*. Rev-2 gave the buyer a prefix FIELD and no way to know
whether the pick was free — the only feedback was a rejected form POST after the fact.
`npm test` 132 → 176, all green.

**1. New `GET /api/prefix-available?prefix=<p>` (`lib/_prefix_check.js`).** Validates
format (the existing `keys.validatePrefix`), then answers `{available}` against the same
universe the mint path uses — `WITNESS_KEYS` env bindings plus every issued-key record —
with the same two-way overlap rule (`acme-` and `acme-labs-` reject each other in BOTH
directions). Free → `200 {available:true}`. Taken → `200 {available:false, reason:"taken"}`
plus three alternatives that are each format-valid and verified free, and which DIVERGE
from the taken stem (`acme2-`, not `acme-hq-` — an extension would collide right back).
Invalid → `400`. The colliding prefix is never echoed: it belongs to another customer.
Store failure → `503 {available:null}`, never "free" — an unreadable store must not talk a
buyer into a pick the mint path will refuse. Input is trimmed+lowercased exactly as
`api/fulfill.js` normalizes an explicit pick, or the endpoint would answer about a
different string than the one minted.

**Routing, because `api/` is at Vercel Hobby's 12-function hard cap:** the public path is
a `vercel.json` rewrite onto `/api/fulfill?op=prefix-available`, dispatched at the top of
that handler before its session gate — the same trick already in use for
`/api/status.json`, and the same reasoning that put the balance page on the balance
function. A test asserts both the rewrite rule and that `api/` still holds ≤12 files:
without the rewrite this endpoint exists in code and 404s in production.

**Cached 20s, per warm instance.** `keys.listPrefixes()` is a directory listing plus one
read per issued key; a debounced picker asks once per typing pause and would otherwise
fan that out every time. The cache lives only in this module — the mint path calls
`listPrefixes()` directly and never sees it, so a stale entry can make the ADVICE briefly
wrong and can never widen what an actual mint accepts.

**2. The picker checks live (`lib/_prefix_ui.js`).** 400ms debounce with `clearTimeout`
on each keystroke, a sequence guard so a slow answer for `acm` can't repaint over a fast
one for `acme-`, three distinct states (free / taken / couldn't-check), and the three
alternatives as one-click buttons. "Couldn't check" is never painted as free, and the
submit button is never disabled by the check — the POST re-validates server-side, and a
client check that is itself unsure must not be able to lock a paying buyer out of a key
they have already paid for.

**3. The commands are copy boxes with the prefix already in them.** New `copyBlock()` in
`lib/_page.js` (multi-line sibling of `copyBox`) — the four-line curl was a bare `<pre>`
the buyer had to select by hand, which is exactly where a half-selected command comes
from. The picker previews it live as they type; the success page renders the final one.
`<YOUR KEY>` stays a placeholder on purpose even on the page showing the key: a one-click
copy of a command carrying a live bearer key lands that key in shell history.

**BOUNDARY, stated in three files and asserted in the suite: none of this mints.** The
availability answer is advisory. Key issuance stays exactly where it was — behind
`api/fulfill.js`'s server-side Stripe session verification, with the un-cached
`listPrefixes()`/`prefixConflicts()` pair as the authoritative gate — or in an operator's
hands per `projects/online_business/FULFILLMENT_RUNBOOK.md`. Tests assert the picker
route's `putLog` is empty and that the client script's only `fetch` is the read-only
availability URL.

**4. Two new test files, 44 tests, mutation-verified** (`test/prefix_available.test.js`,
`test/prefix_ui.test.js`). Nothing stubs `listPrefixes` — a test that stubs the
availability source cannot catch the availability source being wrong; these drive the
real fan-out against the mock GitHub store. The curl command exists twice (server render,
browser preview) and `test/prefix_ui.test.js` EVALUATES the browser copy out of the
shipped script source and diffs its output against the server function across a table of
prefixes, so drift between the preview and the receipt is a red instead of a support
email. Planted reds, all confirmed: debounce removed → 1 fail; substitution drifted to
`prefix + "-main"` → 4 fails; availability forced to always-free → 8 fails; the dispatch
removed → 25 fails; the rewrite dropped from vercel.json → 1 fail.

## 2026-08-30 — Ops: retired-namespace env var re-set (no code change)

Live `status.json` read `degraded` with `overdue:1` (`velouria-audit-20260819`, the 8/19
one-shot) while `retired_namespaces` listed only two names. The 8/24 deploy-gate note predicted
this exact failure: the piped `vercel env add` value cannot be read back, and the write had come
up short. Fixed by `env rm` + `env add` with all three names, then `vercel --prod`. Verified at
the observable effect: `summary.overdue: 0`, `retired_namespaces` = cadence-verify, canon,
audit-20260819; badge now `indeterminate · 8 ns · 0 overdue` (indeterminate is correct: there is
no current cadence namespace; that is the standing Option-1 floor item, not a defect here).

## 2026-08-30 — Test: `WITNESS_RETIRED_NS` end to end through the status computation (S-arcaeon-10c)

The env-var re-set above was fixed at the ops layer with no test ever exercising the
retirement filter itself end to end — `loadRetiredNamespaces()` (`lib/_status_data.js`) through
`status.json`'s summary shaping (`lib/_status_json.js`) had zero coverage. Added
`test/retired_namespaces.test.js`: (a) full three-name var — `summary.retired_namespaces` lists
all three, `summary.overdue == 0`, each row still `retired:true` with its real (overdue) cadence
status; (b) the var SHORT one name (`velouria-audit-20260819` missing) — that namespace counts as
overdue and the verdict reads `degraded`, the exact 8/24→8/30 production failure encoded as a red
in the harness now; (c) empty string, whitespace-only, and unset — nothing retired in any case.
Fixture reuses `cadence_overdue.test.js`'s store-monkeypatch seam (no GitHub calls), extended to
serve one pin per namespace so the three retirement candidates can be overdue while a fourth,
non-retired namespace stays current — keeps these assertions isolated from the unrelated ZERO
FLOOR (`nothingWatched`) mechanism. 127 → 132 tests, all green.

## 2026-08-22 — `witnessed` is tri-state: not-checked reasons return `null`, never a conclusive `false`

Forced by **ColonistOne's re-run against the deployed build** (Colony, witness
thread, 8/22): on 8/18 I said all three not-checked reasons would return
`witnessed: null` with scope in-band; the scope half shipped (accepted_head /
history / note) and the null half did not — `no_pin_recorded_for_namespace`
and `exceeds_current_head` still asserted boolean `false`. ColonistOne also
corrected their own record in the same comment (they had marked prediction B
falsified off my stated intention without verifying the deploy — same failure
class, named on both sides). The repair: `no_pin_recorded_for_namespace`,
`exceeds_current_head`, and `scan_bound_reached` now return `witnessed: null`
— an incomplete or inapplicable check may not assert a conclusive negative.
`false` is reserved for heads the record actively contradicts
(`rows_match_chain_mismatch`, `rows_never_witnessed`, `not_found_in_history`).
Two new contract tests plant the null cases (a 60-deep history to force the
scan cap; a shallow history to prove exhaustion stays a conclusive `false`).
109/109. README §verify rewritten to document the tri-state and credit the
catch.

## 2026-08-17 — Balance page: a human face on `/api/balance` via content negotiation; `lib/_page.js` extracted

**COMMITTED LOCALLY ONLY — not deployed, no Vercel config touched.** Founder
design 34378: every issued key needs an automated, easy way to see pins/
credits remaining — humans AND agents, no login, no accounts, no PII; the key
IS the identity. `api/` sits at Vercel Hobby's 12-function hard cap, so the
page rides the EXISTING `/api/balance` function via content negotiation, the
`api/fulfill.js` pattern. `npm test` green: 93 -> 104 (11 new,
`test/balance_endpoint.test.js`).

**1. New `lib/_page.js` — the shared page template.** `pageShell` / `copyBox`
/ `esc` / `wantsJson` moved VERBATIM out of `api/fulfill.js` (lib/ doesn't
count toward the function cap); fulfill now imports them, zero behavior
change to its pages (its own suite still passes untouched). One deliberate
delta: the input CSS selectors gained `input[name=key]` alongside
`input[name=prefix]` — additive only, no fulfill page has a key input. Env
URLs read at call time (the `_welcome_email.js` idiom).

**2. `api/balance.js` grows an HTML mode — JSON contract UNCHANGED.** HTML
is strictly OPT-IN by the browser's own `Accept: text/html`; the JSON
default (including a bare curl's `Accept: */*` and headerless SDK fetches)
takes exactly the pre-page code path — same fields, same Bearer auth, same
errors, pinned by an exact-field regression test. Browser GET without a key:
paste-your-key form, `type=password` (no shoulder-surfing), submits by POST
so the key never lands in any URL or access-log query string (house rule).
POST with a valid key: credits remaining, free-tier used/remaining, prefix,
key id, plus a curl one-liner copy-box teaching the agent path (placeholder,
never the real key — the key is never echoed into any response, success or
error). Invalid key: the form again, clean inline error, no echo.
Remember-my-key checkbox: default OFF, localStorage only, client-side only.

**3. Links to the page.** `/api/fulfill` success page and the welcome email
(HTML + text) each gained one line under the balance sentence: check your
balance any time at `<base>/api/balance` — a bare link, carries nothing.
`vercel.json` gained a friendly `/balance -> /api/balance` rewrite, mirroring
the established `/status` pattern (the form posts to `action=""` so it works
at both paths).

## 2026-08-17 — Instant fulfillment: `/api/fulfill` (Stripe session -> key + credits) and the dynamic issued-key store

**STAGED ONLY — working tree, not committed, not deployed. No Stripe config
touched, no secrets in code.** Board item 25 (founder-specced, msgs
12252-12263): the self-serve gap named in
`RESEARCH_WAVE_MCP_WRAPPER_2026-08-16.md` §8 — "there is no self-serve way
for a stranger to get a witness key" — now has a mechanism. `npm test`
green: 61 -> 79 (18 new, `test/fulfill.test.js`, Stripe API fully mocked).

**1. New `api/fulfill.js` — GET/POST `/api/fulfill?session_id=...`.** The
Checkout success/receipt page. Verifies the session SERVER-side
(`GET api.stripe.com/v1/checkout/sessions/{id}?expand[]=line_items`, secret
key from env; must be `status:complete` + `payment_status:paid`; livemode
gate + the webhook's H1 amount-vs-pack cross-check carried over). First
valid visit mints `wk_` key + namespace prefix + solo pool and credits the
pack; every revisit re-shows the SAME key (create-only session binding =
the idempotency gate; the recovery path via Stripe's receipt email). Faked,
unpaid, wrong-mode, or amount-mismatched sessions get typed denials — never
a key. Dual response: HTML for humans (key big, quickstart, support line,
one-line consent link — default unchecked, stored on the record), JSON
(`{key, credits, namespace, docs_url, ...}`) on `Accept: application/json`
or `?format=json` for agent buyers. Credit idempotency key is the SESSION
id — the same key `stripe-webhook.js` uses — so page and webhook can never
double-credit one purchase between them. A session carrying
`client_reference_id = sha256(existing key)` (the webhook top-up
convention) credits that key and mints nothing. Welcome email is an honest
STUB (`console.log` + TODO): this app has no mail mechanism and wiring
creds was out of scope; the receipt-URL revisit is the recovery path
meanwhile.

**2. New `api/_keys.js` — the dynamic issued-key store.** Keys previously
existed only as hand-edited `WITNESS_KEYS` env pairs, which a serverless
function cannot append to — so self-serve required a real store. Same
primitive as `_meter.js`/`_balance.js` on purpose: JSON files in the
PRIVATE usage repo, contents-API CAS. `keys/<sha256(key)>.json` (prefix,
plan, org, pool_id), `fulfillments/<session_id>.json` (binding; stores the
raw key so revisits can re-show it — the session URL is already a bearer of
the key by product design), `pools/<pool_id>.json` (org/pool schema baked
in now, UI later: solo pool's credit account IS the key's own balance file,
so the live billing path is unchanged; team flow — N keys drawing one pool
— is commented, not built).

**3. `api/pin.js` + `api/balance.js` — two-tier auth.** Env `WITNESS_KEYS`
lookup first (free, unchanged for every existing key), then the issued-key
store on a miss. Store failure is 502, never 401 — "couldn't check" must
not read as "your key is invalid" to a paying customer. Without this edit a
minted key would have been a dud — exactly the funnel dead-end §8 warned
converts curiosity into a bad first impression.

**Deploy needs (env, names only):** `WITNESS_STRIPE_SECRET_KEY` (falls back
to `STRIPE_SECRET_KEY`; a wrong-account key fails closed as a 404 denial,
unlike the webhook-secret case), optional `WITNESS_STRIPE_PRICE_MAP` (JSON
price-id -> pack; preferred mapping, with metadata.pack then exact
amount_total as fallbacks), existing `GITHUB_PIN_TOKEN` /
`GITHUB_USAGE_REPO` / `WITNESS_STRIPE_LIVEMODE`, optional
`WITNESS_DOCS_URL` / `WITNESS_BASE_URL`. Stripe-side human step: point each
Payment Link's success URL at
`/api/fulfill?session_id={CHECKOUT_SESSION_ID}`.

## 2026-08-16 — Quad-check remediation: H2 (async payments), H4 (false wedge on first pin), and three undocumented entries this file owed

**Not deployed in this commit — build + local-verify only, per instruction;
the CEO deploys.** Fixes `QUAD_CHECK_MONEY_PATH_2026-08-16.md`'s two remaining
open HIGH findings against `arcaeon-witness`, plus the doc-drift the same
report flagged. `npm test` green throughout: 57 -> 61 (four new regressions,
one per finding below; H1 and H3's regressions were already in the 57).

**1. H2 — async payment methods (ACH, Klarna) collected money and got
credited nothing.** `stripe-webhook.js` discarded every
`checkout.session.async_payment_succeeded` event as "unhandled event type,"
even though the payment-gate comment two screens up promised "the real
credit arrives later on the async success event" — that promise was never
implemented. A buyer paying by ACH got a `200` on both the initial
`checkout.session.completed` (correctly skipped, `payment_status:"unpaid"`)
and the later `async_payment_succeeded` delivery (incorrectly discarded),
with no retry and no record anywhere. Fixed: `CREDITING_TYPES` now covers
both event types; `checkout.session.async_payment_failed` gets a
`console.error` and a typed skip (nothing to credit, but a failed clear is
now visible instead of a silent nothing).

**The subtler half, traced mechanically rather than assumed:** does
subscribing to a second event type reopen the double-credit bug this repo
spent all weekend closing? Idempotency lived in `applied_events`, keyed on
`event.id` — and `checkout.session.completed` and
`checkout.session.async_payment_succeeded` are, by definition, two different
events with two different ids. Checked against Stripe's own fulfillment
guidance (`docs.stripe.com/checkout/fulfillment`) rather than reasoned about
in isolation: *"your `fulfill_checkout` function might be called multiple
times, possibly concurrently, for the same Checkout Session"* — Stripe's own
reference handler dedupes on the **Checkout Session id**, not the event id,
specifically because more than one event can carry a paid signal for one
real purchase. This repo's own flow mostly forecloses the two-events-both-
paid case today (an async method's `completed` delivery arrives `unpaid` and
returns before crediting ever runs), but keying on `event.id` alone left a
real gap the moment `completed` is redelivered already-paid, or a future
change widens which event types are subscribed. Fixed the same way Stripe's
own docs fix it: the idempotency key passed to `creditPack` is now the
Checkout **Session** id when the webhook has one (falls back to `event.id`
if a session somehow lacks one — real Checkout Sessions always have one).
`api/credit.js`'s admin path is unaffected — it has no session, and keeps
keying on its caller-supplied `event_id`, unchanged.

**Test:** `test/stripe_webhook.test.js` — an unpaid `completed` followed by a
paid `async_payment_succeeded` for the same session credits the pack exactly
once (previously: zero, ever); `async_payment_failed` skips and logs, credits
nothing; two DIFFERENT event ids (`checkout.session.completed` paid +
`checkout.session.async_payment_succeeded` paid) for the SAME session id
credit exactly once, not twice. All three fail against the pre-fix code
(verified by re-running against a stashed copy of the unfixed file) and pass
against the fix.

**2. H4 — a namespace's first pin could race into a false "wedged, reconcile
by hand," and get charged for it.** `pin.js`'s `verifyOrphanSuccessor` opened
`if (!orphan || typeof orphan !== "object" || !cur) return false;` — on a
namespace's first-ever pin, `cur` (the `latest.json` read) is legitimately
`null`, and the old guard treated that as unverifiable rather than as the
implicit "nothing pinned yet" predecessor it actually is. Two concurrent
first pins on a brand-new namespace: the winner writes a completely healthy
`latest.json` at seq 1; the loser's self-heal retry tries to adopt that exact
record, fails to verify it purely because `cur` was `null`, and returns
`409 orphaned_seq_record` — "namespace is wedged... compare files by hand in
a public GitHub repo" — on a namespace that was never wedged, after already
being billed a meter/credit count for the attempt. Highest-severity pin-side
finding precisely because a retrying client is the normal way to hit it, on
the very first interaction a new customer has.

Fixed: `verifyOrphanSuccessor` now treats a `null cur` as the implicit
`{seq: 0}` predecessor rather than refusing to verify against it — every
check in the function already degrades correctly against that shape
(`expectedSeq` resolves to 1, there's no `prev.rows` to violate monotonicity
against, and a genuine first record's newest interval carries
`supersedes_due_by: null`, exactly what `prevDue` resolves to here).

**Test:** `test/pin.test.js` — two real concurrent first pins (`Promise.all`,
no forced conflicts; the mock store's own create-race 422 on the loser's
seq-record write is what triggers the self-heal path) now both succeed (one
`201` content-advance, one `200` self-healed idempotent no-op), never a false
wedge, and `latest.json` settles at seq 1. Verified against a stashed copy of
the unfixed line: same repro produces the false `409 orphaned_seq_record` and
a spent meter count on a namespace that was never wedged.

**3. Three items this file owed and never paid, found by the same
quad-check pass.** None of these are code changes; all are the operator-
facing surface H1 and H3 exist to protect.
- **The mini pack had no changelog entry.** `PACKS.mini` ($5/1,000 pins, the
  CEO's kill-the-$15-wall ruling) shipped into `_balance.js` and is covered
  by `test/balance.test.js`, but this file's most recent entries before today
  never mentioned it — the same silence the quad-check named as the real risk
  multiplier for H1 (a fourth pack means a fourth hand-wired Payment Link,
  made by duplicating the third one).
- **The H1 fix (money-verify) had no changelog entry.** `stripe-webhook.js`
  now cross-checks `amount_total`/`currency` against the declared pack's
  ratified price before crediting — closing the "a signed $5 event with
  `pack=bulk` credits 40,000 pins" hole — and normalizes the pack id and
  `client_reference_id` hash before lookup (H3: `"Mini"` / `" mini"` /
  uppercase hex used to silently no-op-credit a paid session). Both are live
  in `stripe-webhook.js` and covered by `test/stripe_webhook.test.js`'s H1/H3
  REGRESSION tests, and neither ever got a line here.
- **The `node:test` harness itself had no changelog entry.** 57 tests before
  today's two additions, zero external dependencies, `test/helpers/mock_store.js`
  faking the GitHub contents API's CAS contract in memory — covered in
  README's own "Testing" section but never announced in this file, which is
  where a reader checking "is this repo tested" would look first.

**4. README correction, same pass.** `README.md`'s credit-balance section
described idempotency as a **retired** mechanism (a separate ledger
`applied:true` flag, checked before the balance write) — that was replaced
2026-08-14 by the `applied_events` in-balance-file CAS this changelog's own
2026-08-14 entries document, and the README paragraph was never updated to
match, so the README contradicted the code it was describing. Corrected in
place, plus `mini` added to both the pack-id wiring instructions
(`README.md`, `stripe-webhook.js`'s own header comment) and the pack-size
list — both previously read `starter`/`standard`/`bulk` only, the exact
byte-exact-typo shape H3 exists to punish, on the one document a human
actually reads while wiring a new SKU's Payment Link.

**Local verification (no deploy):** `npm test` — 61/61 green
(`test/*.test.js`), including the four new regressions above. `node --check`
clean on `api/pin.js` and `api/stripe-webhook.js`. No version bump —
`api/_balance.js` `PACKS`, `applied_events`'s on-disk shape, and every
response contract are unchanged; the money-path guard and the wedge-repair
guard both tighten an existing decision path without adding a field, a route,
or a schema.

## 2026-08-16 — Ops batch: rate limit on `/api/verify`, GET-CORS on read endpoints, retired-namespace list, CHANGELOG deploy-note corrections

**Not deployed in this commit — build + local-verify only, per instruction;
the CEO deploys.** All four items below are code + local verification; none
have been pushed live.

**1. Per-IP rate limit on `/api/verify`.** New `api/_ratelimit.js`: a naive
in-memory `Map<ip, {windowStart, count}>`, same shape as `api/pin.js`'s
existing per-key limiter (Stage-0, per-instance, resets on cold start).
`/api/verify` has no auth by design (board item 20 — no key needed just to
ask "does this exist?"), so there's no key to bucket on; IP via
`x-forwarded-for` (leftmost hop) is the only available identity, with a
`socket.remoteAddress` fallback. ~30 calls/IP/10min; the 31st gets `429` with
an honest JSON body (explicitly says this is a per-instance, not a global,
cap) and a `Retry-After` header. Documented, not hidden: a distributed burst
across multiple warm Vercel instances gets multiple independent buckets —
real protection against one hot loop, not a guaranteed global ceiling.
Applied only to `/api/verify` (the read path named for this fix); write
endpoints are untouched.

**2. GET-only CORS on `verify.js`, `status.js`, `health.js`.** New
`api/_cors.js`: `Access-Control-Allow-Origin: *` on every GET/HEAD response,
`OPTIONS` answered `204` with the full preflight header set. Scoped
deliberately to these three read endpoints — they leak nothing beyond what
the public pin repo already shows a stranger who clones it. Never applied to
write endpoints (`pin.js`, `renew.js`, `credit.js`, `balance.js`,
`distill.js`, `stripe-webhook.js`), which stay Authorization-bearer-gated and
outside this helper's import graph entirely, on purpose.

**3. `WITNESS_RETIRED_NS` — a honest way to stop grading a namespace without
hiding it.** Two demo/self-test namespaces (`velouria-cadence-verify`,
`velouria-canon`, both carrying `deadbeef`-style placeholder chains) have sat
permanently `overdue` in production, painting the whole public badge red for
a problem that isn't one — nobody is renewing a demo namespace on purpose.
`api/_status_data.js` now reads a comma-separated `WITNESS_RETIRED_NS` env
var and excludes any matching namespace from the counts that drive the
verdict (`overdueCount`, `currentCount`, `ungradeableCount`,
`missedEverCount`, and therefore `degraded`/`indeterminate`/`overallOk`) —
but the namespace's row stays in `rows`/`namespaces` exactly as before, now
carrying `retired:true` and its real (still-overdue) status. `status.js`
renders it dimmed with a grey "retired" badge and a summary paragraph naming
which namespaces and why; `status.json.js` carries `retired` per-namespace
and `summary.retired` / `summary.retired_namespaces`; `badge.js` needed no
code change — it already reads the (now-corrected) counts. Reversible:
removing a name from the env var makes it gradeable again on its next read,
forward-only, nothing backfilled.

**4. CHANGELOG deploy-note corrections.** The 2026-08-15 `/api/distill` and
"Two public promises paid" entries both still read "Not deployed in this
commit" — true when written, stale now. Confirmed live via `OPTIONS
/api/distill` answering `405` from production (route exists) rather than
`404` (route absent). Corrected in place with a dated note rather than
silently rewritten, so the record shows what was true at authoring time.

**Local verification (no deploy):** `node --check` clean on all five
changed/new files (`_ratelimit.js`, `_cors.js`, `verify.js`, `status.js`,
`health.js`, `_status_data.js`, `status.json.js`). Stub-invocation harness
(not committed) ran the ACTUAL handler functions against a mocked
`global.fetch` standing in for the GitHub contents API: `verify.js` OPTIONS
-> 204 with the ACAO header; a normal GET -> 200 witnessed with ACAO set;
31 GETs from one IP -> the 31st gets 429 with `Retry-After` and an honest
per-instance-limited body; a second IP is unaffected. `_status_data.js`
reproduced the live bug first (fabricated the same two overdue demo
namespaces -> `degraded:true`, matching the real red badge), then re-ran the
identical code path with `WITNESS_RETIRED_NS` set -> `degraded:false`,
`overallOk:true`, both namespaces still present in `rows`/`namespaces` with
`retired:true` and their real `overdue` status intact, `retiredCount:2`.
`status.json.js` and `status.js`'s real handlers, invoked against that same
data, rendered the `retired` field and the grey tag/summary paragraph
respectively. `badge.js`, invoked against a single healthy fixture namespace,
returned `color:"green"`, `message` starting `"ok"`. All checks passed.

## 2026-08-15 — `POST /api/distill`: hosted try-before-pip demo for arcaeon-distill

**Deployed and live** — shipped in the normal morning batch with live
verification (`OPTIONS /api/distill` answers `405` from production, i.e. the
route exists and is being served — a 404 would mean not deployed). *Correction,
2026-08-16: this entry originally read "Not deployed in this commit — ships in
the morning batch," written before that batch ran. It ran; the note was never
updated after. Left here so the record shows what was true when written, not
edited to look prescient.*

New metered endpoint (`api/distill.js` + `api/_distill_core.js`) so an agent
can try arcaeon-distill's deterministic tool-output compaction over HTTP with
zero install: `POST {content, budget}` -> `{content: distilled, receipt}`.
Auth + free-tier metering reuse the exact `/api/pin` pattern
(`store.keyPrefixFor` for key validity, `_meter.js` for the monthly cap,
`_balance.js` for credit top-up past it, charged only after the compute
succeeds — a malformed request burns nothing, same rule pin.js already
enforces on its own rejection paths).

**The honest problem: arcaeon-distill is Python; this deployment is Node.**
The product's entire pitch is "same input, same budget, byte-identical
output, every run, every machine" — so a lazy `JSON.parse` + walk + re-stringify
port would have silently BROKEN that promise the moment it crossed the
language boundary, in two structural ways:
- Python's `json.dumps(5.0) == "5.0"`; plain JS `JSON.stringify(5.0) == "5"`
  (JS has one numeric type — the float-vs-int distinction a JSON token
  carries is gone the instant `JSON.parse` touches it). Python and JS also
  switch to scientific notation at different magnitude thresholds.
- Plain JS objects silently reorder integer-looking string keys
  (`{"2":"b","1":"a"}` enumerates `"1"` before `"2"` regardless of insertion
  order); Python dicts never do. distill()'s wide-dict head/tail truncation
  depends on true insertion order.

Fixed rather than punted: `_distill_core.js` ships a hand-written JSON parser
that classifies each number token as int-vs-float lexically (matching
Python's `json.scanner` rule exactly) and represents every JSON object as a
`Map` (never a plain object) end to end; a `pyFloatRepr()` formatter derived
empirically against a live CPython process (battery: `5.0, 100.0, 1e16,
1e17, 1e-5, 1.5e300, -0.0, 12345678901234567.0, ...`) reproduces CPython's
`repr()` presentation exactly — notation-switch threshold, exponent
zero-padding, trailing `.0`. Every other piece of the algorithm (the three
strategies — json/tabular/text — head/tail truncation, the drop-receipt
digests, the cycle-safe admission gate) is a direct line-for-line port of
`arcaeon_distill/__init__.py` v0.1.2.

**Verified, not assumed:** a 12-case, 515-field cross-language equivalence
harness (json/tabular/text strategies; floats incl. the exact
formatting-edge-case battery above; unicode keys/values; wide dicts; deep
nesting; list-of-lists; CSV; free-text extraction with and without a query)
ran the SAME literal input bytes through the live Python package and this
JS port and diffed every field, including the sha256 receipt digests
(byte-identical canonicalization -> byte-identical hashes, not just
structurally-similar output). Result: **0 failures across 515 checks** — the
JS port reproduces the Python package's content, drop manifests, and digests
exactly for every case tested. `node --check` clean on both new files; a
local stub-request invocation of the handler exercised auth-reject,
malformed-JSON-reject, missing-field-reject, a full successful distill call
(metering itself 401s offline with no live `GITHUB_PIN_TOKEN` in this local
run — expected, same store dependency `/api/pin` already has), and a
NaN-content typed rejection.

**Because a port can never be a promise of eternal equivalence** (a future
edit to either implementation could silently drift the two apart), every
receipt this endpoint returns is stamped `implementation:"js-port"`,
`js_port_version`, and `py_package_version_target` — so a receiving agent
can always tell which implementation produced a given receipt, rather than
assuming the pip package's guarantees transfer by brand name alone. Documented
residual (not blocking, same spirit as the Python package's own "non-proofs"
section): Python's arbitrary-precision ints beyond JS's safe-integer range
round-trip as strings, not numbers, in the JSON response.

## 2026-08-15 — Two public promises paid: legacy heads can ARM, deadlines are OWNER-gated

Both halves of the reviewer debt that 4606d62 only half-paid. Nothing on the
payment/credit path was touched (`api/stripe-webhook.js` and `_balance.js` are
byte-identical), no stored pin changed shape, and the conflict-observation log
and monotonic guard are untouched. **Deployed and live** — shipped in the
normal morning batch. *Correction, 2026-08-16: this entry originally read "Not
deployed in this commit — it ships in the morning batch," written before that
batch ran; it ran, and the note was never updated after. Live confirmation:
`pins/velouria-demo` and `pins/velouria-selftest` are still `legacy_no_deadline`
on production as of this correction — expected, since the arm-on-bare-repin
fix only fires on a namespace's NEXT re-pin, and neither has re-pinned since
this shipped; the code is live, it just hasn't had a trigger yet.*

**1. `legacy_no_deadline` now has an exit (owed to atomic-raven).** Their
objection was *"a warning that cannot refuse is telemetry, not a control."*
4606d62 paid the refuse half: `cadence_gradeable:false`,
`cadence_grade:"cannot_determine"`, an `X-Cadence-Gradeable` header, hatched
amber on `/status`. It did not pay the exit half. A namespace pinned before the
cadence field existed carries no deadline, and a publisher whose log had gone
quiet re-pinned that same unchanged head, hit the idempotent `200`, and stayed
ungradeable forever — the arming path (a content advance, or an explicit
`intent:"renew"`) existed but was unreachable for exactly the publisher who
needed it. Two live namespaces are in that state right now
(`pins/velouria-demo`, `pins/velouria-selftest`: `seq` present, no
`next_pin_due_by`). Fix: **a bare re-pin of a head that carries no deadline arms
the first one** — `201` with `armed_cadence:true`. The "refreshing a deadline
must be asked for out loud" rule is intact: there is no window to extend and
nothing to launder, the only possible movement is cannot-determine → gradeable,
it is one-time per namespace (once armed, bare re-pins are plain no-ops again),
and `had_ungradeable_history:true` stays on the record permanently. Graded reads
of a once-ungradeable namespace now also carry a `cadence_history_note` saying
the deadline was armed forward-only and grades nothing before it.

**Verified locally** (real handlers, mocked GitHub store), seeded with a record
copied from the live legacy shape:

```
BEFORE /api/latest verdict: {"status":"legacy_no_deadline","cadence_gradeable":false,"cadence_grade":"cannot_determine","next_pin_due_by":null}
bare re-pin -> 201 {"armed_cadence":true,"record_kind":"publisher_heartbeat","next_pin_due_by":"2026-08-16T08:46:06.099Z"}
AFTER  /api/latest verdict: {"status":"publisher_heartbeat_current","cadence_gradeable":true,"cadence_grade":"pass","had_ungradeable_history":true}
bare re-pin AGAIN -> 200 {"note":"already witnessed (idempotent re-pin) — no renewal intent, deadline unchanged"}
```

**2. A deadline write requires the namespace's OWNER key (owed to excelsior).**
Their deadline-laundering plant asked for renewal to be *owner*-authorized, not
merely bearer-authorized. What shipped was the prefix gate — which answers "may
this key write in this namespace's neighbourhood," not "is this key this
namespace's publisher." Issued prefixes can overlap (`acme-` and
`acme-ledger-`), so a second key could refresh a namespace it does not publish.
Fix: the first key to renew or arm a namespace binds itself as that namespace's
deadline owner in a new public `owners/<namespace>.json`; every later renewal or
arm must present that same key or gets `403 not_deadline_owner` and writes
nothing (the refusal lands before metering, so it burns no meter count and no
credit). Content advances are deliberately NOT gated by it — that path is the
prefix gate's, unchanged. The binding id is `sha256("arcaeon-witness-owner-v1|"
+ key)` truncated to 32 hex, **domain-separated from the `sha256(key)` used as
the billing identifier**, so publishing it in a public repo does not publish the
Stripe `client_reference_id`.

This closes *the other key*, not *the stolen key*, and README/PRACTICES/`/status`
now say so in those words. Owner-signature auth is still Stage-1 and still not
built.

```
renew, NO key        -> 401 {"error":"invalid or missing bearer key"}
renew, WRONG key     -> 403 {"error":"not the deadline owner of this namespace — a cadence deadline may only be renewed or armed by the key bound to it","reason":"not_deadline_owner"}
  (that key passes the prefix gate: keyPrefixFor(OTHER_KEY) = demo- )
renew, OWNER key     -> 201 {"renewed":true,"record_kind":"publisher_heartbeat"}  deadline moved: true
```

Regressions re-run green in the same harness: content advance by a non-owner
key still `201`, monotonic violation still `409`, unknown intent still `400`,
same-rows/different-chain still `409` + observation, renewal of an unknown
namespace still `404` (and binds nothing), a new namespace's first pin creates
no owner file.

## 2026-08-14 — Fix: the four billing/race defects the hostile audit FLAGGED — all shipped

The audit earlier today (entry below) shipped the unambiguously-safe fixes and
deliberately *escalated* anything that touched billing or write semantics —
"an auditor who also rewrites the billing logic is not an auditor." Those
escalations are now authorized and fixed. Each was reproduced against the live
store with throwaway namespaces first, then re-run green after the fix; the
throwaway files were deleted (delete commits are in each repo's history). This
whole path is PRE-REVENUE — no pack has ever been sold, the Stripe webhook is
not wired, there are zero live balances — so the schema change below needed no
migration and the fixed-but-inert code is simply *correct-when-wired*.

**1. CRITICAL — credit double-grant (`_balance.js grantCredits`).** A Stripe
delivery retry could credit one paid pack twice (audit repro: 10 pins bought,
20 granted). The idempotency claim (`applied:false -> true`) and the balance
write were two separate GitHub round-trips, so two overlapping deliveries of the
same `event_id` both read "not yet applied" and both added. Fix: idempotency now
lives INSIDE the same compare-and-swap as the balance write — the balance file
carries an `applied_events: [...]` set (bounded to the last 500), and
check-membership + add-pins + record-event are one CAS against the file's sha.
The loser of the race re-reads, sees the `event_id` already applied, and returns
`already_credited` without adding again. The append-only `ledger/` grant file is
still written as an audit record but is no longer the gate. **Test (two
concurrent OS processes granting the same event_id, 6 trials each):** pre-fix
double-granted (balances `[10,10,10,10,10,20]` — a real `20`); fixed granted
exactly `10` in all 6 trials, the losing writer returning `already_credited`.
**Schema note for the not-yet-existent cutover:** `balance/<hash>.json` gains
an `applied_events` array — additive, no migration (zero live balances); a
pre-field file reads as an empty set, which is correct.

**2. charge-after-commit (`pin.js`).** Metering (`meter.check`, which
increments) and the over-cap `decrementCredit` ran at the TOP of the handler,
before the monotonic / conflict / renewal checks — so a pin that then got
rejected 409 had already burned a meter count and, over the free cap, a real
credit. Fix: metering moved BELOW every rejection branch, into the two actual
write paths, guarded so a self-heal retry can't double-charge. A rejected pin —
and now also an idempotent no-op re-pin, which records nothing — charges
nothing. **Test (pre-fix vs fixed):** under-cap rejected pin — meter `used`
went `1->2` pre-fix, stays `1` fixed; over-cap rejected pin on credits —
balance went `4->3` pre-fix, stays `4` fixed.

**3. webhook payment gate (`stripe-webhook.js`).** `checkout.session.completed`
credited a pack without checking that the money actually cleared — for async
payment methods, "session completed" is not "paid." Fix: credit only when
`session.payment_status === "paid"`; anything else (`unpaid`,
`no_payment_required`, missing) returns `200 {skipped:"session not paid"}` so
Stripe doesn't retry, and the real credit arrives later on the async-success
event if the payment settles. Plus a livemode assertion (`event.livemode` must
match `WITNESS_STRIPE_LIVEMODE`, default live) so a test-mode event can't credit
a live balance. **Test:** unpaid, `no_payment_required`, and livemode-mismatch
sessions all credit `0`; a paid+live session credits the full 3,000-pin starter
pack.

**4. orphaned-seq self-heal (`pin.js`).** A pin is two non-atomic commits (the
numbered seq record, then `latest.json`). If the first landed and the second
didn't, `latest.json` sat one behind, every later pin recomputed the same seq,
collided, and 502'd — the namespace was **permanently wedged**. The audit
shipped detection (typed `409 orphaned_seq_record`); this is the repair. On a
collision the handler reads the orphan and adopts it into `latest.json` ONLY if
it VERIFIES as the legitimate immediate successor of the current head — exactly
one seq ahead, monotonic non-decreasing rows, a well-formed hex chain, a known
`record_kind`, and a prev-chain linkage (the orphan's newest interval must
supersede THIS head's deadline). Anything less keeps failing typed rather than
launder a corrupt record into an append-only public log. The check runs before
any charge, so a wedge never mischarges. **Test:** pre-fix stayed wedged (409,
head stuck at seq=1); with a valid planted orphan the fixed handler adopted it
(seq=2) and recorded the caller's pin as seq=3; a corrupt-linkage orphan was
refused adoption (typed 409, head untouched).

Regression-checked after the `pin.js` restructure: advance / renewal (still
charged) / idempotent re-pin (now uncharged) / monotonic-reject / head-conflict
all behave correctly. Deployed to production (safe: inert until the webhook is
wired); health / latest / status.json / badge / verify confirmed live.

## 2026-08-14 — Fix: hostile security audit of `api/` — four shipped fixes, two escalations

A deliberately adversarial line-by-line audit of every file in `api/`, assuming
the code guilty. Findings were reproduced live against throwaway namespaces
(`velouria-audit1..3`, since removed — the delete commits are in the pin repo's
history). Only unambiguously-safe fixes shipped; anything touching auth or
billing semantics is written up for review instead, because an auditor who also
rewrites the billing logic is not an auditor.

**Shipped.**

`api/_store.js` `validatePin` — bounded `rows`. `Number.isInteger` accepts
2^53, and `JSON.parse` silently rounds `9007199254740993` down to it, so a
single request could pin an absurd head. Because the monotonic guard is
absolute and correct — a witness never goes backward — that namespace could
then *never record a real head again*. One request, permanent, no undo.
Reproduced live before the guard existed. Now `Number.isSafeInteger` (anything
larger does not survive a JSON round-trip, and a witness that silently rewrites
its input is not a witness) plus a `MAX_ROWS` domain bound.

`api/_store.js` `keyPrefixFor` — constant-time key comparison, and an empty
namespace-prefix is now refused rather than honoured. `===` on a secret
short-circuits at the first differing byte; and a `WITNESS_KEYS` entry written
`somekey:` (trailing comma, half-finished edit) granted that key write access
to *every* namespace, because `"".startsWith(x)` is always true. A config typo
must never be the thing that widens authorization.

`api/_meter.js`, `api/_balance.js`, `api/_store.js` — stopped putting upstream
response bodies and private-repo paths into thrown messages. Handlers
interpolate `err.message` directly into 502 bodies, so a concurrent pin storm
was returning `usage/<sha256(key)>/<month>.json` and GitHub's raw error body to
the caller. Detail now goes to the server log; the caller gets the condition.

`api/pin.js` — typed `409 orphaned_seq_record`. The numbered record and
`latest.json` are two separate commits and are not atomic. If the first lands
and the second does not (function timeout, transient GitHub error), every later
pin recomputes the same seq, collides with the orphan, and 502s: the namespace
is **permanently wedged**, and the code comments claiming it "self-heals on the
next pin" were wrong. Confirmed live, and it recurred on its own during
verification. This change is detection only — it names the condition and points
at the orphan instead of returning an opaque store error. The repair is
escalated below.

`api/stripe-webhook.js` — `module.exports.config` was assigned *before*
`module.exports = handler`, so the handler assignment discarded it and
`bodyParser:false` never applied. The request stream would already be drained,
`readRawBody` would return empty, and the HMAC would be computed over an empty
body — every genuine Stripe delivery would have failed signature verification
the day this endpoint was wired up. Config is now attached after the handler.
Also: sign over the raw bytes rather than a utf-8-stringified Buffer, and
reject non-hex `v1` explicitly (`Buffer.from(x,"hex")` does not throw, so the
existing try/catch was dead code).

`api/status.js` — GET/HEAD guard. Any method rendered the page and fired the
full GitHub fan-out behind it.

**Escalated, not shipped** (see the audit report): the `applied:false`
check-then-act window in `_balance.js` `grantCredits`, which lets one paid
Stripe event be credited twice — demonstrated, 10 pins purchased, 20 granted;
and the orphaned-seq-record repair, which changes append-only write semantics
and needs a decision rather than a patch from the person who found it.

## 2026-08-14 — Add: anchor staleness now degrades `/status`, `/api/status.json`, `/api/badge` (board item 26)

The daily self-anchor (`bridge/arcaeon/ots_anchor.py`, Task Scheduler
`velouria-ots-anchor`, 03:15 local) writes `anchors/<date>-head.txt(.ots)` to
the pin repo and logged locally to `ots_anchor_log.jsonl` — but nothing public
noticed if the job silently stopped running. `/status` rendered the anchor's
age but never fed it into the page's own degraded/ok verdict, so a dead
anchor job left the badge green.

`api/_status_data.js`'s `anchor` object now carries `ageHours` and a
`status` of `current` / `stale` (>36h — 1.5x the 24h cadence) /
`cannot_determine` (anchors/ unreadable or empty — same non-answer
discipline as an ungradeable pin), computed from the timestamp inside the
anchor file itself, not just its filename date. `stale` now folds into the
page's `degraded` state and `cannot_determine` into `indeterminate`, so a
stopped anchor job turns the badge red/yellow instead of staying silently
green. `api/status.json.js` exposes this as a dedicated top-level
`ots_anchor` block (date, age_hours, status, stale_after_hours, sha,
has_ots_proof, claimed_at, url, error) so a monitor doesn't have to know the
rest of the schema to find it. `api/badge.js`'s message now appends
`· anchor stale` / `· anchor cannot_determine` when relevant instead of
leaving the reason to a click-through.

## 2026-08-14 — Fix: `/` served a bare Vercel 404

Only `/status` and `/api/*` resolved; the domain root returned `NOT_FOUND`. The
Arcaeon HF org card — whose own pitch is "hand the reader the means to check" —
linked its hosted-witness call-to-action at `https://arcaeon-witness.vercel.app`,
so a stranger clicking the one link that proves the operator cannot silently
advance their own pins landed on a Vercel 404. The root of a tamper-evidence
domain is the last place to serve a broken page.

`/` now rewrites to `/api/status`, the same destination `/status` already used.

## 2026-08-14 — Fix: `HEAD` on the public read endpoints answered 405

`/api/latest`, `/api/badge`, `/api/status.json` and `/api/verify` all guarded with
`if (req.method !== "GET")`, which rejects `HEAD` — the method uptime monitors and
link checkers reach for first. The endpoints were serving 200 to every real client
and reporting themselves **down** to every automated one. `/api/health` and `/status`
carry no such guard and always answered `HEAD` correctly, so the trust surface
disagreed with itself depending on which URL a monitor was pointed at.

Guards now accept `GET` and `HEAD`, and advertise `Allow: GET, HEAD`. Node strips
the body from a `HEAD` response on its own, so no handler needed a second branch.
`/api/balance` deliberately keeps its `GET`-only guard: it is bearer-gated, no
monitor reaches it unauthenticated, and widening an auth-gated method surface is
not a thing to do casually as part of a fix for public read endpoints.

Found by a full endpoint sweep (all 14 routes, hit + miss + unauthenticated cases).
That sweep also confirmed the thing most worth confirming: `/status`,
`/api/status.json` and `/api/badge` agree field-for-field with `/api/latest`, even
though `_status_data.js` computes cadence through a deliberately separate
reimplementation of `_store.js`'s `computeCadenceFields`. Two independent
implementations, one answer.

## 2026-08-14 — Fix: unstamped legacy records no longer track the live `AUTH_LEVEL`

`api/_store.js:382` read `out.auth_level = (pin && pin.auth_level) || AUTH_LEVEL`.
Records written before the auth stamp existed carry no `auth_level` of their own,
so that expression fell through to the **current value of the constant**. Harmless
while the constant is `"bearer-stage0"` — and a silent retroactive rewrite the day
Stage-1 flips it to `"owner-signature"`, at which point every unstamped legacy
record would begin claiming owner-signed auth it never had.

That is precisely what `README.md` "Auth honesty" promises will not happen:
*"the two will be distinguishable in the public repo record-by-record — including
retroactively, because every record written before then says `bearer-stage0` in its
own text."* Unstamped records do not say it in their own text. They say nothing, and
the fallback was speaking for them — in whatever voice the constant happened to have.

Fixed per `STAGE1_SIGNATURE_DESIGN.md` §7.1: the fallback now resolves to frozen
literals (`LEGACY_AUTH_LEVEL` / `LEGACY_AUTH_NOTE`) that do not move when the live
constants move, and the legacy note names itself as an unstamped pre-Stage-1 record
rather than borrowing the current era's wording. Records that DO carry a stamp are
untouched and still report it verbatim. Landed now, independently of whether the
rest of Stage-1 is ever built — it guards a public promise, it is easy today, and
it is a postmortem later.

Verified: unstamped record -> `bearer-stage0` + unstamped-legacy note; stamped
record keeps its own values; no `|| AUTH_LEVEL` live-constant fallback remains in
the file.

## 2026-08-14 — Stage-1 owner-signature design doc (**design only, nothing built**)

`STAGE1_SIGNATURE_DESIGN.md` — the owner-signature scheme whose absence every
record in this repo currently announces (`auth_level:"bearer-stage0"`). Written
against **excelsior's** proposed conflict-receipt schema from the Colony thread
(`{accepted_head, candidate_head, candidate_sig, namespace_key_id, auth_verdict,
observed_at, request_digest}`), posted for review before any code exists.

Nothing in it is implemented. What it settles: per-namespace Ed25519 keypairs;
first-binding-wins registration; `prev_seq` + `prev_record_digest` as the replay
control (chosen over an idempotency header because it needs no new server state
and is checkable from the public record); dual-signature conflict receipts where
the candidate's signature-or-absence is recorded **affirmatively**, never by
omission; bearer keys demoted to metering and rate identity only.

Two things it refuses to soften. **The first key binding for an existing
namespace is trust-on-first-use** — today the bearer key is the only ownership
proof this service has (`api/_store.js:130-140`), so the bearer key is the only
thing that can authorize a first binding, and a key that leaked before then hands
its holder a permanent credential instead of a temporary one. The doc says that
in those words (§2.3). And **Stage-1 proves key custody, not owner intent** — a
compromised owner machine signs happily, which matters more here than most places
because the intended publisher is often an agent (§9.1).

**One real bug found while writing it, and it is not a design item.**
`api/_store.js:382` — `out.auth_level = (pin && pin.auth_level) || AUTH_LEVEL;`.
Records written before the auth stamp existed carry no `auth_level`, so they fall
back to the *current constant*. That is harmless today and becomes a silent
retroactive upgrade of every legacy record the day the constant flips — breaking
the promise at `README.md:293-296` that pre-Stage-1 records stay distinguishable
"because every record written before then says `bearer-stage0` in its own text."
They do not say it; the fallback speaks for them. The fix is two lines
(§7.1) and should land independently of whether the rest is ever built.

## 2026-08-14 — `cadence_gradeable` refuse-semantics + publisher-heartbeat renewal

Two debts from public review, both paid as promised.

### 1. `legacy_no_deadline` now arms something (**atomic-raven**)

atomic-raven's objection: *"a warning that cannot refuse is telemetry, not a
control."* `/api/latest` returned `status:"legacy_no_deadline"` for records
predating the cadence field, and nothing downstream changed behavior — every
consumer gating on cadence still saw an unqualified green light. It printed; it
did not arm.

- `/api/latest` returns **`cadence_gradeable: false`** for legacy records
  (`true` on every gradeable read, so consumers can gate on it uniformly), plus
  **`cadence_grade: "cannot_determine"`** — a distinct class from `pass`/`fail`
  — and an `X-Cadence-Gradeable` response header so a proxy can refuse without
  parsing a body. `status` is unchanged for existing consumers.
- `/status` renders ungradeable rows **hatched amber, labeled "cadence not
  gradeable,"** never the neutral grey that reads as fine; the page header
  reports `INDETERMINATE` rather than `OK` while any namespace is ungradeable,
  and a stat tile counts them.
- README documents the refuse-semantics explicitly: a consumer gating on cadence
  **must** treat `cadence_gradeable:false` as `cannot_determine`, not as a pass.
- No history was rewritten and **no deadline was backfilled.** A legacy
  namespace becomes gradeable on its next pin or renewal, forward only;
  `had_ungradeable_history:true` stays on the record permanently.

### 2. `POST /api/renew` — a deadline a live-but-quiet publisher can refresh (**excelsior**)

excelsior found the hole: a namespace whose log genuinely stops changing went
permanently overdue, because the idempotent re-pin branch returned the stored
pin untouched and the deadline only moved when rows advanced. A finished log
and an abandoned one were indistinguishable. excelsior's invariants are the
spec, and each one is implemented:

- **Retained miss** — a renewal over an overdue deadline keeps `missed_due_at`,
  `first_missed_due_at`, `missed_deadline_count`, `ever_missed_deadline`, and a
  `missed_deadlines[]` entry. Renewal moves the deadline; it never erases that
  one was missed. A later content advance doesn't erase it either — both write
  paths run the same append-only history code (`_store.appendInterval`).
- **Appended interval** — each renewal appends an `intervals[]` object carrying
  `supersedes_due_by` and `superseded_deadline_was_missed`; the old deadline is
  never rewritten. Most recent 20 inlined, full series in the per-seq commit
  history.
- **Typed distinction** — `record_kind:"publisher_heartbeat"` vs
  `"content_head_advance"` in the record; `head_state:
  "publisher_heartbeat_current"` vs `"content_head_advanced"` in `/api/latest`,
  with `status` reporting `publisher_heartbeat_current` so a naive
  `status === "current"` gate does not pass a namespace whose content never
  moved. Plus `content_unchanged_for_seconds` and `renewals_since_advance`, so
  "kept current for months without a single new row" is a number, not a vibe.
- **Not launderable** — renewal must restate the head exactly (`409
  renewal_head_mismatch` otherwise); same-rows/different-chain still takes the
  conflict-observation path; an unknown `intent` is a `400`, never a silent
  fallthrough; a bare re-pin still returns the old idempotent `200` and moves no
  deadline. `/api/renew` is a thin wrapper over `api/pin.js` on purpose — one
  implementation of auth, metering, rate limit and guards, so a renewal can't
  skip a check a pin has to pass.
- **Auth, stated honestly** — bearer-key only, `auth_level:"bearer-stage0"` on
  every write response, every stored record, and every read.
  **Owner-signature auth is the Stage-1 requirement and is NOT built.** A leaked
  key can keep a namespace looking alive without the owner. Named in the README,
  in the `/status` footer, and in the API's own `auth_note` field rather than
  left to be discovered.

## 2026-08-14 — earlier

- Real decrementing credit balance + instant top-up (`_balance.js`,
  `/api/credit`, `/api/stripe-webhook`).
- Public `/status` page: stranger-gradeable trust surface.
- Cadence-deadline alarm (`next_pin_due_by`/`status`) — **excelsior's** review —
  plus the Witness Practices Statement.
- Free-tier metering enforced via a native Node port of arcaeon-meter.
- Daily OpenTimestamps counter-anchor of the pin repo HEAD.
- Same-length re-mint guard: idempotent re-pin + append-only conflict
  observation log — **reticuli** (the missing typed case) and **excelsior**
  (the two-ledger design).
- Stage-0 hosted witness: public-GitHub-repo pin store behind a Vercel API.
