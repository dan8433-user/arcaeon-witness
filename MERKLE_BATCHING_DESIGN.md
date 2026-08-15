# Merkle batching for the Arcaeon hosted witness — design

**Status: DESIGN ONLY. Nothing here is implemented.** Written 2026-08-14 against the
working tree at that date. This document proposes batching N pins into a Merkle tree,
committing only the root per interval, and serving per-pin inclusion proofs.

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

**Note on the exact GitHub numbers.** We have not measured GitHub's secondary rate limits
for sustained contents-API writes to one branch, and the published primary limit is not
the binding constraint for write bursts. Do not put a specific pins-per-hour figure in
customer-facing material until it has been measured on the real token. The *shape* of the
win (O(N) → O(1)) does not depend on that measurement; any specific ceiling claim does.

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

**Phase 1 — shadow trees.** Keep per-pin commits exactly as they are. Additionally build
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

1. **Actual GitHub write ceiling.** Unmeasured (§1). Measure before committing to a batch
   interval, and before any customer-facing throughput claim.
2. **Where pending state lives.** The meter and balance stores are already required per
   request (`api/pin.js:80`, `api/pin.js:98`); reuse is the obvious answer, but the
   consistency guarantees of that store need checking against §6.1, which needs
   read-your-writes across instances to be correct.
3. **Who runs the sealer.** A serverless request cannot reliably close a batch it did not
   open. Options: scheduled function, an external cron poking a seal endpoint, or
   opportunistic sealing on the next inbound pin (which starves a quiet witness — a batch
   with no following pin would never seal, and that is the failure mode `inclusion_due_by`
   would catch loudly and repeatedly). Leaning scheduled.
4. **Do heartbeats need to be in the tree at all?** They are cheap and they are records,
   but a heartbeat's whole content is "nothing changed." Keeping them in is the
   conservative call and §3.1 assumes it; excluding them would cut leaf volume
   significantly for idle namespaces. Wants a decision before Phase 1, not after.
