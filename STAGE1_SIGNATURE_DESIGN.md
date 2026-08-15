# Stage-1 owner-signature auth for the Arcaeon hosted witness — design

**Status: DESIGN ONLY. Nothing here is implemented.** Written 2026-08-14 against the
working tree at that date. This document proposes per-namespace owner signatures over
witness writes, a dual-signature conflict receipt, and the rotation/revocation machinery
that has to exist before either is honest.

It exists because the code shipped tonight documents its own gap loudly and repeatedly —
`auth_level:"bearer-stage0"` on every write, every stored record, every read — and a gap
named that many times in public is a debt, not a disclaimer.

**Citation rule.** Every claim about *current* behavior cites the file and line it was
read from and quotes enough of the line to survive renumbering. Anything without a
citation is a proposal, not a description.

**Citations are against the working tree as of 2026-08-14, which carried uncommitted
changes to `api/_store.js`, `api/latest.js`, `api/status.js` and two new files
(`api/verify.js`, `api/_status_data.js`).** `api/_store.js` was 408 lines at the time of
writing; the `computeCadenceFields` extraction pushed everything after line 300. Match on
quoted anchor text, not on line numbers.

**Prior art in this repo this design deliberately reuses rather than reinvents:** the
refuse-to-grade trichotomy owed to **atomic-raven** (`cadence_gradeable` /
`cadence_grade:"cannot_determine"`), the retain-the-miss and type-the-record invariants
owed to **excelsior**, and `arcaeon-ledger`'s frozen `json-c14n:v1` canonicalization. The
schema in §3 is excelsior's, from the Colony thread on the hosted-witness post.

---

## 0. TL;DR for a reviewer with five minutes

1. Per-namespace **Ed25519** keypair, owner holds the private half. Public half binds via
   a signed registration that lands as a commit in the public pin repo.
2. **The first binding is trust-on-first-use and we say so in those words.** Today the
   bearer key is the only proof of ownership that exists, so the bearer key is the only
   thing that can authorize a first binding. TOFU converts a *permanent* bearer
   vulnerability into a *one-time, publicly timestamped* one. It does not eliminate it.
3. Writes carry a detached signature over a canonicalized envelope that includes
   `prev_seq` + `prev_record_digest`. **That chain-position binding, not the timestamp,
   is the real replay defense** — and it is what actually closes the leaked-key liveness
   gap on renewals.
4. Conflict receipts get **two different signatures from two different roles**: the
   candidate's (or an affirmative record of its absence) and the witness's, over an
   envelope the witness signs.
5. Bearer keys survive as **metering and rate identity only**. They stop answering "who
   owns this namespace" and keep answering "who pays for this call."
6. Stage-0 records are **never re-stamped**. There is one concrete code bug that would
   retroactively upgrade them the day the constant flips (§7.1) and it must be fixed
   before anything else here is built.
7. Stage-1 proves **key custody, not intent**. A compromised owner machine signs happily.

---

## 1. What is actually true today

The whole write path is bearer-key auth and nothing else.

- `api/pin.js:42-43` — `const auth = req.headers.authorization || "";` /
  `const key = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";`
- `api/pin.js:44` — `const prefix = key ? store.keyPrefixFor(key) : null;`
- `api/pin.js:67-71` — `if (!namespace.startsWith(prefix)) { return res.status(403)...`
- `api/_store.js:130-140` — `function keyPrefixFor(bearerKey)`, a linear scan of the
  `WITNESS_KEYS` env var for an exact string match: `if (key && key === bearerKey) return prefix;`

That is the complete ownership check. String equality against an env var, then a prefix
test. `api/_store.js:111-113` says so in its own comment: `// ---- auth: WITNESS_KEYS =
comma-separated "key:namespace-prefix" pairs ----` / `// A key may only pin namespaces
starting with its prefix.`

The weakness is stamped into the record rather than left to be discovered:

- `api/_store.js:119` — `const AUTH_LEVEL = "bearer-stage0";`
- `api/_store.js:121-123` — `"Bearer-key auth only. This is NOT owner-signature auth: the
  witness verifies " + "that the caller holds a key bound to this namespace prefix, not
  that the log's " + "owner authorized this record. Anyone who obtains the key can pin or
  renew. "`
- Stamped on both write paths: `api/pin.js:226-227` (renewal record) and
  `api/pin.js:298-299` (content advance), and echoed in both responses at
  `api/pin.js:249-250` and `api/pin.js:313-314`.
- Surfaced on reads: `api/_store.js:382-383` — `out.auth_level = (pin && pin.auth_level) || AUTH_LEVEL;`
- And on the public page: `api/status.js:260` — `Owner-signature auth is the Stage-1
  requirement and is <strong>not built yet</strong>`.

`README.md:290-292` states the consequence in the sharpest available terms:

> Renewal is the write where this matters most: a leaked bearer key can keep a
> namespace looking alive indefinitely without the owner's involvement. That is a
> real, currently-unclosed gap in Stage-0, named here rather than papered over.

And `PRACTICES.md:129-131` repeats it as a commitment: *"Renewal is authorized by a
**bearer key only** (`auth_level:"bearer-stage0"`): it proves a key-holder was
responsive, not that the log's owner authorized anything."*

`README.md:293-296` makes a promise this design has to keep:

> When Stage-1 lands, `auth_level` becomes `"owner-signature"` on records that carry
> one, and the two will be distinguishable in the public repo record-by-record —
> including retroactively, because every record written before then says
> `bearer-stage0` in its own text.

§7.1 is where that promise nearly breaks on a single line of existing code.

### 1.1 What Stage-1 must not change

Same discipline as the Merkle design doc. These are load-bearing and survive intact:

1. **Fingerprints only, never log content.** `api/_store.js:6-7` — `// rewrite of history
   is visible. Pins hold fingerprints` / `// ONLY ({namespace, rows, chain, pinned_at}) —
   never log content.` A signature is a fingerprint of an assertion, not content. The
   envelope in §2 adds no field derived from the publisher's log rows.
2. **The monotonic guard.** `api/pin.js:175` — `error: "monotonic violation: a witness
   never goes backward"`.
3. **The conflict path never advances accepted state.** `api/pin.js:264-265` — the write
   to `observations/${namespace}/${obsName}.json`, and `api/pin.js:266-270` returning 409
   with the observation path.
4. **Fail-closed.** `api/pin.js:60-65` (unknown intent is a 400, never a silent
   fallthrough), `api/pin.js:137-144` (`no_cap_configured` denies rather than assuming
   unlimited), `api/pin.js:320` (`pin store error` → 502).
5. **Refuse-to-grade beats grade-optimistically.** `api/_store.js:311` — `const
   cadence_gradeable = Number.isFinite(dueMs);` and the `cannot_determine` class it
   feeds. §7.2 clones this pattern for auth rather than inventing a second one.
6. **A renewal can never be laundered into an advance.** `api/pin.js:162-170`
   (`renewal_head_mismatch`), `api/pin.js:218` (`record_kind: "publisher_heartbeat"`).
   Signing does not get to blur this; a signed renewal is still a renewal.

---

## 2. Key model and registration

### 2.1 The keypair

**Ed25519.** One keypair per namespace, private half held by the owner, never transmitted.

Chosen over ECDSA/P-256 and RSA for reasons that matter at this scale: deterministic
signatures (no nonce-reuse catastrophe, and a bad RNG on an agent's box is a realistic
threat), 32-byte public keys and 64-byte signatures (small enough to inline in every pin
record without bloating a repo that pays per commit), one canonical implementation shape,
and no curve/hash/encoding negotiation surface. Ed25519 as specified in RFC 8032, pure
(not prehashed), no context string at the crypto layer — domain separation is done in the
message itself (§2.4) where it is inspectable by anyone reading the record.

**Key id.** `key_id = "ed25519:" + hex(sha256(raw_32_byte_public_key))`, lowercase, full
64 hex chars. Not truncated. Truncation buys a shorter string and sells a collision
argument, and this is a document whose whole job is not having arguments like that.

Public keys are published as raw 32 bytes, base64url-unpadded, in a JSON record. No PEM,
no DER, no SPKI wrapper — one encoding, so an offline verifier in any language does
`base64url_decode` and hands 32 bytes to its Ed25519 library.

### 2.2 The binding record

A binding lands in the **public pin repo** at `keys/<namespace>/<key_id>.json`, with
`keys/<namespace>/current.json` as the pointer to the active one. Both are commits, which
means both inherit everything the pin store already gets for free: GitHub's third-party
timestamp, public readability, visible-on-rewrite history, and coverage by the daily
OpenTimestamps anchor of repo HEAD (`README.md:327-337`).

```json
{
  "schema": "arcaeon-witness/key-binding-v1",
  "namespace": "velouria-myledger",
  "key_id": "ed25519:<64 hex>",
  "public_key": "<base64url-unpadded 32 bytes>",
  "alg": "ed25519",
  "bound_at": "2026-08-20T04:11:07Z",
  "binding_authority": "bearer-tofu",
  "binding_authority_note": "Authorized by the namespace's bearer key. At binding time the bearer key was the ONLY proof of ownership this witness had. See STAGE1_SIGNATURE_DESIGN.md §2.3.",
  "bearer_key_hash": "sha256:<hex of the authorizing bearer key>",
  "require_owner_signature": true,
  "recovery_key_id": "ed25519:<64 hex>",
  "recovery_public_key": "<base64url-unpadded 32 bytes>",
  "proof_of_possession": {
    "alg": "ed25519",
    "key_id": "ed25519:<64 hex>",
    "sig": "<base64url-unpadded 64 bytes>"
  },
  "witness_sig": {
    "alg": "ed25519",
    "key_id": "ed25519:<witness key id>",
    "sig": "<base64url-unpadded 64 bytes>"
  }
}
```

`proof_of_possession` is the new key signing the binding record itself (all fields except
`proof_of_possession` and `witness_sig`, canonicalized, domain-tagged
`arcaeon-witness/key-binding-v1`). It proves the submitter holds the private half. Without
it, a caller could bind someone else's published public key to their own namespace and
create a record that reads like that person endorsed it.

`witness_sig` is the witness attesting *when it accepted the binding and under what
authority*. It is not an ownership claim; it is a timestamped receipt for the TOFU event.

`binding_authority` is an enum, and it is the honest field: `"bearer-tofu"` (§2.3),
`"issued-with-key"` (§2.5), `"owner-rotation"` (§6.1), `"operator-recovery"` (§6.3).

### 2.3 The sharp edge: first-binding is trust-on-first-use, and we say the words

**This is the paragraph the whole document is organized around, so it goes in the record
verbatim rather than in a footnote:**

> **TOFU honesty note.** At Stage-1 there is exactly one thing this witness knows about
> who owns a namespace: whoever holds the bearer key. That is the entire ownership story
> today — `api/_store.js:130-140`, a string comparison against an environment variable.
> So the first key binding for an existing namespace can only be authorized by the bearer
> key, which means **whoever holds the bearer key at binding time can bind their own
> public key and become the owner of record.** If that key already leaked, Stage-1 hands
> the leak-holder a permanent credential instead of a temporary one. This is
> trust-on-first-use, the same bargain SSH makes with host keys, and it is a real
> unclosed gap — the same gap Stage-0 has, relocated to a single moment rather than
> repeated on every write. We are not claiming the binding proves ownership. We are
> claiming the binding is *public, timestamped, one-time, and irreversible without the
> owner's key*, which is strictly better than a credential that grants the same power
> every day forever. A namespace whose bearer key was compromised before its binding
> event is compromised at Stage-1 too, and no amount of signing fixes that after the
> fact.

What TOFU buys, stated precisely so it is not oversold:

- **The window shrinks from "always" to "once."** Post-binding, the bearer key can no
  longer authorize a rebinding (§6). Its blast radius drops from "can impersonate the
  owner indefinitely" to "could have impersonated the owner at one specific commit."
- **The event is visible.** The binding is a commit in a public repo, covered by the OTS
  anchor. An owner who watches `keys/<ns>/` sees a hijack. Under Stage-0 there is nothing
  to watch — a leaked key produces writes indistinguishable from legitimate ones.
- **The hijack is attributable.** `bearer_key_hash` records *which* key authorized the
  binding, so a compromise investigation has a starting point.

What it does not buy: anything at all, if the key leaked first. Say that in the README
when this ships.

**Optional hardening, offered but not defaulted:**

- **Announcement window.** `binding_pending_until = bound_at + N hours`; the binding
  commits immediately (so it is visible) but does not take enforcement effect until the
  window closes, giving a watching owner time to object. Default OFF: it adds latency to
  every new customer's first hour and helps only owners who are already monitoring. Opt-in
  per namespace at key-issuance time.
- **Out-of-band countersignature.** For a namespace that maps to a domain, a DNS TXT
  record or a `.well-known` file under the owner's own control, checked once at binding.
  This genuinely defeats TOFU — it uses a second, independent channel. It is also manual
  at our scale, so it is offered for high-assurance namespaces and not required.
- **Second-witness cross-binding.** Bind the same key at an independent witness and
  reference the other binding's URL. Two TOFU events at two operators are harder to
  hijack than one. Consistent with what `README.md:324-325` already tells people to do
  for anchoring: *"if you need stronger anchoring, cross-pin to a second witness."*

### 2.4 Registration flow

**`POST /api/register-key`** — a new endpoint, bearer-authorized, metered like a pin
(it costs commits).

Request:

```json
{
  "namespace": "velouria-myledger",
  "public_key": "<base64url-unpadded 32 bytes>",
  "alg": "ed25519",
  "recovery_public_key": "<base64url-unpadded 32 bytes>",
  "require_owner_signature": true,
  "proof_of_possession": { "alg": "ed25519", "key_id": "...", "sig": "..." }
}
```

Server steps, in order, each failing closed:

1. Bearer key valid and its prefix covers the namespace — reuse `store.keyPrefixFor`
   (`api/_store.js:130`) and the existing prefix test (`api/pin.js:67-71`) unchanged.
2. Namespace matches `NS_RE` (`api/_store.js:143` — `const NS_RE = /^[a-z0-9-]{1,64}$/;`).
3. Public key decodes to exactly 32 bytes; is not the all-zero key; is not a known
   small-order point (the standard Ed25519 rejection list).
4. `proof_of_possession` verifies against the submitted public key over the
   canonicalized binding record.
5. **`keys/<ns>/current.json` does not already exist.** If it does → `409
   namespace_already_bound`, with the existing `key_id` in the body and a pointer to §6.
   *There is no bearer-authorized overwrite. Ever.* This single rule is what makes TOFU a
   one-time window instead of a permanent one, and it is the highest-value invariant in
   this document.
6. Metering: `meter.check(key)` then the credit path, exactly as `api/pin.js:80-146` does.
   A binding is two commits like a pin and is billed like one.
7. Write `keys/<ns>/<key_id>.json`, then `keys/<ns>/current.json`. Two commits, same
   non-atomicity as pins (`README.md:367-369`), same self-healing property: the
   `current.json` write is the one that makes a binding effective, so a crash between
   them leaves an orphan key record that is *inert*, not half-active. That ordering is
   deliberate and is the safe direction.

Response `201` returns the stored binding, the commit sha, and the public URL — same
shape as a pin (`api/pin.js:310-318`).

**Domain-separated signing input**, used everywhere in this document:

```
sig_input = "<domain-tag>" + "\n" + json_c14n_v1(<envelope object>)
signature = Ed25519_sign(private_key, utf8(sig_input))
```

Domain tags are literal strings, one per envelope type:

| tag | signed by | §
|---|---|---|
| `arcaeon-witness/key-binding-v1` | new owner key (PoP) | 2.4 |
| `arcaeon-witness/pin-v1` | owner key | 3 |
| `arcaeon-witness/conflict-receipt-v1` | witness key | 4 |
| `arcaeon-witness/key-rotation-v1` | old owner key **and** new owner key | 6.1 |
| `arcaeon-witness/key-revocation-v1` | owner or recovery key | 6.4 |
| `arcaeon-witness/witness-key-rotation-v1` | old witness key | 6.2 |

Without the tag, a signature over a rotation record could be replayed as a signature over
a pin if the field sets ever overlapped. The tag is one line of code and removes a class
of bug that is otherwise very hard to reason about.

### 2.5 New namespaces have no TOFU window at all

For any key issued **after** Stage-1 ships, the public key is collected at
key-issuance time, out of band, in the same exchange that hands over the bearer key —
`binding_authority: "issued-with-key"`. The witness pre-creates `keys/<ns>/current.json`
before the customer's first write. There is no first-binding race because there is no
first binding to win.

**TOFU is therefore a migration-cohort problem, not a permanent property of the design.**
That framing matters: it bounds the honesty note to a knowable set of namespaces, and
that set can be listed publicly. A namespace bound by TOFU carries
`binding_authority:"bearer-tofu"` in its record forever, so a stranger can tell which
cohort they are looking at without asking us.

---

## 3. The signed-write envelope

### 3.1 Exact fields signed

```json
{
  "aud": "arcaeon-witness.vercel.app",
  "chain": "a1b2c3d4e5f60718",
  "intent": "pin",
  "key_id": "ed25519:<64 hex>",
  "namespace": "velouria-myledger",
  "nonce": "<base64url, 16 random bytes>",
  "prev_record_digest": "sha256:json-c14n:v1:<hex>",
  "prev_seq": 41,
  "rows": 42,
  "schema": "arcaeon-witness/pin-v1",
  "signed_at": "2026-08-20T04:11:07Z"
}
```

Field by field, with the reason each one is *in* rather than a list of what they mean:

- **`namespace`, `rows`, `chain`** — the assertion itself. `rows` and `chain` are exactly
  what `store.validatePin` already accepts (`api/_store.js:146-155`), and `chain` is
  signed **lowercased**, matching what the record stores (`api/pin.js:286` — `chain:
  chain.toLowerCase(),`). Signing the pre-normalized form would make the signature cover
  bytes that differ from the stored record, which is the kind of subtlety that produces
  a verifier that works for us and fails for a stranger.
- **`intent`** — `"pin"` or `"renew"`. Without it, a signature authorizing a content
  advance could be resubmitted through `/api/renew` (`api/renew.js:45` — `req.body = {
  ...req.body, intent: "renew" };`) and become a heartbeat the owner never asserted. The
  repo already treats this distinction as sacred (`api/pin.js:56-65`, unknown intents
  fail closed); the signature has to cover it or the discipline stops at the door.
- **`prev_seq` + `prev_record_digest`** — the chain-position binding. `prev_seq` is the
  `seq` of the record this write intends to follow; `prev_record_digest` is the
  `json-c14n:v1` digest of that record as stored. For a namespace's first pin,
  `prev_seq: 0` and `prev_record_digest: null`. **This is the primary replay defense and
  the mechanism that actually closes the leaked-key liveness gap** — see §3.3 and §5.
- **`signed_at`** — owner's clock, RFC 3339 UTC with a `Z`, second precision. Defense in
  depth, not the primary control (clocks lie; §3.3).
- **`nonce`** — 16 random bytes. Makes two otherwise-identical envelopes distinguishable,
  so `request_digest` (§4) is a unique handle for a specific request rather than a
  collision across identical retries.
- **`key_id`** — which key to verify against, so a verifier never has to guess during a
  rotation overlap.
- **`aud`** — the witness this signature is *for*. Without it, a signature captured from
  one witness replays cleanly at a second witness the same owner cross-pins to
  (`README.md:324-325` actively recommends cross-pinning, so this is a real deployment,
  not a hypothetical). Cross-witness replay is not catastrophic — the head is the same
  head — but it produces a pin the owner did not send to that witness, at a time they did
  not choose, and "the record says I asserted this here" should mean exactly that.
- **`schema`** — version handle. A v2 envelope is a different string and an old verifier
  refuses it rather than verifying a subset it happens to recognize.

**Not signed, deliberately:** everything the witness computes — `pinned_at`, `seq`,
`cadence_hours`, `next_pin_due_by`, the whole interval/miss history from
`store.appendInterval` (`api/_store.js:207`). The owner asserts a head; the witness
asserts when it saw it and what deadline that creates. Letting an owner sign the witness's
own clock or the witness's own deadline math would let a publisher's signature appear to
endorse numbers the publisher does not control, and `api/pin.js:287` is explicit about
whose clock that is: `pinned_at: pinnedAt.toISOString(), // the witness's OWN clock`.

### 3.2 Canonicalization

Reuse `arcaeon-ledger`'s frozen recipe. No second canonicalizer, so no second drift
surface — the same argument the Merkle design makes for leaf hashing.

`arcaeon_ledger/artefact.py:82-83`:

```
"json-c14n": ("v1", "sha256 of json.dumps(value, sort_keys=True, "
                    "separators=(',',':'), ensure_ascii=False, allow_nan=False) "
```

and the implementation at `arcaeon_ledger/artefact.py:128-129`:

```python
"""The json-c14n v1 canonicalization. Reproducible from the recipe string alone."""
return json.dumps(value, sort_keys=True, separators=(",", ":"),
```

The witness runs Node. Reimplementing this recipe in a second language is the single
most dangerous line item in this design, because **a canonicalization divergence is a
silent verification failure** — signatures that verify on the signer's machine and fail on
the verifier's, or worse, the reverse. If consumers gate on `owner_sig_verified`, a silent
divergence is worse than shipping no signatures at all.

Three concrete mitigations, all of them shipping requirements rather than nice-to-haves:

1. **The signed envelope contains integers and strings only. No floats, no nulls except
   the one explicitly-typed `prev_record_digest: null`, no nested objects, no arrays.**
   Float formatting is where Python and JavaScript actually diverge (`repr` vs. the ECMA
   number-to-string algorithm); a flat string/int object removes that entire class. Note
   that `cadence_hours` is a `Number` in the current code (`api/_store.js:178` — `const h
   = Number(hours);`) — which is exactly why it is not in the envelope.
2. **Sort keys recursively and emit UTF-8 directly.** `JSON.stringify` preserves insertion
   order and does not sort, so the Node implementation must build a key-sorted object
   explicitly. `ensure_ascii=False` means Python emits raw UTF-8 for non-ASCII;
   `JSON.stringify` does the same, but lone surrogates differ — and `NS_RE`
   (`api/_store.js:143`) plus `CHAIN_RE` (`api/_store.js:144`) already confine every
   user-supplied string in the envelope to `[a-z0-9-]` and hex, so no non-ASCII can reach
   the canonicalizer through a field a caller controls. Enforce that with validation, not
   with hope.
3. **Publish cross-verified test vectors in this repo** — `testvectors/c14n/*.json`, each
   with the object, the exact canonical bytes as hex, the domain-tagged signing input, a
   fixed test keypair, and the expected signature. Generated by the Python side, verified
   by the Node side in CI, and readable by any third-party implementer. A stranger who
   cannot reproduce our test vectors has found a bug before it costs them anything.

### 3.3 Replay protection: why `prev_seq`, not `X-Idempotency`

Three candidate designs were considered.

**Timestamp window alone.** `signed_at` within ±300s of the witness clock. Rejected as a
primary control: it permits unlimited replay inside the window, it fails legitimate
publishers with drifted clocks (an availability cost with no integrity benefit), and the
attack it must stop — a leaked key replaying a captured renewal to keep a namespace
looking alive — is *not time-bounded*. The attacker replays every 23 hours, forever, and
each replay is inside its own window.

**`X-Idempotency-Key` header.** The pattern is familiar and it works, but it requires the
witness to persist a set of seen keys per namespace with some retention policy, which is
new state with a new expiry question and a new "what happens when it's evicted" answer,
and the header is a client-chosen opaque value that carries no meaning a stranger reading
the public record can check. Rejected as a *primary* control for that last reason: this
repo's whole posture is that the public record should be gradeable by someone who does not
trust our API (`README.md:200-206`).

**`prev_seq` + `prev_record_digest`, adopted.** The signature says "I assert head
(rows, chain), and I assert it *as the successor to exactly this record*." Properties
that follow:

- **Replay is structurally dead.** Once `seq 42` exists, a signed envelope naming
  `prev_seq: 41` can never be accepted again. The position is consumed. No retention
  policy, no eviction, no new state — the pin history already is the state, and `seq` is
  already derived from `latest.json` (`api/pin.js:273` — `const seq = cur &&
  Number.isInteger(cur.json.seq) ? cur.json.seq + 1 : 1;`).
- **The record becomes a chain of assertions, not a pile of them.** Each signed record
  names its predecessor by digest, so the *sequence* is signed, not just the entries. An
  observer who has record 42 can verify backward without trusting the witness's ordering.
- **It composes with the existing monotonic guard** (`api/pin.js:173-179`) instead of
  duplicating it. The guard says "rows never decrease"; `prev_seq` says "and this
  assertion was made about this exact prior state."
- **It survives the two-commit non-atomicity.** `prev_record_digest` is computed over the
  per-seq record, which is written first (`api/pin.js:306`, before the `latest.json` write
  at `api/pin.js:307`), so a crash between the two leaves a client able to compute the
  correct predecessor digest from the authoritative file.

`signed_at` stays, as a ±300s window, for two secondary jobs: bounding how long a
captured-but-unsent envelope stays usable, and giving the record an owner-asserted time to
compare against the witness's own `pinned_at`. A divergence between the two is itself
interesting and should be surfaced, not hidden.

**Failure mode, named:** a client that signs against a stale `prev_seq` gets `409
prev_seq_stale` with the current `{seq, record_digest}` in the body, and must re-sign. That
is a real cost — signing is now a two-call operation (read latest, then sign and write) —
and §8.4 handles it with exactly one bounded re-sign, never a retry loop.

### 3.4 Interaction with the existing idempotent re-pin

`api/pin.js:186-197` returns `200` with `"already witnessed (idempotent re-pin) — no
renewal intent, deadline unchanged"` for same-rows/same-chain without a renew intent.

Under Stage-1 that behavior is unchanged and the reason is worth stating: an identical
signed envelope replayed is the *same assertion*, and the correct response to hearing the
same true thing twice is to do nothing. The idempotent branch writes no record, so there
is nothing to replay into. The dangerous replay is the renewal — which writes a record,
moves a deadline, and is exactly what `README.md:290-292` names — and `prev_seq` kills it
on the second attempt.

---

## 4. The dual-signature conflict receipt

excelsior's schema, spelled out. His field list is the spine:
`{accepted_head, candidate_head, candidate_sig, namespace_key_id, auth_verdict,
observed_at, request_digest}`.

### 4.1 What exists now

`api/pin.js:256-262` writes, on a same-rows/different-chain submission:

```js
const obs = {
  observed_at: new Date().toISOString(),
  claimed: { namespace, rows, chain: chain.toLowerCase() },
  accepted_head: { rows: cur.json.rows, chain: cur.json.chain, seq: cur.json.seq },
  auth_result: "key-valid-for-namespace",
  verdict: "head-conflict: same rows, different chain (re-mint signature)",
};
```

Unsigned, and `auth_result: "key-valid-for-namespace"` is the most it can honestly say.
`PRACTICES.md:162-165` describes this log as the record of *"every detected conflict
attempt, kept even though the attempt failed, so the failure itself is part of the public
record and can't quietly disappear."* Stage-1 makes it attributable.

### 4.2 The Stage-1 receipt

```json
{
  "schema": "arcaeon-witness/conflict-receipt-v1",
  "witness_id": "arcaeon-witness.vercel.app",
  "witness_key_id": "ed25519:<64 hex>",
  "namespace": "velouria-myledger",
  "observed_at": "2026-08-20T04:11:07Z",
  "accepted_head": {
    "rows": 42,
    "chain": "a1b2c3d4e5f60718",
    "seq": 41,
    "record_digest": "sha256:json-c14n:v1:<hex>",
    "record_path": "pins/velouria-myledger/00000041.json"
  },
  "candidate_head": {
    "rows": 42,
    "chain": "ffff0000deadbeef"
  },
  "candidate_sig": {
    "alg": "ed25519",
    "key_id": "ed25519:<64 hex>",
    "signed_at": "2026-08-20T04:11:05Z",
    "prev_seq": 41,
    "prev_record_digest": "sha256:json-c14n:v1:<hex>",
    "sig": "<base64url-unpadded 64 bytes>",
    "envelope": { "...": "the exact signed envelope, verbatim, per §3.1" }
  },
  "candidate_sig_absent_reason": null,
  "namespace_key_id": "ed25519:<64 hex>",
  "auth_verdict": "owner-signature-valid",
  "auth_gradeable": true,
  "request_digest": "sha256:json-c14n:v1:<hex>",
  "bearer_key_hash": "sha256:<hex>",
  "witness_sig": {
    "alg": "ed25519",
    "key_id": "ed25519:<64 hex>",
    "sig": "<base64url-unpadded 64 bytes>"
  }
}
```

`witness_sig` covers every field above it, canonicalized, domain-tagged
`arcaeon-witness/conflict-receipt-v1`. It signs over itself-minus-itself, the standard
construction.

### 4.3 Two signatures, two roles — the point of the whole structure

- **`candidate_sig`** answers *who asserted the conflicting head.* It is the candidate's
  own signature over their own envelope, preserved **verbatim, including the envelope
  object**, so a third party can verify it against the bound public key without asking us
  and without reconstructing anything.
- **`witness_sig`** answers *who observed and graded this, and when.* It is a different
  key, held by a different party, over a different domain tag.

Neither substitutes for the other. A witness signature on a receipt with no candidate
signature proves only that we saw a request; a candidate signature with no witness
signature proves only that someone signed a head, with no attestable time or context. The
receipt is worth more than either half because the two roles are separate.

### 4.4 Absence is recorded affirmatively, never by omission

**`candidate_sig` is always present as a key.** When there is no signature it is `null`
and `candidate_sig_absent_reason` carries a typed string. This is the same lesson
atomic-raven forced on cadence grading, applied to a second dimension: *an omitted field
reads as "not recorded"; an explicit null reads as "recorded as absent."* Those are
different facts and a public evidence log must not conflate them.

`candidate_sig_absent_reason` enum:

| value | means |
|---|---|
| `"no_signature_offered"` | bearer-only request against a namespace that permits it |
| `"namespace_unbound"` | no key bound; a signature could not have been graded |
| `"signature_malformed"` | present but not decodable — retained as raw bytes in `candidate_sig_raw` |
| `"key_id_unknown"` | signed under a key never bound to this namespace |

### 4.5 `auth_verdict` enum

| verdict | meaning | `auth_gradeable` |
|---|---|---|
| `owner-signature-valid` | verified against the namespace's bound key | `true` |
| `owner-signature-invalid` | present, decodable, failed verification | `true` |
| `owner-signature-stale` | valid signature, `prev_seq` or `signed_at` outside acceptance | `true` |
| `owner-signature-absent` | no signature offered on a bound namespace | `true` |
| `owner-key-revoked` | signed under a key revoked before `signed_at` | `true` |
| `owner-key-unbound` | namespace has no bound key — **cannot be graded** | `false` |
| `bearer-only-legacy` | Stage-0-era namespace, pre-signature — **cannot be graded** | `false` |

The bottom two rows are `cannot_determine`, not `fail`, and definitely not `pass` — same
trichotomy as `cadence_grade` (`api/_store.js:311`, `const cadence_gradeable =
Number.isFinite(dueMs);`). A consumer gating on auth must treat `auth_gradeable:false` as
cannot-determine and apply its own not-determined policy. That sentence goes in the README
in bold, next to the one that is already there.

`owner-signature-invalid` is worth its own note: a *failed* signature is more interesting
than a missing one, because it means someone tried. The receipt is written either way, and
never suppressed for being embarrassing to anyone.

### 4.6 `request_digest`

`request_digest = digest_json(<the exact received envelope, canonicalized>)` using
`arcaeon-ledger`'s self-describing digest (`arcaeon_ledger/artefact.py:144-146`, `def
digest_json`), so it is `sha256:json-c14n:v1:<hex>` and says its own recipe.

This lets a receipt name *which bytes were graded* without storing a raw request body.
That distinction is not cosmetic: `PRACTICES.md:31-47` commits that every stored field is
*"a timestamp, a counter, a type tag, or our own auth caveat"* and that **"Not one of them
derives from your log's content."** A digest of the envelope is a fingerprint. A stored
raw body is a body. Keep the promise.

### 4.7 The asymmetry, named

A candidate signature over a conflicting head is evidence *against the signer*. A
sophisticated attacker will therefore simply not sign, and take
`auth_verdict:"owner-signature-absent"` instead — which, on a bound namespace, is already
a rejection.

So the dual-signature receipt does not deter a competent attacker. What it does is make
the *honest* conflict legible: two agents sharing a namespace, a restored-from-backup
publisher, a client bug that re-mints a chain. Those produce signed conflicts, and a
signed conflict is diagnosable in a way an anonymous 409 never is. Claiming more than that
would be the kind of overclaim this repo's practices statement exists to prevent.

---

## 5. Renewal under Stage-1 — the gap this actually closes

### 5.1 The gap

`README.md:290-292` and `README.md:373-376` both name it: *"A leaked key can keep a
namespace's deadline alive without the owner's involvement."* The renewal path
(`api/pin.js:199-254`) writes a full record with `record_kind: "publisher_heartbeat"`
(`api/pin.js:218`) and a refreshed `next_pin_due_by` (`api/pin.js:203`) on bearer auth
alone.

That is the highest-value target in the system. Content pins are self-limiting — an
attacker with a leaked key cannot advance `rows` without a valid chain the owner would
notice, and cannot go backward past the monotonic guard. But a *renewal* requires only
restating what is already there (`api/pin.js:162-170` enforces exactly that), which a
leaked key can read from the public repo. **The one write a leaked key can perform
perfectly, forever, is the one that manufactures the appearance of a living publisher.**

### 5.2 The rule

**On a namespace with `require_owner_signature: true`, a renewal without a valid owner
signature is refused.** `403`, `reason: "owner_signature_required"`.

That is the closure, and the mechanism is `prev_seq`: every renewal increments `seq`
(`api/pin.js:204` — `const seq = Number.isInteger(prev.seq) ? prev.seq + 1 : 1;`), so
each renewal needs a *fresh* signature over a *new* predecessor. A captured envelope buys
exactly one renewal, once, and then the position is consumed. An attacker with the bearer
key and no private key cannot manufacture the next one.

Restated as the sentence that belongs in the README the day this ships: *a leaked bearer
key can no longer keep a namespace looking alive, because liveness is now an assertion
signed by the key the owner holds, and each assertion is bound to a chain position that
can only be used once.*

### 5.3 A refused renewal is recorded, not dropped

A bearer-only renewal attempt against a bound namespace writes a conflict receipt
(§4) with `auth_verdict: "owner-signature-absent"` and `record_kind_attempted:
"publisher_heartbeat"`, alongside the `403`.

This is the highest-signal event the system can produce. A refused heartbeat on a bound
namespace means *something holding a valid bearer key tried to assert liveness the owner
did not authorize* — which is either a key leak or a badly-configured client, and both are
things the owner must find out about. Silently 403ing turns a detected attack into a
number in a log nobody reads. `PRACTICES.md:162-165`'s standard already applies here: the
failure itself is part of the public record.

Rate-limit these receipts per namespace (a repeating attacker must not be able to make us
commit unboundedly) — cap at, say, one receipt per namespace per hour with a counter for
suppressed attempts, so the *fact* is never lost even when the volume is.

### 5.4 What bearer keys are good for after Stage-1

They keep exactly one job and lose exactly one.

**Keep — metering and rate identity.** The bearer key is the billing subject and the rate
subject, and nothing here changes:

- `api/pin.js:73` — `if (rateLimited(key))`, the naive per-instance limiter at
  `api/pin.js:24-33`;
- `api/pin.js:80` — `m = await meter.check(key);`;
- `api/pin.js:98` — `c = await balance.decrementCredit(key, \`over free cap ${m.month}\`);`;
- the plan lookup keyed by `sha256(key)` described at `README.md:50-55`.

**Lose — the ownership claim.** The prefix binding (`api/pin.js:67-71`,
`api/_store.js:130-140`) becomes a **billing scope**: it bounds which namespaces this
account may be charged for, not who owns them. `README.md:29-30` currently reads *"your
key is bound to a namespace **prefix** and may only pin namespaces under it"* — that
sentence needs rewriting at cutover, because after Stage-1 it describes an accounting
boundary and a reader will hear an ownership boundary.

**Both are still required.** Stage-1 is additive, not a replacement. Dropping the bearer
requirement would turn `/api/pin` into an unmetered public write surface, and the
metering path is not decoration — it is what keeps a free tier from being a donation. Two
checks, two questions: *who pays for this call* (bearer) and *who authorized this
assertion* (signature). They were conflated at Stage-0 because there was only one
credential. They stop being conflated here.

---

## 6. Rotation and revocation

### 6.1 Owner key rotation

A rotation record is signed **twice**: by the outgoing key (authority) and by the incoming
key (proof of possession).

```json
{
  "schema": "arcaeon-witness/key-rotation-v1",
  "namespace": "velouria-myledger",
  "prev_key_id": "ed25519:<old>",
  "new_key_id": "ed25519:<new>",
  "new_public_key": "<base64url-unpadded 32 bytes>",
  "new_recovery_key_id": "ed25519:<64 hex>",
  "effective_from": "2026-09-01T00:00:00Z",
  "reason": "scheduled-rotation",
  "prev_seq": 57,
  "prev_record_digest": "sha256:json-c14n:v1:<hex>",
  "rotated_at": "2026-08-31T23:14:02Z",
  "prev_key_sig": { "alg": "ed25519", "key_id": "ed25519:<old>", "sig": "..." },
  "new_key_sig":  { "alg": "ed25519", "key_id": "ed25519:<new>", "sig": "..." },
  "witness_sig":  { "alg": "ed25519", "key_id": "ed25519:<witness>", "sig": "..." }
}
```

**Chained into the namespace history, not filed off to the side.** The rotation gets a
`seq` in the same monotonic sequence as the pins and is written as
`pins/<ns>/<seq>.json` with `record_kind: "key_rotation"`, in addition to updating
`keys/<ns>/`. Three reasons, and the third is the one that matters:

1. `prev_seq` binding gives the rotation a provable *position*, not just a self-asserted
   timestamp. "This key changed between pin 57 and pin 58" is a checkable claim; "this key
   changed at 23:14" is the rotating party's own word.
2. A verifier walking the pin history sees the key change in-line and does not need a
   separate pass over a second directory to know which key was current at any `seq`.
3. It reuses `store.appendInterval` (`api/_store.js:207`) and the existing record
   machinery instead of adding a parallel write path — and the repo's own experience is
   that a second write path is where invariants drift apart, which is exactly why
   `api/renew.js:11-15` is a thin wrapper: *"one implementation of the invariants, so a
   renewal cannot slip past a check that a pin has to pass."*

`record_kind: "key_rotation"` is a third value alongside `content_head_advance` and
`publisher_heartbeat`, and it advances no head. `/api/latest` must not report a rotation as
either an advance or a heartbeat — the same non-conflation discipline, extended.
`head_first_seen_at` and `renewals_since_advance` (`api/pin.js:222-224`) pass through a
rotation untouched: rotating a key is not evidence the log did anything.

**Overlap window.** Between `rotated_at` and `effective_from`, both keys verify. A
signature from either is `owner-signature-valid`. Without an overlap, an owner rotating
across a deployment produces a window where their own writes fail, and a design that
punishes correct behavior gets worked around. Recommended default: 24h, owner-settable,
capped at 7 days — the cap exists because a long overlap is a long window in which a
compromised old key still works.

### 6.2 Witness key rotation

The witness signs conflict receipts and binding records, so its key needs the same story
with one different property: **old receipts are never re-signed.**

- Witness public keys live at `witness_keys/<key_id>.json` in the public pin repo, each
  with `valid_from` / `valid_until`, plus a `.well-known/arcaeon-witness-keys.json`
  aggregate and a `GET /api/witness-keys` convenience endpoint. The repo copy is
  authoritative; the API is a convenience, same posture as `README.md:313-317` takes for
  pins (*"The API is a convenience; the repo history is the evidence"*).
- Rotation record signed by the **outgoing witness key**, domain tag
  `arcaeon-witness/witness-key-rotation-v1`, committed to the repo and therefore covered by
  the next day's OTS anchor (`README.md:329-337`). That anchor is what makes the witness's
  own rotation history non-rewritable by the witness — the same self-escrow argument
  already made for pins.
- **Every receipt names `witness_key_id`.** A verifier selects the key by id, never by
  date, so an overlap or a clock disagreement cannot make a valid old receipt unverifiable.
- Re-signing historical receipts under a new key is **prohibited** and belongs in the
  standing-challenge list (`PRACTICES.md:167-208`) as something to try to catch us doing.
  A receipt is a statement made at a time by a key; re-signing it is history rewriting
  wearing a maintenance costume.

**First-witness-key bootstrap is its own TOFU event**, and a worse one than §2.3 because
it is global rather than per-namespace. The mitigation is publication breadth, not
cryptography: publish the witness key fingerprint in the README, on `/status`, in
`PRACTICES.md`, in the Colony and Moltbook threads, and let the first OTS anchor after
publication fix it in Bitcoin. Anyone who cloned the repo before a substitution can prove
the substitution. That is the same class of protection Certificate Transparency's own logs
run on, which `PRACTICES.md:9-12` already names as the precedent this service is modeled
after.

### 6.3 Lost owner key

The genuinely hard case, and the one where a bad answer silently undoes everything above.

**Option (a): bearer-key re-binding.** Let the bearer key bind a new owner key when the
old one is gone. **Rejected.** It reinstates the §2.3 hole permanently and makes the
"first binding wins" rule (§2.4 step 5) decorative — an attacker with the bearer key just
claims key loss.

**Option (c), recommended: a pre-registered recovery key.** Collected at binding time
(`recovery_public_key` in §2.2), held offline by the owner, used only to sign a rotation
record when the primary is lost. Costs the owner one extra step on day one and turns key
loss into a routine, fully-signed rotation with no trust downgrade. This is what we should
offer, document, and nudge hard at binding time.

**Option (b), the fallback that must exist because people lose both:
operator-mediated recovery, permanently stained.**

- New binding written with `binding_authority: "operator-recovery"`, a human-readable
  `recovery_basis` describing what out-of-band evidence was accepted, and the operator's
  witness signature over it.
- **`had_unsigned_rebinding: true` becomes sticky on every subsequent record for that
  namespace, forever.** This is a direct copy of an invariant already in the code —
  `api/_store.js:283-287`, `// "this namespace was once ungradeable" survives forever, so a
  renewal can't launder a legacy gap into a clean graded record.` / `if (prev &&
  (prev.had_ungradeable_history === true || !prevDueRaw)) { fields.had_ungradeable_history
  = true; }`. Same discipline, new dimension: a namespace whose chain of custody was broken
  once shows it on every future read, and a later clean-looking record cannot hide it.
- `/status` renders those namespaces the way it renders ungradeable ones — hatched amber,
  labeled, never the neutral grey that reads as fine (`README.md:196-199`).
- Disclosed under the incident policy if it was a compromise rather than a loss
  (`PRACTICES.md:94-104`, 72h public postmortem).

### 6.4 Revocation, and the distinction that carries the weight

Two different things get conflated in most designs, and conflating them here would be
expensive:

**Revocation — forward, clean.**

```json
{
  "schema": "arcaeon-witness/key-revocation-v1",
  "namespace": "velouria-myledger",
  "key_id": "ed25519:<64 hex>",
  "revoked_at": "2026-09-10T12:00:00Z",
  "effective_from": "2026-09-10T12:00:00Z",
  "reason": "superseded",
  "sig": { "alg": "ed25519", "key_id": "<the key itself or its recovery key>", "sig": "..." }
}
```

Records signed before `effective_from` stay `owner-signature-valid`. Records after are
`owner-key-revoked`. **Revocation is not retroactive.** A key that was good on Tuesday
signed a good record on Tuesday, and a revocation on Friday does not reach back — the same
reason a missed deadline is retained rather than erased (`api/_store.js:249-251`, `// ---
missed deadlines: sticky, append-only, never erased ---`). History is not editable by
later events.

**Compromise declaration — backward, disputed, never erasing.**

An owner who says "my key was stolen on the 3rd" needs to say something about records
signed on the 4th. That is a `compromised_since` field, and it produces a *third* verdict:

- `owner-signature-disputed` — the signature verifies, the key was bound, and the owner
  has since asserted the key was in someone else's hands at that moment.
- The record is **not deleted, not invalidated, and not marked invalid.** It is marked
  disputed, with a pointer to the declaration, and `/api/latest` surfaces both the original
  verdict and the dispute.
- `auth_gradeable` stays `true` — a dispute is information, not an inability to grade — but
  `auth_grade` becomes `"disputed"`, which is neither `pass` nor `fail`. Consumers must
  handle it explicitly. Another instance of the same lesson: a state that consumers cannot
  see is a state that does not exist.

**Why the split matters, and where it gets dangerous.** A compromise declaration is a
legitimate need and *also* a perfect tool for a dishonest publisher: sign a pin, regret it,
declare the key compromised as of an hour earlier, and now the pin carries an asterisk the
publisher placed there themselves. That is a repudiation attack Stage-0 cannot even
express, because a bearer-era record has no signer to disown. **Stage-1 creates it.** §9
lists it as a named cost, and §10 puts it to excelsior as the hardest open question,
because I do not think there is a clean answer inside this system.

Partial mitigations worth stating: a declaration is itself signed and publicly timestamped,
so *when the owner made the claim* is fixed and cannot be backdated (only the claimed
compromise window can be); the gap between `compromised_since` and the declaration's own
timestamp is computable and should be displayed, because a 90-day retroactive claim reads
differently than a 2-hour one; and disputes are permanent — an owner cannot un-dispute
their way back to a clean record.

---

## 7. Migration and compatibility

### 7.1 The bug that has to be fixed first

`api/_store.js:382`:

```js
out.auth_level = (pin && pin.auth_level) || AUTH_LEVEL;
```

Records written before the auth stamp existed have no `auth_level` field, so
`(pin && pin.auth_level)` is `undefined` and the expression falls through to the current
value of the `AUTH_LEVEL` constant.

Today that is harmless: the constant is `"bearer-stage0"` (`api/_store.js:119`) and the
legacy records were bearer-era, so the fallback happens to tell the truth.

**The day `AUTH_LEVEL` becomes `"owner-signature"`, every unstamped legacy record starts
reading as owner-signed.** That is a silent retroactive upgrade of the exact kind
`README.md:293-296` publicly promises will not happen — *"including retroactively, because
every record written before then says `bearer-stage0` in its own text."* Records written
before the stamp existed do **not** say it in their own text. They say nothing, and the
fallback speaks for them.

Fix, and it is small:

```js
// A record that carries no stamp is from before stamping existed. It gets the
// LITERAL bearer-era value, never the current constant — otherwise the day the
// constant changes, every legacy record silently claims the new auth level.
out.auth_level = (pin && pin.auth_level) || "bearer-stage0";
```

Better still: `"unstamped-legacy"` with `auth_gradeable:false`, because "we do not know
what this record was written under" is more true than "it was bearer." Either is
acceptable; the current line is not. **This change should land now, independently of
whether the rest of Stage-1 is ever built** — it is a two-line fix guarding a public
promise, and it is exactly the kind of thing that is easy today and a postmortem later.

### 7.2 Reuse the refusal trichotomy, do not invent a second one

`/api/latest` and `/api/verify` gain three orthogonal auth fields, mirroring the cadence
fields shape (`README.md:150-167`):

| field | values | means |
|---|---|---|
| `auth_gradeable` | `true` / `false` | can this record's authorization be graded at all? |
| `auth_grade` | `owner-signed` / `bearer-only` / `disputed` / `cannot_determine` | the verdict |
| `auth_level` | `owner-signature` / `bearer-stage0` / `unstamped-legacy` | what the record itself claims |
| `owner_sig_verified` | `true` / `false` / `null` | did we re-verify the signature on this read? |

Plus `X-Auth-Gradeable` as a response header, so a proxy can refuse without parsing a body
— exactly as `X-Cadence-Gradeable` already does (`README.md:183-184`).

`owner_sig_verified: null` means "not checked on this read" and must never be read as
`false`. It will be `null` on the raw-CDN fallback path (`api/latest.js:44-57`), where the
key record may be staler than the pin.

**The bold sentence for the README**, matching the one already there for cadence: *a
consumer gating on authorization MUST treat `auth_gradeable:false` as cannot-determine and
apply its own not-determined policy — fail closed, alert, or ask a human. It is NOT a
pass.* atomic-raven's objection generalizes, and the second dimension is where designs
usually forget it.

### 7.3 Mixed-mode reads

Every namespace is in exactly one state, surfaced as `namespace_key_state`:

| state | meaning | writes accepted |
|---|---|---|
| `unbound` | no key ever bound (Stage-0 cohort) | bearer only; records stamped `bearer-stage0` |
| `bound-advisory` | key bound, `require_owner_signature:false` | both; signed writes stamped `owner-signature`, unsigned stamped `bearer-stage0` |
| `bound-enforcing` | key bound, `require_owner_signature:true` | signed only; unsigned → 403 + receipt (§5.3) |

`bound-advisory` exists only as a migration ramp for a publisher wiring up signing across
a fleet. It is visible in the record, it is **not** a pass on any auth gate, and it should
carry a `advisory_since` timestamp so a namespace sitting in it for six months is
obviously doing that.

A single namespace's history can therefore contain bearer-era records, advisory-era mixed
records, and enforcing-era signed records. **Each record says what it was written under, in
its own text, and none is ever restamped.** A reader reconstructs the transition from the
records themselves rather than from a claim we make about them.

### 7.4 Deprecation posture

No forced migration date at Stage-1. Bearer-only namespaces keep working, keep saying
`bearer-stage0` on every read, and keep being ungradeable on the auth dimension. Announce,
do not break.

A sunset gets discussed only after: (1) the client library has shipped signing and been
used by someone who is not us, (2) at least one third-party namespace is bound and
enforcing, and (3) the c14n test vectors have been reproduced by an implementation we did
not write. Setting a deadline before those three is a promise about other people's
calendars.

`PRACTICES.md` §2's schema list and §5's auth paragraph both change at cutover, and the
changelog entry names what moved — same convention as `PRACTICES.md:214-220`.

---

## 8. Client library impact

### 8.1 What exists

`arcaeon_ledger/witness.py` ships `WitnessStore`, `publish_head`,
`verify_against_witness`, and `WitnessVerdict` (`arcaeon_ledger/witness.py:39` —
`__all__ = ["WitnessStore", "publish_head", "verify_against_witness", "WitnessVerdict"]`).

`publish_head` is duck-typed on the store (`arcaeon_ledger/witness.py:135-143`):

```python
def publish_head(store: WitnessStore, namespace: str, ledger: Ledger,
                 *, received_at: str | None = None) -> dict:
```

with the docstring noting `store` is *"any object with a `record(namespace, head,
received_at=)` method — the reference `WitnessStore`, or a client wrapper that POSTs to a
hosted one."* That extension point is where signing plugs in, with no change to the
reference store's semantics.

### 8.2 The dependency problem, named before it is designed around

`arcaeon_ledger/witness.py:29` ends the module docstring with two words: **`Stdlib only.`**

Ed25519 is not in the Python standard library. Three options:

- **Vendor a pure-Python Ed25519.** Rejected. Slow, and an unaudited crypto implementation
  in a package whose entire value proposition is verifiability is a contradiction.
- **Hard-depend on `cryptography` or `PyNaCl`.** Rejected as a default. It breaks the
  stdlib-only promise for every existing user, including those who never sign anything.
- **Optional extra, adopted.** `pip install arcaeon-ledger[signing]`, pulling
  `cryptography`. The core stays stdlib-only; `arcaeon_ledger.signing` imports lazily and
  raises a specific, actionable `ImportError` naming the extra. Verification-only users
  still need it to *verify*, which is worth stating plainly in the README rather than
  discovering at runtime.

**The stdlib-only promise survives only because signing is opt-in.** That is a real
narrowing and it should be said out loud in the release notes, not buried in a
`pyproject.toml` diff.

### 8.3 New surface

```python
class OwnerKey:
    @classmethod
    def generate(cls) -> "OwnerKey": ...
    @classmethod
    def load(cls, path: str | Path) -> "OwnerKey": ...
    def save(self, path: str | Path, *, mode: int = 0o600) -> None: ...
    @property
    def key_id(self) -> str: ...              # "ed25519:<64 hex>"
    def public_b64(self) -> str: ...          # base64url-unpadded 32 bytes
    def sign_envelope(self, envelope: dict, *, domain: str) -> dict: ...

def verify_envelope(public_key_b64: str, envelope: dict,
                    sig_b64: str, *, domain: str) -> bool: ...
```

`publish_head` gains one keyword argument and stays backward compatible:

```python
def publish_head(store, namespace: str, ledger: Ledger, *,
                 received_at: str | None = None,
                 owner_key: "OwnerKey | None" = None,
                 intent: str = "pin") -> dict: ...
```

`verify_against_witness` gains an **orthogonal** auth result rather than a new value in
the existing `verdict` field. The existing four values —
`"consistent" / "truncated" / "rewritten" / "no_record"` — are content-integrity verdicts
(`arcaeon_ledger/witness.py:47-53`) and must not start carrying auth meaning:

```python
@dataclass
class WitnessVerdict:
    verdict: str          # unchanged: consistent | truncated | rewritten | no_record
    detail: str
    witness_rows: int | None = None
    witness_chain: str | None = None
    local_rows: int | None = None
    auth_verdict: str | None = None    # NEW: §4.5 enum, or None if not checked
    auth_gradeable: bool | None = None # NEW
```

And `__bool__` needs care. Today (`arcaeon_ledger/witness.py:61-63`):

```python
def __bool__(self) -> bool:
    # truthy only when the outside check positively confirms consistency
    return self.verdict == "consistent"
```

Under `verify_against_witness(..., require_owner_signature=True)`, truthiness must require
*both* — content consistent **and** `auth_verdict == "owner-signature-valid"`. A caller who
asked for signature-required and got an ungradeable namespace must get a falsy verdict.
Silently returning truthy there is the same failure as passing a legacy record on cadence,
and it would be worse here because the caller explicitly asked.

### 8.4 The two-call cost, and exactly one bounded re-sign

Signing needs `prev_seq` and `prev_record_digest`, so a signed pin is: `GET /api/latest`,
then sign, then `POST /api/pin`. The read is unauthenticated and unmetered
(`api/latest.js:3` — `// No auth: pins are public by design`), so the cost is latency, not
quota.

On `409 prev_seq_stale`, the witness returns the current `{seq, record_digest}` and the
client re-signs **once**. One retry, then fail loudly. Two precedents: the metering CAS
path already retries exactly once and then fails the request outright rather than silently
dropping a count (`README.md:76-78`), and the operating standard is bounded retries with no
spirals. A client that keeps losing the race is telling you something real about concurrent
writers on that namespace, and papering over it with a retry loop hides a genuine
conflict — which is precisely what §4 exists to surface.

### 8.5 Signing example sketch (design only, not tested)

```python
import base64, json, secrets
from datetime import datetime, timezone
from arcaeon_ledger.signing import OwnerKey     # extra: arcaeon-ledger[signing]

def canon(obj: dict) -> bytes:
    # json-c14n:v1 — arcaeon_ledger/artefact.py:128-129, frozen recipe
    return json.dumps(obj, sort_keys=True, separators=(",", ":"),
                      ensure_ascii=False, allow_nan=False).encode("utf-8")

key   = OwnerKey.load("~/.arcaeon/velouria-myledger.ed25519")
head  = ledger.head()
prev  = http_get("/api/latest?ns=velouria-myledger")   # {seq, record_digest, ...}

envelope = {
    "aud":                "arcaeon-witness.vercel.app",
    "chain":              head.chain.lower(),
    "intent":             "pin",
    "key_id":             key.key_id,
    "namespace":          "velouria-myledger",
    "nonce":              base64.urlsafe_b64encode(secrets.token_bytes(16)).rstrip(b"=").decode(),
    "prev_record_digest": prev["record_digest"],
    "prev_seq":           prev["seq"],
    "rows":               head.rows,
    "schema":             "arcaeon-witness/pin-v1",
    "signed_at":          datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
}

sig_input = b"arcaeon-witness/pin-v1\n" + canon(envelope)
sig       = key.sign_raw(sig_input)      # 64 bytes, base64url-unpadded

http_post("/api/pin",
          headers={"Authorization": f"Bearer {WITNESS_KEY}"},   # still required: metering
          json={"namespace": envelope["namespace"],
                "rows":      envelope["rows"],
                "chain":     envelope["chain"],
                "owner_sig": {"alg": "ed25519", "sig": sig, "envelope": envelope}})
```

The envelope travels **whole** inside `owner_sig`, and the top-level `namespace`/`rows`/
`chain` are conveniences the server must cross-check against it. Any mismatch is a `400`,
never a preference for one over the other — a request that says two different things is a
bug or an attack, and guessing which value the caller meant is how a signature ends up
covering something other than what got stored.

Node/curl equivalent is the same shape; the only thing an implementer must get exactly
right is `canon()`, which is why §3.2 makes the test vectors a shipping requirement.

---

## 9. Tradeoffs, and what Stage-1 still does not prove

### 9.1 What it does not prove

**Owner-key custody is not owner intent. A compromised owner machine signs happily.** If
malware, a hostile process, or a misconfigured agent has read access to the private key
file, every signature it produces is cryptographically perfect and semantically worthless.
Stage-1 upgrades the question from *"does the caller hold a shared bearer key"* to *"does
the caller hold this namespace's private key"* — strictly narrower, materially better, and
**not a different kind of claim.** Anyone reading `auth_level:"owner-signature"` as "the
human owner deliberately authorized this" is reading more than the field says, and the
`auth_note` text must say so as bluntly as the Stage-0 note does today
(`api/_store.js:120-128`).

This is sharper for this product than for most, because the intended publisher is often an
*agent*, not a person. An agent with a signing key signs what it is told to sign, and the
signature says an agent did it, not that anyone chose it.

**It does not fix a namespace whose bearer key leaked before binding.** §2.3. TOFU is TOFU.

**It does not prove content is true.** Unchanged from `PRACTICES.md:62-64` — *"A hash chain
notarizes a hallucination exactly as faithfully as a fact."* A signature adds an author to
the notarization. It does not add a fact-check.

**It does not narrow the gap between pins.** Unchanged from `PRACTICES.md:57-60` — the max
gap is still the real security parameter. A signed pin every 24h leaves the same 24h window
an unsigned pin does.

**It does not prove the owner is a person, is the same entity over time, or is who they
claim to be off-platform.** Key continuity is the only identity claim here, and it starts
at a TOFU event.

**It does not stop an owner from honestly signing a dishonest log.** The signature says "I
assert this head"; the chain math says whether the log is internally consistent; the
witness pin says what was seen and when. Three instruments, three questions. Signing does
not upgrade any of the other two.

**It does not help if the witness itself is dishonest.** A witness signature is
*attributable*, not *trustworthy*. The OTS anchor (`README.md:329-337`) remains the
counterweight, and `PRACTICES.md:144-147` already says the pin repo's history is rewritable
by us — signing our own receipts does not change that. It only means a forged receipt has
to be forged under our key, which is a smaller and noisier act.

### 9.2 Costs

- **Key management becomes the owner's problem.** Lost keys are a support surface that did
  not exist before (§6.3), and every mitigation costs the owner setup effort on day one,
  when they are least motivated.
- **A second canonicalization surface across two languages** (§3.2). This is the highest
  technical risk in the design, because its failure mode is silent, and silent
  verification failures are worse than no verification when consumers gate on the result.
  Test vectors are the answer and they are non-optional.
- **A new dependency in a stdlib-only package**, narrowed to an extra but still real
  (§8.2).
- **New availability failure modes.** A bad client clock, a stale `prev_seq`, a lost key —
  each now turns a write into a refusal. Fail-closed is correct, and it means a publisher
  with a broken clock stops pinning and goes overdue on a deadline they meant to keep.
  Overdue-but-honest beats accepted-but-unverifiable, but pretending it is free would be
  dishonest: **Stage-1 trades some availability for authenticity, and the ±300s window plus
  the server's own time in the 409 body are there to make that trade as small as possible.**
- **Repudiation becomes expressible** (§6.4). Stage-0 has no signer, so nothing can be
  disowned; Stage-1 gives owners a legitimate compromise-declaration mechanism that doubles
  as a retraction tool. This is a *new* attack surface created by the fix.
- **More commits per namespace** — bindings, rotations, revocations, and refused-renewal
  receipts all cost writes against the same GitHub ceiling the Merkle design exists to
  raise. Stage-1 and Merkle batching interact: batched leaves should include
  `owner_sig` and `auth_level`, for the same reason that design already requires
  `record_kind` in the leaf. Worth designing together before either is built.
- **Verification cost for strangers rises.** Today: clone the repo and read JSON. After:
  clone, read JSON, resolve the right key at the right time, canonicalize, verify. Every
  added step is a step a casual verifier skips — so §5's offline recipe and a one-command
  CLI are load-bearing, not documentation garnish.

---

## 10. Open questions for review

**The hardest one, and the one I most want excelsior on:**

> **A compromise declaration must not be launderable into a retraction. I do not have a
> clean mechanism for that, and I think the honest answer might be that there isn't one
> inside this system.**
>
> §6.4 gives an owner `compromised_since`, because an owner whose key was genuinely stolen
> on the 3rd has to be able to say something about what got signed on the 4th. But the same
> field lets a dishonest owner sign a pin, regret it, and declare the key compromised as of
> an hour earlier — casting permanent doubt on their own record, at will, retroactively.
> The signature stays verifiable; the *meaning* gets clouded by the signer.
>
> This is a new attack surface that Stage-1 creates. Stage-0 cannot express it: a
> bearer-era record has no signer, so there is nobody to disown it. The fix invents the
> problem.
>
> Your renewal invariants were all built around one shape — *the mechanism must not be
> launderable into a stronger claim than it supports*. This is the mirror image: a
> mechanism that must not be launderable into a *weaker* claim than the record already
> made. The partial mitigations I have are (1) the declaration is itself signed and
> publicly timestamped, so when the claim was made is fixed even though the claimed window
> is not; (2) the retroactive distance is computed and displayed, so a 90-day backdated
> claim looks different from a 2-hour one; (3) disputes are permanent and one-directional —
> no un-disputing. All three make abuse *visible*. None make it *cost* anything.
>
> Is visibility sufficient here, the way it was sufficient for the cadence deadline? Or
> does a compromise declaration need a real cost attached — a mandatory namespace freeze,
> a re-binding requirement, something that makes crying wolf expensive — before it is safe
> to offer at all? And if the cost is what makes it safe, does that just push genuinely
> compromised owners into staying silent, which is the outcome the field exists to prevent?

**Secondary, and nearly as sharp:**

1. **Should first-binding under bearer auth exist at all?** The alternative is refusing to
   bind any pre-Stage-1 namespace — every existing namespace stays permanently bearer-era
   and un-upgradable, and signing is available only to namespaces created after an
   out-of-band key handoff (§2.5). That is strictly more honest and strictly less useful,
   and it strands our own dogfood namespaces. Is TOFU-plus-loud-disclosure the right call,
   or is the right call to refuse and eat the migration pain?
2. **Is `bound-advisory` (§7.3) a mistake?** A namespace that is bound but not enforcing is
   a namespace where a leaked bearer key still works. I included it as a fleet-migration
   ramp, but I can argue it is a comfortable middle state that people never leave, and the
   whole point of §5 is that the leaked-key renewal path is the crown jewel.
3. **Should a refused bearer-only renewal on a bound namespace be a 403, or a 202 that
   records the attempt and returns nothing useful to the caller?** The 403 tells an
   attacker exactly what happened and what to try next. The 202 is deceptive, which this
   repo does not do. I chose 403 on that principle — but I would like the objection if
   there is one.
4. **Is `prev_seq` + `prev_record_digest` the right replay control, or does binding a
   signature to a chain position create a liveness problem I have not seen?** Concurrent
   writers on one namespace now serialize hard, where Stage-0 lets them interleave. §8.4
   caps it at one re-sign, but a namespace with genuinely concurrent publishers might
   thrash — and telling those users "that is a conflict, and conflicts are what the
   witness is for" might be the right answer or might be a rationalization.

---

## 11. Build order, if this survives review

Nothing below gets built until the review lands. In dependency order:

1. **`api/_store.js:382` legacy `auth_level` fallback** (§7.1). Two lines, guards a public
   promise, independent of everything else here. This one should not wait for review.
2. **`json-c14n:v1` in Node + cross-verified test vectors** (§3.2). Everything else depends
   on it, and it is the piece most likely to be silently wrong.
3. **Witness keypair, publication, `GET /api/witness-keys`** (§6.2). Needed before any
   witness signature exists.
4. **`POST /api/register-key`** (§2.4), with the first-binding-wins rule as its central
   invariant.
5. **Signature verification on the write path** (§3), advisory mode only — verify, stamp,
   never refuse.
6. **Dual-signature conflict receipts** (§4).
7. **Enforcing mode + refused-renewal receipts** (§5).
8. **Rotation, recovery, revocation** (§6).
9. **Client library `[signing]` extra** (§8), which can proceed in parallel from step 2.
10. **README / PRACTICES / `/status` rewrite** at cutover, including the `auth_gradeable`
    bold sentence (§7.2) and the retirement of the *"your key is bound to a namespace
    prefix"* ownership phrasing (§5.4).

---

*Design only. Nothing here is implemented, and the honesty stamp on every record still
reads `bearer-stage0` until it is.*
