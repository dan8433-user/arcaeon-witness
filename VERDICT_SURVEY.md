# VERDICT_SURVEY — where a success can be built without a verdict

Branch `verdict-required`, base `release-candidate-2026-09-20` (`30bd34c`). 2026-09-21.
All line numbers below are **at the base commit**, so they can be checked with `git show 30bd34c:<file>`.

## 0. A correction to the premise, first

The task said to find the 2026-09-20 fix in this repo's git log. **It is not in this repo.** Searches that came back empty here, on every branch (`git log --all`):

- `git log --all -S"proves nothing"`, `-S'"genesis"'`, `--grep` for `genesis|corrupt|verdict|503|health|ledger|witnessed|unreadable|default` — no commit matching the described fix
- `grep -rn "fixture did not break"` over the whole worktree — 0 hits
- `git grep -E 'chain: *"genesis"|rows: *0|status: *"witnessed"'` over `api lib tools` — 0 hits

The fix lives one repo over, and I read it there (read-only, nothing touched):

- `arcaeon-receipt` `b5d98a7` (2026-09-19) — `call_proxy /health: 503 when the ledger is unreadable or does not verify`. This is the endpoint that answered `200 {"ok": true, "rows": 0, "chain": "genesis"}`.
- `arcaeon-receipt` `757fc18` (2026-09-19) — pin refuses a ledger that does not verify; verify page fails closed on unknown status.
- `arcaeon-ledger` `9e3dc66` — `Head carries the verify verdict; as_pin() and publish_head() refuse a red ledger`.
- The planted-dead fixture and its guard are at `arcaeon-receipt/tests/test_call_proxy.py:408-429`, inside a 450-line test file.

So the **origin constructor (`Ledger.head()` / `Head`) is Python, in `arcaeon-ledger`, and this task did not touch it** — I was scoped to one worktree of `arcaeon-witness`. What follows is the same defect class hunted in the Node witness service, which is a legitimate place to look (it found real instances) but is not the repo the bug was born in. Remedy A still needs doing, or confirming done, in `arcaeon-ledger`/`arcaeon-receipt`; and remedy B's "give it its own file" still applies to `test_call_proxy.py` there.

## 1. Greps run (coverage)

Over `api/ lib/ tools/` at the base commit, `git grep -n -E`. Count = matching lines.

| count | pattern | what I did with the hits |
|---|---|---|
| 54 | `ok: *true` | every hit located and classified in §2/§3. Hits in files listed below as "not read line by line" (stripe-webhook, _sealer, _merkle, _keys:223, _claim) were classified from the line and its immediate context, not from a full read of the function |
| 137 | `ok:` | skimmed; the `ok: false` majority are refusals (N/A) |
| 23 | `verified` | all comments/prose or Stripe "payment verified" copy; none builds a field |
| 9 | `witnessed:` | all in `api/verify.js`; every one read |
| 0 | `status: *"witnessed"` | — |
| 0 | `chain: *"genesis"` | — (the only "genesis" in code is `tools/stamp_genesis.js`, a create-only birth record, unrelated) |
| 0 | `rows: *0` | — |
| 3 | `\?\? *"` | request parsing only |
| 10 | `\|\| *0\b` | 5 are stored-counter reads → DEFAULTED; rest are in-memory maps / tool counters |
| 0 | `\?\? *0\b` | — |
| 8 | `: 0;` | 4 are stored-record reads → DEFAULTED |
| 4 + 11 | `\|\| *\[\]`, `: \[\];` | listings → DEFAULTED; legacy-optional arrays → see §4 |
| 16 + 15 | `= *\{\}`, `\|\| *\{\}` | option-bag defaults and `req.query \|\| {}`: N/A. Env-JSON parse fallbacks: see §4 |
| 33 | `\|\| *null` | display fields on refusals and records: N/A |
| 21 + 10 | `status\(200\)`, `status: 200` | cross-checked against the `ok: true` list; the read endpoints (latest, verify, status, badge, balance, stamp GET, fulfill revisit) were traced back to the read they are built from, the write endpoints were not re-traced |
| 2 | `\? *"ok"\|: *"ok"` | both DEFAULTED (fallthrough-to-green ternaries) |
| 13 | `isArray\(.*\) *\?` | listings + legacy arrays, as above |

**Read in full:** `api/health.js latest.js verify.js(1-280) badge.js credit.js`, `lib/_verdict.js`(new) `_status_data.js _status_json.js`, the read/CAS halves of `_store.js _balance.js _meter.js`, `_stamp.js` 225-320 and 395-605, `_keys.js` 280-345, `_batch.js` 83-110 and 188-250, `_claim.js` 133-280, `_pending.js` 95-110 and 255-300, `pin.js` 80-110 and 496-760, `fulfill.js` 425-653, `tools/reconcile_batches.js` 130-150, 214-232, 360-436.
**Grepped but NOT read line by line:** `api/distill.js`, `lib/_distill_core.js` (text transform, no stored state), `api/renew.js`, `api/stripe-webhook.js` 1-220, `lib/_sealer.js`, `lib/_merkle.js`, `lib/_prefix_check.js`, `lib/_prefix_ui.js`, `lib/_page.js`, `lib/_cors.js`, `lib/_ratelimit.js`, `lib/_welcome_email.js`, `lib/_stamp_store.js`, `tools/seal_batch.js`, `tools/ceiling_probe.js`, `tools/stamp_genesis.js`, `api/status.js` outside the lines quoted. A DEFAULTED site that matches none of the patterns above could be sitting in any of those.

## 2. DEFAULTED — a success could be built from defaults. All fixed.

"Damaged" below means: the document is **present** (the store answered 200) and is not the record it should be. Absent (404) is the honest empty case and is kept.

| # | file:line (base) | what it builds | how a default reached it | fix |
|---|---|---|---|---|
| 1 | `lib/_store.js:238` `listDir` | directory listing | 200 + non-array body → `[]` = "empty directory" | `verdict.requireListing` throws |
| 2 | `lib/_store.js:252` `getTree` | repo tree | `body.tree` not an array → `[]` = "no files" | same |
| 3 | `lib/_store.js:280` `getTreeMeta` | tree for the reconciler | same → reconciler walks zero files | same |
| 4 | `lib/_keys.js:297` `listDir` | issued-key listing | non-array → `[]` = "no prefixes are spoken for" | same |
| 5 | `api/latest.js:65,82,108` | `200 {ok:true, pin, status…}` | `pin = got.json` unjudged; `{}` passes every `pin && typeof` guard in `computeCadenceFields` → `status:"legacy_no_deadline"` | `judgePin` → 503; body built by `verdict.success` |
| 6 | `api/latest.js:68` (catch) | same | a head that was REACHED and is not JSON fell back to the raw CDN, which may still serve the last good copy | parse failure is a red verdict; no fallback |
| 7 | `api/verify.js:132,194` | `200 {ok:true, witnessed:false}` | damaged head skips cases 1–2, scan starts at `: 0`, walks nothing → **conclusive** "not_found_in_history" | `judgePin` → 503; `: 0` deleted; every `ok:true` via `verdict.success` |
| 8 | `api/verify.js:205` + scan loop | conclusive `witnessed:false` | a hole, or a record that is not a pin, was skipped in silence | counted; any negative after one becomes `witnessed:null reason:"history_unreadable"` |
| 9 | `lib/_status_data.js:104` | a graded board row | damaged head → `status:"legacy_no_deadline"` (yellow), not an error (red) | `judgePin` → error row → `degraded` |
| 10 | `lib/_status_data.js:137` | `conflicts_observed` + overall `ok` | `let obsCount = 0`; tree read throws → stays 0, and `obsErr` was not an input to the verdict → `ok:true, conflicts_observed:0` | `null` until counted; `conflictsUnknown` → `indeterminate` |
| 11 | `lib/_status_json.js:59` | `status` word | `degraded ? … : indeterminate ? … : "ok"` — fallthrough is green | `overallWord()` throws unless three explicit booleans, exactly one true |
| 12 | `api/badge.js:47-48` | badge word + colour | same ternary, twice | same |
| 13 | `lib/_balance.js:207` `readBalance` | `{balance}` → `/api/balance` 200 | `Number(x) \|\| 0` | `judgeCounter` / `counterValue` throw |
| 14 | `lib/_balance.js:268` `debitCredits` | `insufficient_credit` → 402 "buy more" | same | same |
| 15 | `lib/_balance.js:348` `grantCredits` | **a write**: `balance = 0 + pins` | same — replaced the damaged file (observed: balance 100, seq back to 1) | same; webhook answers 500, Stripe retries |
| 16 | `lib/_meter.js:187` `check` | `{ok:true}` free-tier grant | `\|\| 0` — **fails open**, re-opens a spent month | same |
| 17 | `lib/_meter.js:231` `peek` | usage shown on `/api/balance` | same | same |
| 18 | `lib/_stamp.js:296` | `{ok:true}` budget take | `: 0` — fails open, re-opens the day | same |
| 19 | `lib/_stamp.js:306` | same, in the CAS rebuild hook | same | same |
| 20 | `api/pin.js:95` `latestPointerRebuild` | overwrite of `latest.json` | damaged fresh pointer → `freshSeq = 0` → written over | `judgePin` + `requireGreen` throw; write fails |
| 21 | `api/pin.js:515` (+ guards 539, 552; seq default 729) | `201` new head | every guard is `cur && Number.isInteger(cur.json.rows) && …`; a damaged head skips the monotonic AND the re-mint check, `seq` defaults to 1 | `judgePin` right after the read → 503 before any charge |
| 22 | `api/fulfill.js:455` | `200 {ok:true, key}` key page | `record = cur.json` unjudged → `key: undefined` | verdict on the record → thrown → existing 502 |
| 23 | `lib/_stamp.js:252` `present` (callers 405, 433, 549) | `200 {ok:true, stamp}` | record unjudged: another fingerprint's stamp answered 200 for the one asked about (observed); `{}` crashed in `stampPath` | `judgeStamp(record, sha)` with `sha` required; body via `verdict.success` |
| 24 | `lib/_store.js:616` `computeCadenceFields` | cadence grade | `pin` undefined/null → graded `legacy_no_deadline` | throws `VerdictRequiredError` |
| 25 | `lib/_status_data.js:55` `cadenceStatus` | same (the deliberate independent twin) | same | same |

**Genesis, visibly.** `lib/_verdict.js` has two green states, `verified_record` and `verified_empty`. `judgeRead` mints `verified_empty` in one place, for `got === null`, which every store reader in this repo returns for a 404 and nothing else (checked: `_store.getFile:64`, `_balance.getFile:114`, `_meter.getUsageFile:113`, `_pending.readUsageDoc:99`). `got === undefined` — a read that never happened — throws.

## 3. SAFE — the verdict is already explicit

- `api/health.js:34-44` — `ok: reachable`; `repoReachable` returns `r.ok` or `false`, no default-true. Claims reachability only, says nothing about any ledger.
- `lib/_status_data.js` `reachable = false`, `anchorStatus = "cannot_determine"` — defaults that fail closed.
- `api/status.js:269-273` (HTML header) — the fallthrough branch is amber, green requires `overallOk` truthy.
- `lib/_batch.js:100-108, 200-214, 244` — `chain_starts_here` defaults **false**; a null `prev_root` is refused at seal time unless `readPrevRoot` proved nothing earlier exists, and an exhausted lookback throws `chain_break`. This module already treats genesis as something to be proved.
- `lib/_pending.js:259-264` — `initialState` only on the store's 404; a present document without a leaf array throws `err.corrupt`.
- `tools/reconcile_batches.js:414-436` — CLEAN requires zero findings AND zero `could_not_look`; a truncated tree is INCOMPLETE. Arguments are destructured with no defaults, so a missing list throws.
- `api/pin.js:285-320` `healIfWedged` — the orphan record is shape-checked field by field before adoption.
- Write-result successes (`api/pin.js:581,660,775`, `api/credit.js:86`, `api/stripe-webhook.js:192-297`, `api/fulfill.js:435,623` after #22, `api/distill.js:227`, `lib/_balance.js:312-416`, `lib/_claim.js:216,280`, `lib/_sealer.js:467`, `lib/_merkle.js:307`) — each is built after an awaited write or a pure computation returned; none is reachable from a failed read.

## 4. DEFAULTED-shaped, deliberately NOT changed

- `lib/_keys.js:311-315` `listPrefixes` — a key record with no readable `namespace_prefix` is skipped, so its prefix reads as free. Same class. **Not fixed**: the fix is to throw, and one legacy key record in the live usage repo without that field would then block every new checkout. Needs a look at the live data first; I could not see it from here.
- `lib/_balance.js:208,285,350`, `lib/_store.js:523,559`, `api/pin.js:313,754` — `seq`, `applied_events`, `intervals`, `missed_deadlines`, `renewals_total` default to empty when absent. These fields were added after launch, so **absent is a legitimate legacy state** and cannot be told from damage by shape alone. A damaged `applied_events` would weaken the double-credit guard; nothing here detects that.
- `lib/_claim.js:137,256-260` — an unparseable `expires_at` reads as "still live" / "still held". Conservative for a would-be taker, permanent for a damaged claim. Left alone.
- `lib/_status_data.js` still calls `getTree`, which drops GitHub's `truncated` flag, so on a very large repo the conflict count is a lower bound presented as a count. The repo's own comment accepts this; existing tests stub `getTree` directly, so switching was not a small change.
- `api/latest.js` raw-CDN fallback: when the contents API is **unreachable** and the CDN says 404, the answer is still 404 "no pin recorded". That is staleness, not damage; unchanged.
- `lib/_meter.js:82`, `lib/_store.js:480`, `api/fulfill.js:142` — malformed env JSON (`WITNESS_PLANS`, `WITNESS_CADENCE`, price map) falls back to `{}`. Configuration, not a verdict about stored state; the meter already has its own fail-closed `no_cap_configured`.
- Error bodies across the repo (400/404/502) carry `error` and no `ok:false`. Pre-existing convention, not touched. The new 503 refusals do carry `ok:false`.

## 5. Must-fail arms — each run red, by putting the defect back

Method: a script edited the source in place, ran the named test file, captured the first failing line, restored the file, and `git diff --stat` was compared before/after (identical). Two layers exist at most endpoint sites (the call-site check and the `success()` constructor), so those were run twice: once with only the call-site check removed — the constructor catches it — and once with both removed, to see the original symptom.

| arm | defect put back | red line |
|---|---|---|
| A1 | `requireVerdict` given a default | `success() built an answer from undefined` |
| A2 | `requireGreen` no longer throws on red | `Missing expected exception.` (RED NEVER RENDERS GREEN) |
| A3 | damaged document judged `verified_empty` | `damaged head read as green: {"json":{}}` |
| B1 | latest: call-site check off | `RedVerdictError: latest: red verdict (rows_unreadable) cannot be rendered as a success` |
| B1x | latest: both layers off | `damaged head {} answered 200` |
| B2 | verify: head check off | `RedVerdictError: verify: red verdict (rows_unreadable) cannot be rendered as a success` |
| B2x | verify: both layers off | `damaged head {} answered 200` |
| B3 | pin: head check off | `pin over a damaged head answered 201: {"ok":true,"record_kind":"content_head_advance",…` |
| B4 | `let obsCount = 0` | `an uncounted conflict log reported a number` |
| B5 | status row: call-site check off | **stayed green** — `requireGreen` on the next line threw, the row's own catch made it an error row. Reported as it happened. |
| B5x | status row: both guards off | `damaged head rendered as a graded row: {…"rows":0,"chain":"genesis",…"status":"legacy_no_deadline"…` |
| B6 | balance `\|\| 0` | `Missing expected rejection (RedVerdictError).` |
| B7 | meter `\|\| 0` | `Missing expected rejection (RedVerdictError).` |
| B8 | stamp budget `: 0` | `a damaged day counter re-opened the budget: 201 {"ok":true,"existing":false,…` |
| B9 | listing non-array → `[]` | `Missing expected rejection.` |
| C1x | PLANTED DEAD, latest, both layers off | `/api/latest: fixture did not break the ledger; the test proves nothing` |
| C2x | PLANTED DEAD, verify, both layers off | `/api/verify: fixture did not break the ledger; the test proves nothing` |
| C3 | PLANTED DEAD, pin head check off | `/api/pin: a new head was accepted over a dead one` |
| D1 | `overallWord` falls through to "ok" | `Expected values to be strictly equal:` (THE BOARD'S WORD) |
| E1 | pin rebuild hook `: 0` | `the rebuild hook read a damaged pointer as seq 0 and wrote over it (handler answered 201)` |
| E2 | fulfill record verdict off | `a damaged fulfillment record rendered a success page: {"ok":true,"mode":"new_key","credits":1000,…` |
| E3 | cadence grader guards off (each, separately) | `Missing expected exception (VerdictRequiredError).` |
| E4 | keys listing non-array → `[]` | `Missing expected rejection.` |
| E5 | verify scan skips unreadable in silence | `a scan that could not read one record still concluded: rows_never_witnessed` |
| E6 | latest falls back to CDN on a parse failure | `/api/latest: fixture did not break the ledger; the test proves nothing` |
| F1x | stamp: both layers off, mismatched record | `a damaged stamp record answered 200: {"ok":true,"existing":true,"stamp":{…"sha256":"dddd…` |

Two honest footnotes. **C1/C1x, non-JSON arm:** red, but through a `TypeError` that is an artifact of how the mutation was written (`pinRead.json` on `undefined`), not the original symptom; the valid-JSON arm is the clean one. **E6:** the test mock serves the raw-CDN host from the same garbage bytes, so what went red was "502 with no `ok:false`", not "stale 200 from a lagging CDN". The stale-CDN scenario the fix is aimed at is reasoned from the code, not simulated.
