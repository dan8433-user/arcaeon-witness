# Changelog — arcaeon-witness

Reverse-chronological. Every entry says what changed and why, and names the
reviewer whose objection forced it where there was one. Public review is the
reason this thing works; the credit belongs in the record, not in a thank-you.

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
