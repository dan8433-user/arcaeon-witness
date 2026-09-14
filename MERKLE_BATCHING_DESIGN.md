# Merkle batching for the Arcaeon hosted witness — design

**Status: PARTLY IMPLEMENTED (2026-09-13, `6c0bb93` then the sealer).** Written 2026-08-14
against the working tree at that date. This document proposes batching N pins into a Merkle
tree, committing only the root per interval, and serving per-pin inclusion proofs.

**What is built, and what is not.** `6c0bb93` implemented the *mechanism*: §3 (tree
construction, root record, seal triggers) in `lib/_batch.js`, §5's proof object and
verification algorithm in `lib/_merkle.js`, and §6.3's same-batch conflict re-check.

**The caller now exists.** The gap that commit left — "Until the sealer exists, nothing
calls `sealBatch` in production: the library is complete and the caller is not" — is closed
by `lib/_pending.js` (the open batch and §6.1's pending head), `lib/_sealer.js` (the §3.4
trigger, the close boundary, the fail-closed refusal), `tools/seal_batch.js` (the operator
command, §11 Q3 decided below), and a nine-line accumulation hook in `api/pin.js` that runs
*after* a record is committed and can never change a pin's outcome. 22 tests, suite
236 → 258.

It still does **not** change publication: `api/pin.js` writes its seq record and its
`latest.json` pointer per pin exactly as before, and `api/latest.js` / `api/verify.js` are
untouched. That is §9 Phase 1 on purpose — "Keep per-pin commits exactly as they are.
Additionally build batches and commit roots." A receipt issued before any of this verifies
by exactly the path it always did; `test/sealer.test.js` holds that line by running the
real `api/verify` handler with the accumulator live and a sealer-committed root in the same
repo, and asserting from the store's own read log that the verifier read
`pins/<ns>/latest.json` and nothing under `batches/`.

**Phase 1 is a run, and it has not started.** Accumulation is off unless
`WITNESS_BATCH_SHADOW` is on. §9 Phase 1 is "Run it until a full week reconciles clean" —
an operator act with a start date and a week of watching, not a code state that arrives
with the next unrelated deploy. Turning it on starts the shadow run; turning it off is §9's
own rollback ("stop batching, resume per-pin"). Nothing has been deployed.

Still unbuilt, and named here rather than left to be discovered: §6.1's *pin-refusing*
fail-closed branch (the sealer-side refusal is built; see §6.1 for why the 502 is a Phase
3/4 change), `inclusion_due_by` / `inclusion_state` / the `cannot_determine` pending grade
on `/api/latest` (§4.3, §4.4), the self-grading counters on `/status` (§7), the
`GET /api/proof` endpoint (§5) — `api/` is at the Vercel Hobby 12-function cap, confirmed
at `9e8b060`, so serving proofs needs an `?op=` mode on an existing function the way
`api/verify.js?op=bulk` already does — and the client-side `verify_inclusion` /
`verify_root_published` surface (§8, a different repo).

**Measured write cost (2026-09-13, `6c0bb93`), counted from the code path under the mock
store, not estimated.** The counts come from the test fixture's own `putLog`, which records
every successful PUT, so they are not numbers the code under test reports about itself.
There is no network in the harness, so these count contents-API write *calls*; the mapping
to commits is one-to-one (`lib/_store.js:103`, `// PUT (create or update) a file via the
contents API — one commit per call.`).

| | writes into the pin repo | per pin |
|---|---|---|
| 10 pins through `api/pin.js` today | 20 | **2.0** |
| one sealed batch of 10 leaves | 2 | **0.2** |
| one sealed batch of 100 leaves | 2 | 0.02 |

A batch costs two writes — `leaves.json` then `root.json` — regardless of leaf count, plus
one unbatched observation write per §6.3 conflict, which §6.2 refuses to batch. The §1
projection of O(2N) → O(1) per interval holds at the measured numbers.

**Citation rule.** Every claim this document makes about *current* behavior cites the
file and line it was read from, and quotes enough of the line to survive renumbering.
Anything not carrying a citation is a proposal, not a description. Where a claim
depends on a third-party limit we have not measured, it says so instead of asserting a
number.

**Citations are against the working tree as of 2026-08-14, which at the time of writing
carried uncommitted changes to `api/pin.js`, `api/_store.js`, `api/latest.js` and
`api/status.js` (the renewal / heartbeat / interval-history work).** Every line number
below was re-verified against that tree, and each citation quotes its anchor text so it
stays checkable after renumbering. A reader diffing against an older commit should expect
line drift and match on the quoted text instead.

---

## 1. Why — the ceiling we are actually hitting

Today one accepted pin costs **two GitHub API writes**, and each write is one commit:

- `api/pin.js:303` — `// --- commit the pin, then update latest.json (2 commits, Stage-0) ---`
- `api/pin.js:306` — `const put = await store.putFile('pins/${namespace}/${seqName}.json', pin, msg);`
- `api/pin.js:307` — `await store.putFile(latestPath, pin, 'latest ${namespace} rows=${rows} seq=${seq}', ...)`
- `api/_store.js:39` — `// PUT (create or update) a file via the contents API — one commit per call.`

The renewal path pays the same two writes (`api/pin.js:232` and `api/pin.js:236`), so a
publisher heartbeat costs exactly as much as a real advance.

Write cost is therefore **O(2N) in pins**, and every one of those writes is a
serialized call to a single third-party API on one branch. That is the ceiling: not CPU,
not storage, not our own limiter. Our own limiter is admittedly not the real constraint
anyway —

- `api/pin.js:20` — `// Naive per-key rate limit (Stage-0): per-instance, resets on cold start.`
- `api/pin.js:21` — `const RATE_LIMIT = 60; // pins per key per hour, per warm instance`
- `api/pin.js:22` — `const rateBuckets = new Map(); // key -> {windowStart, count}`

— a per-instance `Map` on a serverless platform is a speed bump, not a ceiling. The
GitHub contents API is the hard one, and it is shared across every namespace we host.

**What batching buys.** Group every pin accepted in an interval into one Merkle tree and
commit only the root. Write cost becomes **O(1) per interval** — a fixed small number of
commits regardless of whether the interval held 1 pin or 10,000. Per-pin cost goes to
approximately zero, and the ceiling stops being a function of customer volume. That is
the entire motivation, and it is a real one: the current design cannot take a customer
who pins every minute without eating the whole shared budget.

**Note on the exact GitHub numbers — MEASURED 2026-09-13.** This paragraph said
"unmeasured" from August until now. It has been measured, with `tools/ceiling_probe.js`,
against two throwaway private repos created and deleted for the purpose — never the live
pin repo, because GitHub enforces secondary limits **per authenticated identity, not per
repository**, so tripping the limit anywhere puts the serving token in cooldown. Account:
personal **User** account, plan `free`, classic PAT.

- **Sequential, one writer, one branch: no ceiling found.** 577 writes accepted in 360 s
  (**96/min**) with zero refusals; the run ended on the probe's own six-minute cap, not on
  a GitHub limit.
- **Payload size does not move it.** A second sequential run at a 4 KB payload accepted
  279 writes in 180 s (**93/min**), also with zero refusals. Median per-write latency was
  603 ms at 64 bytes and 626 ms at 4 KB. A single sequential writer is **latency-bound at
  ~95 writes/min, not limit-bound** — the round trip is the constraint, not the quota.
- **Concurrency trips it, and quickly recovers.** Ten concurrent writers on one branch
  accepted 65 writes in 49 s and then took a **429** carrying GitHub's "You have exceeded
  a secondary rate limit" page, with **no `Retry-After` header**. Recovery was **~16 s**
  (polls at +5 s and +10 s refused, +16 s accepted). So the secondary limit is a **short
  burst allowance that refills in seconds, not an hourly ban** — which is the form of the
  answer that actually constrains a batch interval, and it constrains it barely.
- **The limiter counts requests, not accepted writes — and branch contention bites
  first.** Of the 532 requests that burst issued, only 65 were accepted and **465 were
  409s**: ten writers committing to one branch move the ref under each other, and
  `lib/_store.js:putFile` has no retry. **Fixed in `aaa1378` (task 093, 2026-09-13):
  `putFile` now retries that 409 — bounded, jittered, re-reading to tell branch-ref
  contention from a path that actually moved — so contention costs latency instead of a
  lost pin; batching remains the throughput lever, because a retry buys correctness and
  not one extra accepted write per minute.** Ten-way concurrency therefore produced *less*
  accepted throughput (80/min) than one sequential writer (96/min) while spending eight
  times the request budget. **Adding write concurrency to a single branch does not buy
  throughput.**
- **The primary limit was never the constraint**, as this paragraph originally suspected:
  5,000/hr authenticated, and the whole probe (~1,400 requests, 409s included) never took
  remaining below 3,600.

GitHub does not publish secondary limits and can change them without notice, so the above
is a **dated observation, not a contract**. The standing rule is unchanged and now has a
date attached to it: **do not put a specific pins-per-hour figure in customer-facing
material** — a measurement this old is quotable internally and stale externally. What it
licenses is an internal planning figure (~95 writes/min ≈ **~47 pins/min** at today's two
writes per pin) and one design conclusion that matters more than the number: since
parallelizing writes on one branch makes throughput *worse*, **removing writes is the only
lever that works**, which is exactly what batching does. The *shape* of the win
(O(N) → O(1)) never depended on this measurement; the specific ceiling claim did.

---

## 2. What must not change

Batching is a change to *publication*, and it must not quietly become a change to
*semantics*. These properties are load-bearing and survive intact:

1. **Fingerprints only, never log content.** `api/_store.js:6-7` — `// readable, and any
   rewrite of history is visible. Pins hold fingerprints` / `// ONLY ({namespace, rows,
   chain, pinned_at}) — never log content.` A Merkle leaf is built from the same
   fingerprint fields and nothing more.
2. **The monotonic guard.** `api/pin.js:175` — `error: "monotonic violation: a witness
   never goes backward"`.
3. **The same-rows/different-chain conflict path.** `api/pin.js:264` — the observation
   write to `observations/${namespace}/${obsName}.json`, and `api/pin.js:269` returning
   the observation path in a 409.
4. **Fail-closed posture.** `api/pin.js:320` — `return res.status(502).json({ error:
   'pin store error: ${err.message}' });`, and the `no_cap_configured` branch at
   `api/pin.js:137-144` which denies rather than assuming unlimited.
5. **Deadline semantics and the refusal to grade what cannot be graded.**
   `api/latest.js:87` — `const cadence_gradeable = Number.isFinite(dueMs);` and
   `api/latest.js:136-142`, the `cadence_grade = "cannot_determine"` / `REFUSE-SEMANTICS`
   block. Section 4 leans on this precedent hard.
6. **Auth honesty stamping.** `api/_store.js:119` — `const AUTH_LEVEL = "bearer-stage0";`
   Batched records carry the same stamp; batching does not upgrade our auth story and
   must not appear to.

---

## 3. Tree construction

**IMPLEMENTED 2026-09-13 in `6c0bb93`** — `lib/_merkle.js` (§3.1, §3.2) and `lib/_batch.js`
(§3.3, §3.4). Three notes where the build had to decide something this section left open:

- **The canonicalizer already existed.** §3.1 requires `json-c14n:v1` and forbids a second
  implementation. `lib/_distill_core.js` already carries the JS side of exactly that recipe
  (`jdump(value, /* sortKeys */ true)`, the bytes its own `digestJsonC14n` hashes), so
  `lib/_merkle.js` calls that function rather than writing a sorted-key stringify. The one
  residual, documented at the call site: JS cannot tell `24.0` from `24`, so an integral
  `cadence_hours` canonicalizes as `"24"` while a Python client holding a genuine float
  would produce `"24.0"` and a different leaf hash.
- **A batch id is CONSUMED, not reused.** A seal that dies before its root write leaves an
  orphan `leaves.json` under that id, and §9's "nothing is ever rewritten" means the
  replacement batch takes the *next* id. So gaps in the id sequence are normal, and
  `batch_id > 1` stopped being the same question as "something came before me."
  `readPrevRoot` therefore walks back over the gaps, and refuses to *claim* a chain start it
  did not establish — an exhausted lookback is a typed `chain_break`, never a null
  `prev_root` that quietly starts a second chain.
- **No pointer file.** The chain tip is recovered by reading the previous published
  `root.json`, which already carries its own root (§3.3). A `batches/latest.json` pointer
  would be a third write per batch and a thing that can rewind; there is neither.

### 3.1 Leaf definition

A leaf is the **accepted pin record**, canonicalized and hashed. The canonicalization is
not invented here: it reuses `arcaeon-ledger`'s frozen `json-c14n:v1` recipe
(`arcaeon_ledger/artefact.py`, `RECIPES`), so the client can recompute a leaf with
`digest_json()` and we introduce no second canonicalizer and therefore no second drift
surface.

```
leaf_object = {
  "namespace":       "<ns>",
  "rows":            <int>,
  "chain":           "<lowercase hex>",
  "seq":             <int>,
  "accepted_at":     "<ISO8601Z>",     // the witness's own clock, at accept
  "cadence_hours":   <number>,
  "next_pin_due_by": "<ISO8601Z>",
  "record_kind":     "content_head_advance" | "publisher_heartbeat",
  "auth_level":      "bearer-stage0"
}
leaf_hash = SHA256( 0x00 || json_c14n_v1(leaf_object) )
```

`accepted_at` carries forward exactly what `pinned_at` means today — `api/pin.js:287`,
`pinned_at: pinnedAt.toISOString(), // the witness's OWN clock`. It is renamed in the leaf
only to make the accept-vs-seal distinction (section 4) impossible to blur. The stored
record keeps `pinned_at` for compatibility.

`record_kind` must be in the leaf. The heartbeat/advance distinction exists precisely so
a reader cannot conflate the two (`api/pin.js:294`, `record_kind: "content_head_advance"`;
`api/pin.js:218`, `record_kind: "publisher_heartbeat"`), and a proof that omits it would
let a heartbeat be presented as an advance.

**Deliberately NOT in the leaf:** the `intervals` and `missed_deadlines` arrays from
`appendInterval` (`api/_store.js:207`). They are derived, they are bounded by
`MAX_INLINE_HISTORY = 20` (`api/_store.js:202`) so they are *lossy by design*, and
including a truncated derived history in a hash commitment would make the commitment
depend on a window size we intend to change. The authoritative history stays the per-seq
record series in the repo, as `api/_store.js:281` already says: `only the most recent
${MAX_INLINE_HISTORY} entries are inlined here; the complete series is the per-seq record
history in the public pin repo`.

### 3.2 Internal nodes, domain separation, odd nodes

```
node_hash = SHA256( 0x01 || left_hash || right_hash )
```

- **Domain separation (`0x00` leaf, `0x01` internal), RFC-6962 style.** Without it a leaf
  whose bytes happen to be two concatenated hashes can be presented as an internal node.
  Cheap to do, impossible to retrofit once roots are public.
- **Odd node: PROMOTE, do not duplicate.** An unpaired node at a level is carried up
  unchanged. Bitcoin-style duplicate-the-last-leaf makes distinct trees collide to the
  same root, which is a known ambiguity class (CVE-2012-2459 lineage) and is not worth
  inheriting for the sake of a tidier diagram.
- **Leaf order = acceptance order** (by the batch's internal accept counter, then by
  `seq` within a namespace). Deterministic and independently recomputable from the
  published leaf list.
- **Empty interval commits no root.** A root over zero leaves is not a meaningful
  statement, and manufacturing one would put a heartbeat-shaped artifact in the record
  that says nothing. An interval with no pins simply produces no commit — and the witness
  self-grading in section 7 is what keeps that from being indistinguishable from an
  outage.

### 3.3 Root record, and the root chain

Each sealed batch writes one root file. The root file **includes the previous root**, so
the sequence of roots is itself a hash chain — the same construction `arcaeon-ledger`
applies to rows, applied one level up:

```json
{
  "batch_id": "000000123",
  "root": "sha256:witness-merkle:v1:<hex>",
  "prev_root": "sha256:witness-merkle:v1:<hex>",
  "tree_size": 412,
  "opened_at": "2026-08-14T18:00:00Z",
  "sealed_at": "2026-08-14T18:01:00Z",
  "batch_interval_seconds": 60,
  "max_seal_lag_seconds": 300,
  "leaves_file": "batches/000000123/leaves.json",
  "namespaces": ["arcaeon-", "acme-prod"],
  "auth_level": "bearer-stage0"
}
```

`prev_root` is not optional. A Merkle root alone does not stop the witness from
publishing two different trees for the same interval to two different audiences
(equivocation / split view). Chaining the roots means an equivocating witness must fork
the chain publicly, in a public repo, where the fork is the evidence. This is the single
highest-value line in the whole design and it costs one field.

The existing daily OpenTimestamps anchor of repo HEAD covers roots automatically once
they live in the repo — `api/status.js:170`, `const entries = await store.listDir
("anchors");` and the anchor block at `api/status.js:182-195`. No anchor change is
needed, which is a genuine argument for putting roots in the same repo rather than a new
one.

### 3.4 Cadence of sealing

Seal when **any** of these fires, whichever comes first:

1. `batch_interval_seconds` elapsed since the batch opened (default proposal: 60s).
2. `max_leaves` reached (proposal: 4096 — keeps proof paths ≤ 12 hashes and leaves files
   small enough to fetch whole).
3. **A deadline forces it** — any pending leaf whose `next_pin_due_by` is within
   `seal_safety_margin` of expiring. Section 4 is why.

**IMPLEMENTED, and now CALLED.** All three live in `lib/_batch.js sealTrigger`, and
`lib/_sealer.js` is what asks it — it holds no copy of the rule and does nothing at all
when the answer is null. One addition, a carry and not a cadence: a leaf set left behind by
a seal that already failed seals on the next run regardless of the interval (trigger
`unsealed_carry_over`), because §10 T4's "next batch absorbing the unsealed leaves" must not
make those leaves wait a second interval.

---

## 4. Deadlines: the part that must not break

This is the section that decides whether batching is acceptable at all.

### 4.1 The current contract

A deadline is stamped at accept time from the witness's own clock:

- `api/pin.js:275` — `const cadenceHours = store.resolveCadenceHours(namespace);`
- `api/pin.js:276` — `const dueBy = new Date(pinnedAt.getTime() + cadenceHours * 3600_000).toISOString();`
- `api/pin.js:293` — `next_pin_due_by: dueBy,`
- `api/_store.js:164` — `const DEFAULT_CADENCE_HOURS = 24;`

and graded by a stranger against wall-clock now:

- `api/latest.js:87` — `const cadence_gradeable = Number.isFinite(dueMs);`
- `api/latest.js:92-97` — `if (now >= dueMs) { cadence_status = "overdue"; ... } else { cadence_status = "current"; }`
- `api/latest.js:144` — `out.cadence_grade = cadence_status === "current" ? "pass" : "fail";`

A missed deadline is sticky and never erased (`api/_store.js:249`, `// --- missed
deadlines: sticky, append-only, never erased ---`), and a renewal cannot launder one
(`api/_store.js:254-255`).

### 4.2 The rule: batching must not change who passes

**A batched pin is graded against its deadline using `accepted_at`, exactly as
`pinned_at` is used today.** The publisher submitted on time; the publisher passes. The
publisher does not inherit our queueing latency as a compliance failure. Anything else
would make our cost optimization show up as a customer's missed deadline, which is
indefensible.

But that alone would be a quiet overclaim in the other direction, because:

> **Until its root commits, an accepted pin is not public. The only thing backing it is
> our word — which is exactly what a witness exists to not require.**

So the accept-time grade cannot stand alone.

### 4.3 Two deadlines, two graders

| Field | Clock start | Grades | Who fails |
|---|---|---|---|
| `next_pin_due_by` | `accepted_at` | publisher cadence | the log owner |
| `inclusion_due_by` | `accepted_at + max_seal_lag_seconds` | publication latency | **the witness** |

`inclusion_due_by` is new and it grades *us*. A pin accepted and not sealed past that
deadline means the witness is failing, and `/api/latest` and `/status` must say so in
the same red the publisher gets. Without this field batching hands us an unfalsifiable
excuse — "it's batched" — that can cover an indefinite outage.

### 4.4 The pending state, and why it is `cannot_determine`

`/api/latest` gains an orthogonal field, in the same style as the three the endpoint
already keeps deliberately separate (`api/latest.js:70-74`):

```
inclusion_state: "included" | "accepted_pending_inclusion" | "inclusion_overdue"
```

and the combined `status` for naive consumers resolves to the safe side, exactly as it
already does for heartbeats and legacy records (`api/latest.js:75-77`, `` `status` stays
as the single combined verdict for naive consumers, and resolves to the SAFE side in both
new cases``).

For `accepted_pending_inclusion`, `cadence_grade` is **`cannot_determine`**, not `pass`.
The precedent is already written into this codebase for the legacy-record case
(`api/latest.js:136-142`):

> `REFUSE-SEMANTICS: ... A consumer gating on cadence MUST treat cadence_gradeable:false
> as cannot_determine and apply its own not-determined policy — it is NOT a pass.`

The reasoning transfers exactly. A record we have accepted but not published is a record
a stranger cannot check. Reporting it as `pass` would mean our API's say-so is standing
in for the public record, and the whole product is that it doesn't have to. It resolves
to `pass` the moment the root commits — typically seconds later — and the honest
intermediate state costs us almost nothing while protecting the one claim we sell.

**Consequence for sealing cadence:** because a pending pin is ungradeable, a pin whose
`next_pin_due_by` is close must be sealed before it expires. Hence trigger 3 in §3.4. A
publisher on a 24h cadence (`api/_store.js:164`) has enormous slack; a publisher on a
60-second cadence effectively forces per-interval sealing, which is correct — they are
paying for latency and should get it.

---

## 5. Proof format

**PROOF OBJECT AND VERIFIER IMPLEMENTED 2026-09-13 in `6c0bb93`; THE ENDPOINT IS NOT.**
`lib/_batch.js buildProof` mints the object below and `lib/_merkle.js verifyInclusion`
implements the algorithm in this section verbatim, including the derived path direction.
Two build notes:

- **The verifier returns a typed reason, not a boolean.** This section requires inclusion
  and publication to stay "Two separate claims, never merged into one boolean," and a
  reason string is what keeps a caller able to hold them apart. `ok` is the inclusion claim
  alone and says nothing about publication. Unknown recipe labels return
  `unknown_recipe` — they never pass with a warning.
- **`buildProof` refuses on an unsealed batch, and that refusal is the enforcement.** A pin
  cannot be handed a proof citing a root that was never published, because the mint path
  throws rather than because the ordering happens to be right. It is the property the
  failure-atom test binds to.

The endpoint is not built: `api/` is at the Vercel Hobby 12-function cap (confirmed at
`9e8b060`, where the OAuth functions had to move to their own project), so serving proofs
means an `?op=proof` mode on an existing function — the pattern `api/verify.js?op=bulk` and
`api/fulfill.js?op=prefix-available` already use — not a 13th file.

Served by a new `GET /api/proof?ns=<ns>&seq=<seq>` (no auth — pins are public by design,
same posture as `api/latest.js:3`, `// No auth: pins are public by design (that's the
point of a public witness).`).

```json
{
  "leaf": { "...the leaf_object of §3.1..." },
  "leaf_hash": "sha256:witness-leaf:v1:<hex>",
  "leaf_index": 41,
  "tree_size": 412,
  "path": ["<hex>", "<hex>", "..."],
  "root": "sha256:witness-merkle:v1:<hex>",
  "root_ref": {
    "batch_id": "000000123",
    "path": "batches/000000123/root.json",
    "commit_sha": "<git sha>",
    "commit_url": "https://github.com/<repo>/commit/<sha>",
    "sealed_at": "2026-08-14T18:01:00Z"
  },
  "leaves_url": "https://github.com/<repo>/blob/main/batches/000000123/leaves.json",
  "recipe": "sha256:witness-merkle:v1",
  "verify": "https://arcaeon.io/witness/verify"
}
```

**Path direction is derived, not encoded.** At each level, `leaf_index & 1` says whether
the sibling is on the right or the left; `leaf_index >>= 1` and `tree_size` shrinks the
same way, which also handles promoted odd nodes without a flag. Encoding an explicit
left/right array would be a second source of truth that can disagree with the index, and
a verifier that trusts the flags over the index is exploitable. Stated here because a
stranger implementing this from the JSON alone must get it right.

Verification, complete:

```
h = SHA256(0x00 || json_c14n_v1(leaf))
i = leaf_index ; n = tree_size
for sib in path:
    if i is odd or i + 1 == n:   # right child, or promoted-left pairing
        h = SHA256(0x01 || sib || h)
    else:
        h = SHA256(0x01 || h || sib)
    i >>= 1 ; n = (n + 1) >> 1
assert h == root                 # inclusion proven, OFFLINE
```

Two separate claims, never merged into one boolean:

1. **Inclusion** — the leaf is in the tree with that root. Pure computation, offline, no
   network, no trust in us.
2. **Publication** — that root is in a public commit. Requires fetching
   `root_ref.commit_url` or the file from the repo. This one can be `unavailable`.

The client must report these separately, the way `verify_artefact` refuses to collapse
"could not re-fetch" into a verdict (`arcaeon_ledger/artefact.py`, the
`match`/`mismatch`/`unavailable` semantics). "Inclusion proven, publication unverified"
is a real and honest state, and it is the state a client is in when GitHub is down.

**The recipe strings are load-bearing.** `sha256:witness-leaf:v1` and
`sha256:witness-merkle:v1` follow the ledger's self-describing digest discipline, and
they interlock with `arcaeon-ledger` 0.5.2: a client that meets a recipe label it cannot
reproduce must fail with a typed reason (`unknown_recipe` / `unknown_recipe_version`),
never pass with a warning. Register both in the client's supported table on the same day
the server starts minting them, and never mint a label the shipped client cannot verify.

---

## 6. Conflict observations under batching

This is where batching can silently *weaken* a real security property, so it gets its own
decisions rather than a shrug.

### 6.1 The window batching opens

The same-rows/different-chain guard reads committed state:

- `api/pin.js:150-151` — `const latestPath = 'pins/${namespace}/latest.json';` /
  `const cur = await store.getFile(latestPath);`
- `api/pin.js:186-187` — `if (cur && Number.isInteger(cur.json.rows) && rows === cur.json.rows) { if (chain.toLowerCase() === String(cur.json.chain).toLowerCase()) {`

If `latest.json` is only written at seal time, then between accept and seal `cur` is
**stale**, and two conflicting same-rows/different-chain submissions could both be
accepted — the exact re-mint signature the guard exists to catch, walked straight through
the front door by our own optimization.

**Decision: the guard compares against pending state, not just committed state.** The
batch builder keeps a pending head per namespace, and the comparison uses the later of
(committed `latest.json`, pending head). This is not a new class of dependency: the pin
path already requires a durable non-GitHub store on every request —

- `api/pin.js:80` — `m = await meter.check(key);`
- `api/pin.js:98` (credit path) — `c = await balance.decrementCredit(key, ...)`

so pending-head state lives in the same store those use.

**Decision: if the pending-head store is unavailable, refuse the pin.** 502, matching
`api/pin.js:320` and the fail-closed stance of the `no_cap_configured` branch
(`api/pin.js:137-144`). Accepting a pin we cannot conflict-check is worse than not
accepting it, because it enters the record looking checked.

**IMPLEMENTED 2026-09-13 as the pending head + the SEALER-SIDE refusal; the pin-side 502 is
NOT built, deliberately.** `lib/_pending.js` holds the pending head per namespace and
refuses a conflicting leaf into the tree before it can reach §6.3's re-check, which is what
finally makes that re-check a backstop rather than the only guard. `lib/_sealer.js` fails
closed on the read: a sealer that cannot read the pending head refuses, writes nothing, and
reports `pending_head_unreadable` — never `no_open_batch`, because "I cannot see it" and
"there is nothing there" are different answers and collapsing them is the fail-open bug
this paragraph exists to prevent.

What is not built is the 502 on the pin path, and the reason is that **the window this
section describes is not open in Phase 1.** The window's premise is its own first sentence:
"If `latest.json` is only written at seal time, then between accept and seal `cur` is
stale." In Phase 1 `latest.json` is still written per pin (`api/pin.js`, the content-advance
path's second `store.putFile`), so `cur` is committed, fresh, and exactly as authoritative
as it is today. Adding a new 502 class to a live money path to defend a window that only
**Phase 4** opens ("the `latest.json` write joins the batch") would be paying a real
availability cost for a hypothetical one. The 502 lands with Phase 4, in the same change
that makes the pending head load-bearing for the accept decision. Until then the accept-time
guard is the committed read it has always been, and the pending head guards entry into the
tree.

The residual, stated rather than discovered: `api/pin.js`'s accumulation hook cannot fail a
pin, so a pending-store outage drops leaves silently from the operator's side. That is
survivable only because Phase 1 has an auditor by construction — "every batch root must be
recomputable from the individually-committed pins" is precisely the check that catches a
dropped leaf, and it is the reason Phase 1 runs for a week before anything reads a root.

### 6.2 Observations are never batched

**Decision: observation writes stay immediate and unbatched** — `api/pin.js:264` behavior
preserved exactly, one commit, right now, plus the 409 at `api/pin.js:266-270`.

An observation is the record of a *detected attack in progress*. It is the one write in
this system with a live adversary attached, and delaying its publication to save an API
call is optimizing the wrong variable. The cost is bounded by construction: an
observation requires a same-rows-different-chain submission from a validly-authorized
key, which is rare and, if it ever becomes not-rare, is itself the alarm.

The status page counts observations from the repo tree — `api/status.js:146`,
`const tree = await store.getTree();` and `api/status.js:148`,
`.filter((t) => t.type === "blob" && t.path.startsWith("observations/") && ...)` — so
keeping observations unbatched also means that count keeps working with no change.

### 6.3 Same-batch conflicts

**IMPLEMENTED 2026-09-13 in `6c0bb93`** — `lib/_batch.js findSameBatchConflicts` and the
re-check at the top of `sealBatch`, which runs *before* the tree is built. The LATER leaf is
the one dropped, never the earlier: `api/pin.js:183-184`'s rule is that a conflict "never
advances accepted state," so accepted state is whichever leaf arrived first and the
challenger is the one that must not ride into a root. The observation write goes out
immediately and unbatched, through the same `store.putFile` the 409 retry governs.

**It is now a backstop, as designed (2026-09-13).** §6.1's pending-head store is built and
sits in front of it, so the re-check is no longer the only guard. It is not redundant and
will not become so: the pending head lives on the GitHub contents API, which does not give
read-your-writes across instances (§11 Q2 below), so a second instance reading a stale
pending document can still admit a conflicting leaf. That is exactly the "store outage or a
race" this section names, and it is a live shape rather than a courtesy — `test/sealer.test.js`
seats two conflicting leaves in one pending document and proves the seal-time re-check still
drops the later one and writes the observation.

Even with §6.1, a store outage or a race could land two conflicting leaves in one batch.
**Decision: the sealer re-checks.** Before sealing, scan the batch for duplicate
`(namespace, rows)` leaves with differing `chain`. On a hit: drop the later leaf from the
tree, write an observation immediately, and seal. A conflict discovered at seal time is
still a detection, and it must not be able to ride into a root as though it were accepted
state — `api/pin.js:183-184` is explicit that a conflict `never advances accepted state`.

---

## 7. Grading ourselves

Batching moves a promise from the publisher onto us, so our promise gets the same public
treatment theirs gets. `resolveCadenceHours` (`api/_store.js:166`) makes a namespace's
cadence a published, stranger-checkable number; `batch_interval_seconds` and
`max_seal_lag_seconds` become ours — published in every root file (§3.3) and on `/status`.

The status page already computes a red overall state from overdue namespaces
(`api/status.js:203`, `const overdueCount = rows.filter((r) => r.status === "overdue").length;`
and `api/status.js:213-215`, the `degraded` / `overallOk` computation). Add:

- count of pins **accepted but not yet included**;
- count of pins **past `inclusion_due_by`** — which must feed `degraded` exactly as
  `overdueCount` does;
- **actual** median and max seal lag over the last 24h, next to the promised
  `max_seal_lag_seconds`.

Without this, "quietly grow the batch interval to cut costs" is an invisible degradation
of everyone's product. With it, it is a public number that moves.

---

## 8. What the client library needs

`arcaeon-ledger` is the reference client. Current relevant behavior:

- `arcaeon_ledger/witness.py:155` — `pin = store.latest(namespace)`
- `arcaeon_ledger/witness.py:160-161` — `w_rows = pin.get("rows")` / `w_chain = pin.get("chain")`
- `arcaeon_ledger/witness.py:169-188` — the `truncated` / `rewritten` comparisons
- `arcaeon_ledger/witness.py:61-63` — `__bool__` returns true **only** for `"consistent"`
- `arcaeon_ledger/witness.py:140-141` — `store` is any object with a
  `record(namespace, head, received_at=)` method — "the reference `WitnessStore`, or a
  client wrapper that POSTs to a hosted one"

Three consequences:

1. **Batching is backward compatible with today's clients.** `verify_against_witness`
   reads only `rows` and `chain` off the pin (`witness.py:160-161`), so extra fields —
   `inclusion_state`, `batch_id`, proof references — are ignored by existing installs. No
   forced client upgrade. That is worth protecting deliberately: do not rename `rows` or
   `chain` in the served record, ever.
2. **New verdicts are falsy for free.** `WitnessVerdict.__bool__` is true only for
   `"consistent"` (`witness.py:61-63`), so adding `pending_inclusion` and
   `inclusion_unproven` cannot accidentally read as success in any `if verdict:` written
   against the current library.
3. **The hosted client is a duck-typed wrapper**, which the docstring at
   `witness.py:140-141` already anticipates. It implements `record()` and `latest()`, and
   gains proof handling.

New client surface:

```python
verify_inclusion(proof) -> InclusionResult    # OFFLINE, stdlib only, no network
verify_root_published(proof) -> "match" | "mismatch" | "unavailable"   # network
```

- `verify_inclusion` must be pure and dependency-free. If proving inclusion requires
  calling us, the proof is not a proof.
- The leaf hash is recomputed with the ledger's own `digest_json` — no new canonicalizer.
- Unknown `recipe` labels fail typed, per 0.5.2, rather than passing with a note.
- **The client must persist the proof** next to its own log. A proof it did not keep is a
  proof it has to ask us for, which reintroduces exactly the dependency it exists to
  remove. `publish_head` should return the proof (or a pending handle) and the docs should
  say plainly: store it.
- Pending handling: a pin accepted but not yet sealed returns a handle the client can
  redeem later. Silent polling that blocks `publish_head` would be worse — it turns a
  fast accept into a slow one and hides the pending state the design just went to trouble
  to make visible.

---

## 9. Migration path

Nothing is ever rewritten, so every phase is reversible and no phase needs a data
migration. That is the property that makes this safe to do incrementally.

**Phase 0 — today.** Per-pin, two commits (`api/pin.js:303-307`).

**Phase 1 — shadow trees. LIBRARY AND CALLER BUILT 2026-09-13; THE SHADOW RUN HAS NOT
STARTED.** Everything needed to build a batch, accumulate into it, and commit a root exists
and is tested — including the caller (`lib/_pending.js`, `lib/_sealer.js`,
`tools/seal_batch.js`) whose absence was the gap through `6c0bb93`. What has not happened is
the run: the week of reconciliation this phase is *for*. The correctness proof this phase
names — "every batch root must be recomputable from the individually-committed pins" — is
proven in the harness against fixtures, not yet against a week of live pins, and those are
different claims.

**To start it** (deliberately, not as a deploy side effect):

1. Set `WITNESS_BATCH_SHADOW=on` in the Vercel project. Every accepted pin — advance and
   heartbeat both, §11 Q4 — then appends its leaf to the open batch in the private usage
   repo. The pin's own two commits are unchanged, and a pending-store failure cannot fail a
   pin.
2. Schedule the sealer at or below `batch_interval_seconds` from a scheduler this repo does
   not host (§11 Q3):
   ```
   GITHUB_PIN_TOKEN=...  GITHUB_PIN_REPO=dan8433-user/arcaeon-witness-pins \
   GITHUB_USAGE_REPO=dan8433-user/arcaeon-witness-usage \
   node tools/seal_batch.js
   ```
   Exit 0 = sealed or a legitimate no-op; **1 = refused, nothing written** (fail-closed
   fired — alert on this); 2 = the seal failed after the close, no root published, leaves
   held for the next run.
3. Reconcile daily for a week: every leaf in every `batches/*/leaves.json` must match a
   committed record under `pins/`, and every committed record in the interval must appear in
   exactly one leaf list.

Rollback is the same switch: unset `WITNESS_BATCH_SHADOW`, stop running the command. Roots
already committed stay valid.

Keep per-pin commits exactly as they are. Additionally build
batches and commit roots. Nothing reads the roots. This is the correctness proof: every
batch root must be recomputable from the individually-committed pins, which is only
checkable while both exist. Run it until a full week reconciles clean.

**Phase 2 — proofs served, per-pin commits still on.** Ship `GET /api/proof`, ship the
client verifier, add `inclusion_state` and `inclusion_due_by` to `/api/latest` (always
`"included"` in this phase, since per-pin commits still land immediately). Clients that
upgrade gain verification; clients that don't are unaffected.

**Phase 3 — batched by default for new namespaces.** Per-pin immediate commit becomes an
opt-in tier. This is where the pricing lane is: *immediate publication* versus *batched
publication* is a real, honest, explainable product difference — the customer is buying
the gap between accept and public, which is the security parameter this witness has always
said is the one that matters. Do not describe the batched tier as "the same but cheaper."

**Phase 4 — batched by default everywhere, and the `latest.json` write joins the batch.**
Note that Phase 3 alone does **not** get the win: `api/pin.js:307` writes
`pins/${ns}/latest.json` per pin, so that single write keeps cost at O(N). It has to
become one batched write — a `heads.json` covering every namespace touched in the batch
— for total batch cost to be a small constant.

That change has a read-path consequence and it must be handled, not discovered:
`api/latest.js:27` reads `const path = 'pins/${ns}/latest.json';`, with a raw-CDN fallback
at `api/latest.js:45` whose staleness is already documented (`api/latest.js:5`,
`// fallback is raw.githubusercontent with a cache-busting query — measured in`). Keep
writing per-namespace `latest.json` files as a **derived** convenience during a deprecation
window so old readers and the fallback path keep working, then retire them once
`heads.json` is the documented read.

**Rollback, any phase:** stop batching, resume per-pin. Roots already committed remain
valid forever — they are append-only files describing intervals that really happened, and
proofs against them keep verifying. Nothing has to be undone.

---

## 10. Named tradeoffs

**T1 — Inclusion latency versus the rate ceiling.** The direct trade. Write cost drops
from O(2N) (`api/pin.js:303-307`, `api/_store.js:39`) to a constant per interval; in
exchange every pin waits up to `batch_interval_seconds + seal time` to become public. The
security parameter this system has always named — the gap an attacker gets to pick —
grows by exactly that amount. It is bounded, published, and gradeable (§4.3, §7), which
is the most that can honestly be claimed for it. It is not free.

**T2 — A pin is not public until its root commits.** During that window the only evidence
is our API's word. A signed acceptance receipt would *narrow* this (it converts "we can
silently drop it" into "we can be caught lying about having accepted it") but does not
close it: a receipt signed by us is still us. Named, not solved. `inclusion_due_by` (§4.3)
and the `cannot_determine` grade (§4.4) are the mitigations, and they are honest about
being visibility rather than proof — the same distinction `api/latest.js:66-68` already
draws for the cadence alarm.

**T3 — Proof custody shifts work to the client.** A proof is ~12 hashes, trivially small,
but the client has to keep it. A lost proof means asking us again, which is the dependency
the proof exists to remove. Mitigation: publish the full `leaves.json` per batch (§3.3) so
any proof is recomputable from public data by anyone, forever, with us gone. That costs
repo size — meaningfully, at high volume — and it is worth it. Independence from us is the
product; a repo that grows is an operational problem, and trading a product property for an
operational convenience is the wrong direction.

**T4 — Batch atomicity.** If a seal fails, N pins are accepted and unpublished at once.
Per-pin commits fail one pin at a time; batching correlates the failures. Mitigation:
bounded retry with the next batch absorbing the unsealed leaves, and `inclusion_due_by`
making the backlog visible rather than silent. Correlated failure is a genuine cost of
batching and no amount of retry logic makes it not one.

**T5 — Interval dilution.** Nothing in the mechanism stops us from quietly growing
`batch_interval_seconds` to cut cost, degrading every customer invisibly. Fence: publish
it in every root, publish promised-versus-actual seal lag on `/status` (§7). Our cadence
becomes stranger-gradeable, exactly as `resolveCadenceHours` (`api/_store.js:166`) made
the publisher's.

**T6 — Equivocation.** A root alone does not prevent two trees for one interval shown to
two audiences. `prev_root` chaining (§3.3) forces a public fork; the daily OTS anchor
(`api/status.js:170`, `api/status.js:182-195`) timestamps the chain. This does not make
equivocation impossible — it makes it *evidence*, which is the same standard the rest of
this system holds itself to.

**T7 — Complexity as a trust cost.** Per-pin commits are checkable by a stranger with a
browser: open the repo, read the file. Merkle proofs need a verifier implementation, and
"trust me, the math works" is a worse sales position than "click here and look." Partial
mitigation: keep `leaves.json` public and human-readable (T3), publish the verification
algorithm in full (§5), and ship the verifier in the client library rather than as a
hosted endpoint. But a stranger's cost of checking genuinely goes up, and that is a real
loss that should be weighed rather than waved at. **If pin volume never approaches the
ceiling, the honest answer is not to build this.** Batching should ship when the ceiling
is measured and near, not because it is the more interesting design.

---

## 11. Open questions

1. **Actual GitHub write ceiling. MEASURED 2026-09-13 — closed** (numbers and method in
   §1, probe in `tools/ceiling_probe.js`). Summary: ~95 sequential writes/min on one
   branch, insensitive to payload size up to 4 KB; the secondary limit is a
   seconds-refilling burst allowance (429, no `Retry-After`, ~16 s recovery) that only
   concurrency trips — and concurrency is worthless here anyway, because ten writers on
   one branch spent their requests on 409 ref-contention and moved *less* data than one
   sequential writer. Re-measure before relying on it again: GitHub publishes none of this
   and can change it silently. **The standing rule survives the measurement** — no
   customer-facing pins-per-hour figure without a dated measurement, and the date is the
   load-bearing half of that sentence.
2. **Where pending state lives. DECIDED 2026-09-13, and the question's own premise was
   wrong.** The answer is reuse: `lib/_pending.js` writes `pending/open_batch.json` into the
   same private repo the meter and balance use. But §6.1 called that "a durable non-GitHub
   store," and it is not one — `lib/_meter.js:22-24` ("Storage: one JSON file per key-hash
   per month, in a PRIVATE GitHub repo") and `lib/_balance.js:64`
   (`const USAGE_REPO = process.env.GITHUB_USAGE_REPO || ...`) are both the GitHub contents
   API. So "reuse the store the meter uses" and "use a durable non-GitHub store" were never
   the same instruction, and only the first is available without adding a dependency this
   repo does not have.

   The consequence this question asked about is real and is **not** satisfied: the contents
   API does not give read-your-writes across instances (`api/pin.js` carries the scar —
   `// A wedge the proactive check missed (contents-API read lag)`). So the pending head is a
   strong first guard, not a perfect one, and §6.3's seal-time re-check is what makes that
   survivable rather than a hole. A store with a real atomic primitive (Vercel KV / Upstash,
   the same Stage-2 fix `lib/_meter.js` already names for its own CAS loop) would close it;
   until then the honest statement is *first guard plus backstop*, not *guaranteed*.
3. **Who runs the sealer. DECIDED 2026-09-13: an operator command, `tools/seal_batch.js`,
   driven by a scheduler outside this repo.** Not a scheduled function: `api/` is at the
   Vercel Hobby 12-function cap (`9e8b060`, "the witness app is at the Hobby cap of 12
   functions and the deploy with 14 was refused"), so a scheduled function is a 13th file and
   is not available. Not opportunistic sealing either — this question's own parenthesis
   refuses it ("starves a quiet witness").

   That left a mode on an existing entry point, or a command, and it is the command. A seal
   spends a write against the *public* pin repo, so a seal mode on a public endpoint needs a
   new operator-auth surface designed and defended before the first seal ships; a command
   needs none, because running it already requires the `GITHUB_PIN_TOKEN` the seal spends.
   And Phase 1 is a watched run with a start date, not a background daemon: the smallest
   thing a stranger cannot trigger, and that stops the moment the operator stops running it,
   is the right shape for it. `tools/` is not routed as functions — `tools/ceiling_probe.js`
   sat there across the deploy that was capped at 12, which is the evidence rather than the
   assumption. The operator command and its exit codes are in §9 Phase 1.

   **Not checked:** whether Vercel's own cron would serve a 60-second interval on the Hobby
   plan. It is moot — the cron would still need the 13th function — but it is stated rather
   than implied, because the argument above rests on the function cap and on the auth
   surface, not on a cron-frequency limit nobody here measured.
4. **Do heartbeats need to be in the tree at all? DECIDED 2026-09-13: they stay in.** The
   conservative call, which is this question's own reading of it, and §3.1 assumes it.
   The deciding reason is §3.1's on `record_kind` — "a proof that omits it would let a
   heartbeat be presented as an advance" — read the other way round: the leaf already carries
   the distinction, so including heartbeats costs a leaf and no ambiguity, while excluding
   them would make the published `leaves.json` an incomplete account of what the witness
   accepted in that interval. T3 sells `leaves.json` as the thing that makes a proof
   recomputable "by anyone, forever, with us gone"; a leaf list that silently omits a class
   of accepted record is not that. The leaf-volume saving for idle namespaces is real and is
   the price.
