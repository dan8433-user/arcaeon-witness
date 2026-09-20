# Release candidate — 2026-09-20

Branch: `release-candidate-2026-09-20`. Worktree: `C:\Users\USER\arcaeon-witness-rc`.
Nothing pushed. Nothing deployed. No live API was called in assembling this.

Production today is commit `14308a0` plus a status-page fix. This candidate is
that, plus everything below.

---

## 1. What is in it, by feature

### 1.1 Already on `main`, unshipped (the 10 commits)

- **409 retry in `putFile`.** A PUT that loses the branch-ref race is retried
  instead of dropped. Measured, not theorised: `tools/ceiling_probe.js` saw 465
  conflicts in 532 requests from ten concurrent writers creating *distinct*
  files. The retry re-reads the path to tell branch contention (re-PUT verbatim)
  from a path that actually moved (hand the fresh state to the caller's
  `rebuild` hook, never blind-overwrite). Before this, two overlapping pins lost
  one.
- **Bulk verify.** `POST /api/verify?op=bulk`, up to 20 items, one verdict per
  item in order, nothing short-circuiting.
- **Merkle batching library, pending queue and sealer**, behind
  `WITNESS_BATCH_SHADOW`, **default OFF**. Dark code in this candidate.
- **Status-page posture fix.** The k=1 adoption editorial is gone; the
  verifiability limit stays; the operator's own namespaces are tagged as
  reference so a namespace count does not read as a customer count.

### 1.2 `bulk-ratelimit`

Bulk verify was dispatched *before* the single-item path's `ratelimit.check()`
and never called a limiter itself, so one unauthenticated POST could walk up to
1,020 GitHub reads against the same token the paid `/api/pin` write path
depends on. `lib/_ratelimit.js`'s `check()` gained a `cost` parameter (default
1, every existing caller unaffected) and `handleBulk` now spends
`items.length` from the **same** per-IP bucket the single-item path uses,
after the cheap shape/cap validation and before any store read.

### 1.3 `reserve-brand-stems`

`velouria-` and `arcaeon-` are refused at claim time with the same shape the
`wk-` reservation already used. One constant, `keys.RESERVED_BRAND_STEMS`,
feeds both the claim check and the status page's reference tagging, so the two
cannot drift apart. A stem inside a differently-rooted prefix
(`acme-velouria-mirror-`) is untouched and still claimable.

### 1.4 `stamp-own-repo`

- `POST /api/stamp` (a `vercel.json` rewrite onto `/api/verify?op=stamp` — the
  deployment is at the 12-function cap). The browser hashes the file; only the
  SHA-256 and an optional byte count are sent. One JSON record per fingerprint.
- **Its own public repository and its own write token.** Never the pins repo,
  never the pin token, no fallback path — and a `STAMP_REPO` set by hand to the
  pins repo is refused outright.
- **Fail closed.** Unconfigured means 503 with nothing written and nothing even
  read.
- **First write wins, forever.** A fingerprint that already has a record is
  returned untouched, writes nothing and charges nothing.
- **Metered from the prepaid pool**, `STAMP_PRICE_CREDITS = 0.25` — a
  placeholder awaiting the pricing decision, with its math in the source.
  `lib/_balance.js` gained `debitCredits(secret, amount, reason)` with balances
  rounded to 6 decimal places; `decrementCredit` is now a thin alias, so there
  is one CAS loop and not two.
- `lib/_store.js` hardening: a non-pins target that names no `tokenEnv` refuses
  rather than borrowing `GITHUB_PIN_TOKEN`.
- `tools/stamp_genesis.js` — an offline, create-only, dry-run-by-default tool
  that writes one record into the *existing* pins repo naming the stamps log's
  first commit, so an older log dates the newer one. Never run.

### 1.5 `sealer-safety`

Merged last, on the coordinator's word that it was ready (`e6d2390`, clean
worktree, 293/293).

- `lib/_claim.js` — a seal lease on `pending/seal_claim.json` in the private
  usage repo, so two sealers cannot publish the same leaves under two batch ids.
- An optional `beforeRoot` gate on `sealBatch`.
- `store.getTreeMeta` — the recursive tree with `truncated` kept, so the
  reconciler can say "could not look" instead of "clean".
- `tools/reconcile_batches.js` — read-only, three verdicts.

Still dark: `WITNESS_BATCH_SHADOW` stays OFF and must stay off in this
candidate.

---

## 2. Merges, conflicts, and test counts

Each branch was green on its own base before merging. The count after each step
is the real summary line from `node --test "test/*.test.js"`.

| Step | Result | Conflicts | Suite |
|---|---|---|---|
| base (`main`) | — | — | **265 / 265** |
| merge `bulk-ratelimit` | fast-forward | none | **271 / 271** |
| merge `reserve-brand-stems` | 3-way | `CHANGELOG.md` | **299 / 299** |
| merge `stamp-own-repo` | 3-way | `CHANGELOG.md` (+ `api/verify.js` auto-merged, inspected) | **340 / 340** |
| cross-feature tests added | — | — | **348 / 348** |
| merge `sealer-safety` | 3-way | `CHANGELOG.md`, `lib/_store.js` (auto-merged **wrongly** — see below) | **377 / 377** |
| retry-timing measurement added | — | — | **378 / 378** |
| starvation fix (audit finding) | — | — | **381 / 381** |

### 2.1 How each conflict was resolved

**`CHANGELOG.md`, four times.** Every branch wrote a dated entry at the top of
the file, so the conflict was positional rather than semantic each time. All
entries were kept, none rewritten, ordered newest-first with the same-day
entries grouped: sealer, brand stems, bulk rate limit, stamps (9/20), then
stamp-endpoint and status posture (9/19). No branch's account of its own work
was edited.

**`api/verify.js` — auto-merged, then inspected line by line.** This was the
conflict the plan expected and git resolved it cleanly because the two
additions land in different places. Both mode dispatches survive, in this
order:

1. `?op=stamp` → `stamp.handleStamp`, dispatched **first**, ahead of the
   GET-only CORS helper, because it answers its own POST preflight and shares
   nothing with verify's logic.
2. the GET-only CORS helper,
3. `?op=bulk` → `handleBulk`, which calls
   `ratelimit.check(req, items.length)` **inside itself**,
4. the method guard and the single-item `ratelimit.check(req)`.

The stamp mode keeps its own limiter (its own bucket, 10 per 10 minutes) and
its own caps; the bulk mode keeps its weighted check on the shared read budget.
Neither is dispatched ahead of its own gate. This is not taken on reading —
cross-feature test (a2) drives both from one address and asserts both refuse.

**`lib/_store.js` — auto-merged, and wrong.** `getTreeMeta` arrived on
`sealer-safety`, which forked *before* the target refactor landed on
`stamp-own-repo`. The two touch different lines, so git merged them without
complaint and produced the only primitive in the file that takes no target: it
read the module-level `REPO`/`BRANCH` and called `ghHeaders()` with no argument.
It read the right repository — but by default rather than by construction, and
it was missing from `forTarget()`'s bound set, so a store bound to the stamps
target would have called `getTreeMeta` and silently read the **pins** repo with
the **pin** token. That is the same shape as the borrowed-token bug the 9/20
hardening closed, reopened by a merge instead of by an edit.

Fixed test-first: `getTreeMeta(target = PINS_TARGET)`, destructuring repo and
branch from the target, passing the target to `ghHeaders`, and bound in
`forTarget()` beside `getTree`. The test was red before the change and carries
a must-fail arm — an argument-less call must still read the pins repo with the
pin token, and the two URLs must differ, or the test cannot tell a target-aware
implementation from a hardcoded one.

**`lib/_ratelimit.js` — no conflict.** The stamp branch does not use the shared
limiter's bucket at all; it imports only `callerIp` and keeps its own, stricter
bucket. So the new `cost` parameter and the stamp mode never met.

**`lib/_status_data.js` — no conflict.** Only `reserve-brand-stems` touched it.

**`vercel.json` — no conflict.** The `/api/stamp` rewrite merged cleanly beside
the existing rules.

### 2.2 No test disappeared

Counted rather than assumed. Base `b3eb684` (the stamp lineage's fork point)
runs 258; `main` runs 265 (the two status commits add 7). The branch deltas are
`bulk-ratelimit` +6, `reserve-brand-stems` +28, the stamp lineage +41
(299 − 258), `sealer-safety` +28 (293 − 265). 265 + 6 + 28 + 41 + 28 = **368**,
and the candidate runs 381 with the 13 tests written here (8 cross-feature,
1 retry timing, 1 `getTreeMeta` seam, 3 starvation). Every test **file** from
every branch is present in the candidate; the set difference is empty.

One existing assertion changed shape, deliberately and visibly:
`test/stamp.test.js`'s DAILY CAP test now pins `STAMP_FREE_SHARE_OF_CAP=1`. Its
fixture cap is 3, which would sit astride the new free/paid boundary; the test
is about the *global* cap, so the lever is pinned and its original assertion —
three through, the fourth refused, counter at 3 — is unchanged. Nothing was
deleted or weakened.

---

## 3. Cross-feature tests

`test/cross_feature_rc.test.js`, nine tests, every one with a must-fail arm.
These are the seams no single branch could have reached, because no single
branch had both features.

| | Claim | Result |
|---|---|---|
| **a1** | A stamp and a bulk verify from **one** address spend the budgets their designs name: the stamp its own per-IP bucket, the bulk call the shared read budget weighted by `items.length`. Measured by counting how many single verifies the address has left afterwards (LIMIT − 5, not LIMIT − 8). | PASS |
| **a2** | **Neither** mode is dispatched ahead of its own limiter. The 11th stamp from an address is 429 `ip_rate_limited` with nothing written; bulk past the shared budget is 429 with **zero store reads**. | PASS |
| **b** | With `STAMP_*` unset the stamp mode is 503 in both methods, with zero writes **and zero network requests** (the gate sits ahead of every store touch, so nothing is in flight to be misrouted), while pin, single verify, bulk, status and health are unchanged. | PASS |
| **c** | With **both** credential sets present, a stamp reaches only the stamps repo and only with `STAMP_TOKEN`; the pin token never appears on that traffic. | PASS |
| **c2** | `STAMP_REPO` hand-set to the pins repo is refused (`stamp_repo_is_pins_repo`), 503, zero requests in flight. | PASS |
| **c3** | A store target naming no `tokenEnv` rejects before the wire; a complete one reaches it with the right token. | PASS |
| **d** | The status page never counts a `genesis/` record as a conflict observation, and `tools/stamp_genesis.js`'s own `GENESIS_DIR` is asserted to sit outside `observations/` — binding the tool's constant to the page's filter. | PASS |
| **e** | `api/` holds at most 12 function files, `/api/stamp` is a rewrite and `api/stamp.js` does not exist. | PASS |
| **f** | The 409 retry's worst case, computed from `PUT_RETRY` itself (§4). | PASS |

Must-fail arms, in brief: a1 re-runs its measurement against a shared-bucket
stand-in and proves the number moves; a2 resets the stamp limiter between calls
(the "no limiter" shape) and proves no refusal appears; b restores the env and
proves the same request then succeeds; c drives a deliberately misrouted target
through the same detector and proves it fires; d adds a file under
`observations/` and proves the counter does move; e re-runs the counter on a
synthetic 13-file listing; f halves `PUT_RETRY.baseDelayMs` and proves the
computed number halves rather than being a quoted literal.

---

## 4. The 409 retry's worst-case wall clock

The audit's one open item (finding #7). Computed from the code's own constants,
through the code's own delay function, in `test/cross_feature_rc.test.js` (f),
so the number cannot drift away from the constants silently.

**The constants** (`lib/_store.js`, `PUT_RETRY`): `maxAttempts: 4`,
`baseDelayMs: 1000`, delay = `base × 2^(attempt−1) × jitter`, jitter uniform on
`[0.5, 1.5]`. The loop sleeps before attempts 2, 3 and 4 — three sleeps.

| | Value |
|---|---|
| One retrying `putFile`, jitter floor | **3,500 ms** |
| One retrying `putFile`, jitter ceiling | **10,500 ms** |
| One content-advance pin (`putSeqRecord` **then** the `latest.json` pointer, sequential, both before the 201) | **21,000 ms** |
| GitHub round trips in that worst case | up to **14** (8 PUTs, 6 re-read GETs), plus up to ~6 more if `WITNESS_BATCH_SHADOW` were on (`recordAcceptedSafe`, `CAS_ATTEMPTS = 3`, no sleeps) |
| Per-request timeout in the code | **none** — no `AbortSignal`, no `signal:`, anywhere |
| `functions.maxDuration` in `vercel.json` | **not set** — asserted by the test |

**UPDATE, reviewer, 2026-09-20: `vercel.json` now sets `functions.maxDuration = 30` for `api/pin.js` and `api/verify.js` (the two functions that write through the retry). 30 s exceeds the 21.0 s worst-case sleep with 9 s of margin for round trips; `test/max_duration.test.js` and cross-feature test (f) pin it. Still a deploy-day check: confirm the plan accepts 30 s (if it refuses, the deploy fails loudly, which is the safe direction). The original finding follows unchanged.**

**Verdict at the time of assembly: the worst case does not fit.** `vercel.json` sets no
`maxDuration`, so the ceiling is the platform default for the plan this
repository is pinned to by its own 12-function cap, which is the Hobby plan —
documented at 10 s for Node functions. 21.0 s of deliberate sleeping does not
fit inside that, and neither does a single retrying `putFile` at 10.5 s. The
round trips are on top, and nothing in this codebase bounds them.

Two honest limits on that verdict. First, I read the plan from the repository's
own constraint, not from the account — the deployed `maxDuration` was not
checked against the live project, and that is a one-minute check on deploy day
(§8). Second, this is the *worst* case: it needs a request to lose the branch
race on all four attempts of both writes. The measured probe saw an 87%
conflict rate under ten concurrent writers, so it is not exotic under load,
but it is not the common path either.

**No constant was changed.** Changing the retry shape is a real decision about
what a pin does under contention, and it belongs to whoever owns that
trade-off, not to a merge. What this candidate adds is the number and a test
that makes a later `maxDuration` override come past it.

---

## 5. Second-lineage audit of the stamp code

The stamp path had never had one. Brief: the context, the owner's five rules
(fingerprint and size only; first write wins; fail closed; debit only after a
confirmed write; never the pin token), eight specific attack questions, and the
full source of `lib/_stamp.js` and `lib/_stamp_store.js` plus the `_balance.js`
and `_store.js` diffs and the `verify.js` dispatch. Checked for secrets before
sending: env var **names** only, no token values; the one repository name in it
is already published on the public status page.

One run, `google/gemini-2.5-pro`, $0.0837. Output:
`C:\Users\USER\velouria\projects\online_business\second_lineage_reviews\product_attack_20260920T134017Z.md`.

Every objection was taken to the code. Verdicts: **1 confirmed and fixed,
1 confirmed and written up, 2 rejected as framed, 1 no verdict.**

| # | Objection | Verdict | Evidence |
|---|---|---|---|
| 1 | Free traffic can exhaust the global daily cap and deny service to paying customers. | **CONFIRMED — FIXED** | `takeDailyBudget()` was called with one ceiling for everyone, and a free stamp took a unit of the same budget a paid stamp needs. See §5.1. |
| 1b | The route in is `x-forwarded-for` spoofing. | **PLAUSIBLE, and not needed** | `callerIp` does trust the leftmost `x-forwarded-for` entry, and `lib/_ratelimit.js`'s own comment concedes it is "only as trustworthy as the header the edge network hands us". Whether the platform overwrites a client-supplied value is not answerable from the repository. It does not matter: the finding is reachable without it (§5.1). **Settled by:** one request to the deployed endpoint with a forged header, checking whether the recorded address is the forged one. |
| 2 | A captured request can be replayed to drain a customer's balance. | **REJECTED as framed** | The same-fingerprint replay is handled and the reviewer concedes it: the `prior` read returns the existing record with `existing:true`, writes nothing and charges nothing, ahead of every meter. The remaining scenario — reuse a stolen bearer key with a *new* fingerprint — is credential compromise, not replay; it is identical on `/api/pin` and on every bearer API, and no nonce helps an attacker who holds the key. The "capture it on public Wi-Fi" step is false over HTTPS. The CORS `*` does not widen this: no `Access-Control-Allow-Credentials` is set and a browser attaches no bearer on its own. |
| 2b | *My own finding, adjacent:* a stolen or over-eager key has **no per-key spend limit** on stamps. | **CONFIRMED — not fixed, §6** | `api/pin.js` has `rateLimited(key)`, 60 pins per key per hour. `lib/_stamp.js` has no per-key limiter at all — only per-IP, and IPs are cheap. The blast radius is bounded by the balance and by the daily cap, so it is a spend-rate gap, not a solvency gap. |
| 3 | A stamp can be written without being charged. | **CONFIRMED as true, REJECTED as a defect** | Real and deliberate: the balance is checked before the write and debited after, so a balance drained in that window leaves a written stamp uncharged. The code says so in its own comment, logs `STAMP WRITTEN BUT NOT CHARGED` for reconciliation, tells the customer they were not billed, and the amount is a tenth of a cent. Erring toward the customer is the right direction; the reverse (debit first) would charge for stamps that failed to land. The reviewer's line reference (`_stamp.js:525`) does not point at that block. |
| 4 | GitHub-as-a-database cannot take the load; `takeDailyBudget` writes one file per day for every stamp and is a global serialization point. | **CONFIRMED (the serialization point); evidence mischaracterized** | The single-file daily counter is real: every new fingerprint reads and writes `stamps/_meta/day-<date>.json`, so all stamp traffic across all instances contends on one path, with the 409 retry (4 attempts, up to 10.5 s) and a 3-attempt 422 create-race loop above it. The 465/532 figure does **not** support the claim as stated — that probe had ten writers creating *distinct* files and measured branch-ref contention, not same-path contention. This is an architecture change, not a small fix. §6. |
| 5 | Prior art: OpenTimestamps, a DIY git commit, blockchain `OP_RETURN` make the paid unit unnecessary; the platform choice kills the product. | **NO VERDICT** | A strategy question, not a code-correctness claim, and out of scope for this triage. Recorded for whoever owns the positioning. Noted only as a matter of accuracy: the review calls a git history mutable and a chain immutable; this service's own copy is held to neither claim. |
| 8-series | Leaks: a filename, label, free text, raw key or key hash reaching the public record, a commit message, or a URL. | **REJECTED** | The record is `{kind, v, sha256, size, stamped_at}` and nothing else; extra request fields are **refused** with a 400 rather than dropped; the commit message is `stamp <first 16 hex of the hash>`; the response URLs carry only the repo, branch and hash path. The debit's `reason` string does carry the hash prefix into the ledger — and the ledger lives in the **private** usage repo (`api/fulfill.js`, `CHANGELOG.md`), not a public one. |

### 5.1 The most serious confirmed finding, and its failing sequence

`lib/_stamp.js`'s header names four fences and says of the third: *"The fence
that holds under attack is the global daily cap below it (store-backed,
cross-instance, fail-closed)."* The cap is all three of those things and it
does hold. The problem is what it was holding against.

**The failing sequence, before the fix:**

1. `STAMP_DAILY_CAP` defaults to 500. `takeDailyBudget()` took one unit for
   **every** new fingerprint, free or paid, against one ceiling.
2. An attacker posts 500 distinct, freshly-generated fingerprints. No key, no
   balance, no cost.
3. The per-address free allowance is supposed to stop this at 3. It does not:
   `freeDays` is a module-scope `Map` on **one warm serverless instance**, so
   it resets on every cold start and is granted again, independently, by every
   concurrent instance. The file's own comment already concedes the real
   ceiling is "(instances × 3), not 3". No header spoofing is required; a small
   pool of addresses removes even that limit.
4. `stamps/_meta/day-<date>.json` reaches 500.
5. A **paying** customer posts a stamp with a valid key and a funded balance.
   `takeDailyBudget` refuses. They get 429 `daily_cap_reached` — and the body
   of that very 429 reads *"a paid stamp is never silently dropped."*

The fence that was supposed to hold under attack was itself the thing being
exhausted, and its exhaustion refused the customer it existed to protect.

**The fix**, kept to the narrowest change that makes the code do what it
already says:

- `freeCeiling()` = `floor(DAILY_CAP × STAMP_FREE_SHARE_OF_CAP)`, default
  `0.5`, clamped to `[0,1]`, a nonsense value falling back to the default. A
  free stamp is measured against it; a paid stamp against the whole
  `DAILY_CAP`. The gap is a floor under paying customers. No new stored state,
  no change to the paid ceiling, no change to what a stamp costs. An operator
  who wants the old behaviour sets the share to `1`.
- When the free **share** is what ran out, the request falls **through** to the
  paid path instead of being refused, so a key-holder is charged rather than
  turned away. This part is not decoration: without it the refusal body would
  have told callers a key would work while the code refused them before reading
  one, and a response that lies is worse than the bug it was added for. A
  keyless caller there gets 401 `free_daily_cap_reached`, naming the path that
  does work.
- The balance is still read **before** any budget unit is taken, so an
  insufficient balance still refuses without spending the day.

`test/stamp_free_cannot_starve_paid.test.js`, 3 tests. The must-fail arm sets
the share to the whole cap and proves free traffic **does** starve the paying
customer there — so the main test cannot pass against a build where the two
ceilings are the same number.

---

## 6. Open items

Nothing here was fixed. Each says whether it blocks a **beta of stamps**.

| # | Item | Blocks a stamps beta? |
|---|---|---|
| **O1** | **The stamps repository does not exist.** Nothing is pushed, the genesis tool has never been run, and `STAMP_*` is unset in production. | **Yes — it is the beta.** This is the work, not a defect. |
| **O2** | **`projects/arcaeon/front_end/stamp.html` folds the API's 401 `key_required` and 402 `insufficient_credit` into a generic outage message**, so the price the API returns is never shown to the person. Reported by the pricing council. That file is outside this repository and was not touched. | **Yes for PAID stamps. No for free ones.** A free stamp never reaches either response, so a free-only beta is unaffected. The moment a stamp costs money, the customer hits a wall that says "something went wrong" instead of a price — which is also the first place the new 401 `free_daily_cap_reached` message (§5.1) would be swallowed. |
| **O3** | **The price, `STAMP_PRICE_CREDITS = 0.25`, is a placeholder and is not ratified.** Its math is in the source; pricing authority for this lane is not mine. | **Yes for PAID stamps. No for free ones.** |
| **O4** | **The 409 retry's worst case (21.0 s) exceeds the likely function ceiling** (§4), and `maxDuration` was never read from the live project. | **No, and it is not new** — it is a property of the pin path, which is already in production behaviour terms unchanged by this candidate except that the retry now *exists*. It is a **deploy-day check** (§8), not a stamps gate. Worth saying plainly: if the ceiling really is 10 s, a heavily-contended pin is cut off mid-retry rather than answered. |
| **O5** | **`takeDailyBudget` serializes every new stamp on one file per day** (§5, objection 4). At beta volumes this is fine; at the cap it is the first thing to bend. Fixing it is an architecture change (sharded counters, or a different store), not a merge-time edit. | **No at beta volume.** Revisit before any volume commitment. |
| **O6** | **No per-key spend limit on stamps** (§5, objection 2b). `api/pin.js` limits 60 pins per key per hour; the stamp path has only a per-IP fence. A compromised key can be spent faster than a compromised pin key. | **No.** Bounded by the balance and the daily cap. Worth closing before stamps carry real balances at volume. |
| **O7** | **The sealer's own stated residual, in its author's words:** a sealer that stalls between the pre-root claim check and the root PUT, past its own lease, is not made safe by the claim. | **No — the flag is off.** `WITNESS_BATCH_SHADOW` defaults OFF and stays off in this candidate, so no batch accumulates, no root is written and no proof is issued. This must be closed before the flag is ever turned on, not before stamps ship. |
| **O8** | **Audit items left open from the 10 commits**, unchanged here: the retried write's `pinned_at` can be ~10 s stale (#4); a `getFile` failure during the retry's re-read is reported as the original 409 (#6); `MAX_LEAVES` is not enforced on the real accumulation path (#11); `headConflict` can refuse a leaf for a pin the public repo already accepted (#16); `validateLeaves` checks presence, not type (#17). | **No.** Every one is in the pin/batch path, and the batch half is dark. |

---

## 7. Environment variables production needs (names only)

Already set in production, unchanged by this candidate:

    GITHUB_PIN_REPO, GITHUB_PIN_BRANCH, GITHUB_PIN_TOKEN
    GITHUB_USAGE_REPO, GITHUB_USAGE_BRANCH
    WITNESS_KEYS, WITNESS_PLANS, WITNESS_CADENCE, WITNESS_ADMIN_KEY
    WITNESS_BASE_URL, WITNESS_DOCS_URL
    WITNESS_RETIRED_NS, WITNESS_REFERENCE_NS_EXACT
    WITNESS_STRIPE_SECRET_KEY, WITNESS_STRIPE_WEBHOOK_SECRET,
    WITNESS_STRIPE_PRICE_MAP, WITNESS_STRIPE_LIVEMODE, STRIPE_SECRET_KEY

**New, and required before any stamp can be written** (absent them the endpoint
is 503 and nothing else changes — cross-feature test (b)):

    STAMP_REPO      the stamps repository, "owner/name". Must NOT be the pins
                    repo; it is refused if it is.
    STAMP_TOKEN     a fine-grained token scoped to that repository ONLY. Must
                    not be the same value as GITHUB_PIN_TOKEN; the code logs
                    loudly if it is, and cannot see a token's scope from here.

**New, optional, with safe defaults:**

    STAMP_BRANCH             default "main"
    STAMP_DAILY_CAP          default 500; 0 disables stamping entirely
    STAMP_FREE_PER_DAY       default 3; 0 makes every stamp paid
    STAMP_FREE_SHARE_OF_CAP  default 0.5 — the free tier's share of the daily
                             cap (§5.1). 1 restores the pre-fix behaviour.
    STAMP_SITE_BASE          default "https://arcaeon.io"

**Must stay unset (or off):**

    WITNESS_BATCH_SHADOW     the sealer is dark code in this candidate.

---

## 8. Deploy-day checklist

Nothing below has been done. In order; stop at the first failure.

1. **Create the stamps repository** by hand, public, empty. Do not reuse the
   pins repo.
2. **Issue a fine-grained token scoped to that repository only**, with contents
   write and nothing else. A different value from `GITHUB_PIN_TOKEN`.
3. **Set `STAMP_REPO` and `STAMP_TOKEN`** in the project. Leave
   `WITNESS_BATCH_SHADOW` unset.
4. **Read the deployed function's `maxDuration` from the live project** and
   write it down next to §4's 21.0 s. This is the one number this document
   could not obtain. If it is 10 s, decide — before deploying, not after —
   whether the retry shape or the ceiling moves.
5. **Confirm the function count.** 12 files in `api/`. A 13th is a refused
   deploy, not a warning.
6. **Deploy.** Then, in order:
7. **`GET /api/health`** answers, and **`/status`** renders.
8. **Verify an old pin receipt still verifies.** Take a pin that exists in
   production today and re-run its verification; the verdict must be unchanged.
9. **Confirm the status page is unchanged** except for the posture fix already
   reviewed: the namespace table, the conflict count and the reference tagging
   read as they did. Specifically, the conflict count must not have moved.
10. **Stamp a test file.** Hash a throwaway file locally, `POST /api/stamp`.
    Expect 201, a `commit` sha, and `billing.paid: false` on the free tier.
11. **Read the commit back from the public stamps repository** in a browser,
    logged out. The record holds a hash, a size, a time and nothing else — no
    filename anywhere in the record, the commit message or the path.
12. **Re-stamp the same file.** Expect 200 with `existing: true`, **no new
    commit** in the repository, and **no debit** on any balance. Check the
    repository's commit list, not just the response.
13. **Confirm nothing landed in the pins repository.** No `stamps/` path, no
    new commit from the stamp traffic.
14. **Run the genesis tool dry** first, read its plan, then run it for real —
    once. Confirm the record lands under `genesis/`, not `observations/`, and
    re-check the status page's conflict count has not moved.
15. **Only then**, if a paid beta is intended: close O2 (the front end swallows
    401 and 402) and settle O3 (the price). A paid beta that ships before O2 is
    a customer hitting "something went wrong" where a price should be.

---

## 9. Claims discipline

Every line of copy and comment written into this candidate holds to this: a
later change **would show**. Nothing here says impossible to alter, tamper-proof
or immutable; nothing claims multiple witnesses or independence strength;
nothing implies adoption; nothing says qualified timestamp. The stamp records
and the genesis record carry the same scope sentence — what a stamp proves, and
what it does not: not who made the file, not that anything it says is true, not
that no other version exists.
