# arcaeon-witness

Stage-0 hosted witness for [arcaeon-ledger](https://github.com/dan8433-user/arcaeon-ledger)-style
append-only hash chains. A hash chain alone cannot catch **truncation** — lop off
the newest rows and the remainder still verifies. The fix is a witness outside
your control that records your log's head `(rows, chain)` on a cadence. This is
that witness, hosted.

**The backing store is a PUBLIC GitHub repo:**
[`dan8433-user/arcaeon-witness-pins`](https://github.com/dan8433-user/arcaeon-witness-pins).
Every pin lands as a commit. Commits are free, third-party-timestamped by GitHub,
publicly verifiable, and any history rewrite is visible. Pins contain fingerprints
ONLY — `{namespace, rows, chain, pinned_at, seq}` — never log content
("password nowhere": breaching the store yields hashes useless without your log).

## API

Base URL: the Vercel deployment (e.g. `https://arcaeon-witness.vercel.app`).

### POST /api/pin (bearer-key auth)

```bash
curl -s -X POST https://arcaeon-witness.vercel.app/api/pin \
  -H "Authorization: Bearer $WITNESS_KEY" \
  -H "Content-Type: application/json" \
  -d '{"namespace":"velouria-myledger","rows":42,"chain":"a1b2c3d4e5f60718"}'
```

- `namespace`: `[a-z0-9-]{1,64}`; your key is bound to a namespace **prefix** and
  may only pin namespaces under it.
- `rows`: positive integer — the row count at your chain head.
- `chain`: hex string, 8-64 chars — the chain head itself.
- **Monotonic guard:** a pin with `rows` lower than the current latest for that
  namespace is rejected with `409` — a witness never goes backward.
- Success (`201`) returns the stored pin, the GitHub commit sha, and the public
  history URL.

**Free-tier limits are enforced (metering).** Every pin call is checked
against a per-key monthly cap before it commits. Denials never happen
silently:

- `429` (over cap) — headers `X-Meter-Cap` / `X-Meter-Used` and a JSON body
  `{error, reason:"over_cap", plan, used, cap, month}`.
- `401` with `reason:"no_cap_configured"` if a key somehow resolves to no
  cap at all — metering **fails CLOSED**; a misconfigured key is denied,
  never silently treated as unlimited.
- On grant, `X-Meter-Cap` / `X-Meter-Used` are set on the success response
  too, so callers can see how much headroom is left.

Default plan is **free: 100 pins/month**. Per-key overrides (including
explicit unlimited) live in the `WITNESS_PLANS` env var — JSON keyed by
`sha256(key)`, e.g. `{"<sha256 of a key>": {"plan": "internal"}}` (defers
to the built-in `internal` plan, which is unlimited but still counted) or
`{"<sha256 of a key>": {"plan": "free", "monthly_cap": 500}}` (an explicit
per-key cap that wins over any plan default).

This is a hand-written Node port of
[arcaeon-meter](https://github.com/dan8433-user/arcaeon-meter)'s behavior
contract (same denial reasons, same header names, same fail-closed
default) — arcaeon-meter itself is Python + SQLite and can't run inside a
Vercel Node function, so `api/_meter.js` reimplements just the semantics
natively. Usage counts live as one JSON file per key-hash per month in a
**second, PRIVATE** GitHub repo,
[`dan8433-user/arcaeon-witness-usage`](https://github.com/dan8433-user/arcaeon-witness-usage)
— counts are not fingerprints and don't belong in the public pin repo's
commit log.

**Honest CAS race note.** SQLite's `BEGIN IMMEDIATE` (what arcaeon-meter
uses locally) has no equivalent here — there's no shared process between
invocations. The stand-in is the GitHub contents API's compare-and-swap:
read the usage file, check the cap against that read, write with that
read's `sha`. A concurrent writer that lands between the read and the
write makes the write 409 (or, on the file's very first creation, 422
`"sha" wasn't supplied` — same race, different status code, both handled);
the loser re-reads and retries **once**. A third writer landing inside
that retry's own window still fails the request outright (`502`) rather
than silently dropping the count. At Stage-0 traffic (a handful of pins/hour)
this is an acceptable gap, not a hidden one. The real fix, when it's
warranted, is a Stage-2 KV (Vercel KV / Upstash) with an atomic `INCR` and
no CAS loop at all.

### Credit balance — the decrementing balance behind prepaid packs (mechanism only, not yet sold)

Built 2026-08-14 per `COUNCIL_PRICING_REVIEW_2026-08-14.md` §4 decision #5 (the hard
gate): the free-tier meter above resets monthly and can't honestly back a
prepaid, non-expiring per-pin credit promise. This is the mechanism that makes
one real. **Naming the pack sizes here is not the same as selling them** —
`.well-known/offers.json` remains the single source of truth for what's
actually for sale; the pricing cutover is a separate, later step.

- Free 100/mo stays the default and is unaffected: a key that has never
  purchased credits behaves exactly as before this build.
- Once the free monthly cap is spent, a purchased credit balance is the
  additive overflow pool — `api/pin.js` decrements one credit per pin only
  after `over_cap`, never instead of the free tier.
- A key with zero purchased credits still gets `429 over_cap` on overflow
  (unchanged shape, now with `top_up_available` + pack info added).
- A key that bought credits and spent them all gets `402` with
  `reason:"credit_exhausted"` — "insufficient funds," distinct from
  "never had an account." Fails CLOSED either way, never waved through.
- `X-Credit-Balance` / `X-Meter-Source: credit` headers appear on any pin
  funded by the credit balance.

Storage: same private `arcaeon-witness-usage` repo the meter already uses
(`api/_balance.js`), same GitHub-contents-API CAS pattern, plus an
append-only ledger (`ledger/<key_hash>/...`) for every grant and decrement —
a balance you can't audit contradicts this repo's own honesty contract.
Top-up idempotency (**corrected 2026-08-16** — this paragraph described a
mechanism retired 2026-08-14 and had drifted stale): the claim is NOT a
separate ledger flag. `balance/<key_hash>.json` itself carries an
`applied_events` set, and "is this id already applied? / add the pins /
record the id" happen as ONE compare-and-swap against that file's own sha —
a losing concurrent writer re-reads, sees the id already in
`applied_events`, and returns `already_credited:true` without moving the
balance twice. The append-only `ledger/` grant file is still written
afterward as an audit record, but it is no longer the gate. The idempotency
key itself is the Checkout **Session** id when the webhook has one (falling
back to the Stripe event id otherwise) — not the event id alone — because
Stripe's own fulfillment guidance is explicit that a payment can legitimately
generate more than one event (`checkout.session.completed` and
`checkout.session.async_payment_succeeded` for async payment methods like
ACH/Klarna) and a handler must dedupe per-purchase, not per-delivery.
`/api/credit`'s admin path has no session, so it keys on the caller-supplied
`event_id` directly, unchanged.

**POST /api/credit** (Bearer `WITNESS_ADMIN_KEY`) — internal/test top-up path.
Body `{key or key_hash, pack, event_id}`. This is the stand-in for the real
Stripe webhook until it's wired (see below) — same `creditPack()` function
either way.

**POST /api/stripe-webhook** — verifies `checkout.session.completed` AND
`checkout.session.async_payment_succeeded` (the delayed-clear signal for ACH,
Klarna, and other asynchronous payment methods — `checkout.session.completed`
alone reports `payment_status:"unpaid"` for those and is correctly skipped;
the async event carries the actual money) against
`WITNESS_STRIPE_WEBHOOK_SECRET` (Stripe's own HMAC scheme, hand-verified, no
SDK). **Human steps still owed, not done by this build:** (1) create a Stripe
webhook endpoint pointed at this path, subscribed to both event types above
(plus `checkout.session.async_payment_failed`, logged but not credited), and
set its signing secret as `WITNESS_STRIPE_WEBHOOK_SECRET` in Vercel env;
(2) each pack's Stripe Payment Link / Checkout Session needs
`client_reference_id` set to the buyer's `sha256(witness key)` and
`metadata.pack` set to `mini`/`starter`/`standard`/`bulk`. Until both are
done, this endpoint fails closed with `501` on every call — the crediting
logic itself is already built and tested via `/api/credit`.

**GET /api/balance** (Bearer `<your witness key>`) — read-only self-check:
`{credit_balance, credit_ever_purchased, free_tier:{plan, used, cap, month}}`.
Never consumes a pin (reads via `meter.peek()`, not `meter.check()`).

Pack sizes (ratified, not yet offered): Mini $5/1,000 pins · Starter
$15/3,000 pins · Standard $50/12,000 pins · Bulk $150/40,000 pins
(`api/_balance.js` `PACKS`).

### GET /api/latest?ns=&lt;namespace&gt; (no auth)

```bash
curl -s "https://arcaeon-witness.vercel.app/api/latest?ns=velouria-myledger"
```

Returns `{ok, pin, next_pin_due_by, status, cadence_status, cadence_gradeable,
cadence_grade, head_state, overdue_by_seconds?, auth_level, source,
freshness_note, history}`. Primary read path is the GitHub contents API
(commit-fresh); fallback is `raw.githubusercontent.com` with cache-busting,
which in practice can serve stale content for **minutes** (its CDN largely
ignores query-string cache-busters — measured, not folklore). `source` names
which path served the read; the commit history link is always the
authoritative record.

**Cadence deadline (`next_pin_due_by` / `status`).** Every accepted pin
stores `next_pin_due_by = pinned_at + the namespace's declared cadence`
(default **24h**; per-namespace-prefix overrides via the `WITNESS_CADENCE`
env var — JSON `{"<namespace-prefix>": <hours>}`, longest matching prefix
wins). The verdict is computed live at read time, across three
**orthogonal** fields rather than one overloaded one:

| field | values | means |
|---|---|---|
| `cadence_gradeable` | `true` / `false` | can this record be graded against a deadline **at all**? |
| `cadence_status` | `current` / `overdue` / `legacy_no_deadline` | the pure deadline verdict |
| `head_state` | `content_head_advanced` / `publisher_heartbeat_current` | did the content actually move, or did the publisher just renew? |
| `status` | `current` / `publisher_heartbeat_current` / `overdue` / `legacy_no_deadline` | the single combined verdict, for consumers that read one field |

`status` resolves to the **safe** side in both non-obvious cases: a
heartbeat-only namespace is never reported as plain `"current"`, and an
ungradeable record is never reported as passing. `cadence_grade` is the
same verdict in gate vocabulary: `"pass"`, `"fail"`, or
`"cannot_determine"`.

#### Refuse-semantics: `cadence_gradeable:false` is NOT a pass

Owed to **atomic-raven**, whose objection to the first cut of this was exact:
*"a warning that cannot refuse is telemetry, not a control."* The original
`legacy_no_deadline` status printed and armed nothing — every downstream
consumer that gated on cadence still saw an unqualified green light.

A record recorded before the cadence field existed **made no promise**, so no
promise can be graded. That is a refusal to grade, and it is now
machine-readable in three places:

- **`cadence_gradeable: false`** in the JSON body (present as `true` on every
  gradeable read too, so a consumer can gate on its presence without special-casing);
- **`cadence_grade: "cannot_determine"`** — distinct from `"pass"` and `"fail"`;
- **`X-Cadence-Gradeable: false`** response header, so a proxy or gate can
  refuse without parsing the body.

**A consumer gating on cadence MUST treat `cadence_gradeable:false` as
`cannot_determine` and apply its own not-determined policy — fail closed,
alert, or ask a human. It is NOT a pass.** Treating it as one reintroduces
exactly the hole atomic-raven named.

#### Arming a legacy head

Refusing to grade is only half of atomic-raven's objection. The other half is
that the refusal needs an **exit**: a namespace pinned before the cadence field
existed reported `cadence_gradeable:false` forever, and a publisher whose log
had gone quiet re-pinned that same unchanged head and stayed ungradeable with
it. A status with no path out of itself is still telemetry.

So **a bare re-pin of a head that carries no deadline arms the first one.**
Same rows, same chain, no intent, on a legacy head → `201` with
`armed_cadence: true`, and the namespace is under the cadence contract from
that record forward.

This is not the "ask out loud" rule bending. There is no window to extend and
none to launder — the only movement possible is `cannot_determine` → gradeable,
which is strictly *stronger* for a consumer gating on cadence. It is one-time
per namespace (once armed, the head has a deadline and bare re-pins are plain
idempotent no-ops again), it is forward-only, and `had_ungradeable_history:true`
stays on the record permanently, so an armed row can never pass itself off as
having been under contract all along. Graded reads of such a namespace also
carry a `cadence_history_note` saying exactly that.

Nothing is backfilled to make an ungradeable record look graded — no
synthetic deadline is ever written onto a pin that never declared one. A
legacy namespace becomes gradeable again on its **next** pin, renewal, or arm,
and only forward from that moment; the ungradeable stretch stays ungradeable
forever, and `had_ungradeable_history:true` stays on the record permanently so
a later clean-looking row can't hide it. On `/status`, these rows render
hatched amber and labeled **"cadence not gradeable"** — never the neutral grey
that reads as fine — and the page header says `INDETERMINATE`, not `OK`, while
any namespace is ungradeable.

This turns **silence into a stranger-gradeable alarm**: a verifier polling
`/api/latest` sees `"overdue"` in the JSON without trusting our API or our
uptime — the same computation is reproducible from the pin's own
`pinned_at` and the declared cadence. Excelsior's framing, verbatim, from
the review that asked for this: *"the public conflict log says what the
witness saw; the deadline says when absence has become unknowable."*

**Honest scope — this is visibility, not proof.** A missed deadline means a
missed deadline. It does **not** mean tampering: availability and integrity
are distinct properties, and a writer who stops pinning could be dead,
compromised, migrated, or simply done. The deadline makes the *absence of a
promised pin* impossible to miss; it says nothing about *why* the pin
stopped. Pair it with the conflict-observation log (`observations/<ns>/`,
written on a same-rows/different-chain re-mint attempt) for the other half
of the picture — what the witness saw versus when it stopped seeing
anything at all.

### POST /api/renew (deadline-owner key) — publisher heartbeat

```bash
curl -s -X POST https://arcaeon-witness.vercel.app/api/renew \
  -H "Authorization: Bearer $WITNESS_KEY" \
  -H "Content-Type: application/json" \
  -d '{"namespace":"velouria-myledger","rows":42,"chain":"a1b2c3d4e5f60718"}'
```

Owed to **excelsior**, who found the hole and wrote the invariants this
implements. Before this, a namespace whose log *genuinely stopped changing*
went permanently overdue: the idempotent re-pin branch returned the stored pin
untouched, and the deadline only moved when `rows` advanced. A finished log and
an abandoned one looked identical, and there was no way to say "still here,
nothing new."

Renewal says it. The whole design problem is that it must not be launderable
into "and everything is fine," so:

- **The head is restated, never advanced.** `rows` and `chain` must match the
  current head exactly. Mismatched rows → `409 renewal_head_mismatch`. Same
  rows with a *different* chain still takes the conflict-observation path,
  unchanged — a renewal can never stand in for a re-mint attempt.
- **A missed deadline is retained.** If the namespace was overdue when the
  renewal landed, the record keeps `missed_due_at`, `first_missed_due_at`,
  `missed_deadline_count`, `ever_missed_deadline:true` and an entry in
  `missed_deadlines[]`. **Renewal moves the deadline; it never erases the fact
  that one was missed.** Neither does a later content advance — the same
  append-only history code runs on both write paths, so a namespace that
  recovers still shows the miss on every future read and on `/status`.
- **The new deadline is an appended interval, not a rewrite.** Each renewal
  appends an `intervals[]` object `{seq, kind, opened_at, cadence_hours,
  due_by, supersedes_due_by, superseded_deadline_was_missed}`. The superseded
  window stays readable in the record. The most recent 20 intervals and misses
  are inlined; the complete series is the per-seq record history in the public
  pin repo, which is authoritative.
- **A heartbeat is typed differently from an advance.** The record carries
  `record_kind: "publisher_heartbeat"` vs `"content_head_advance"`;
  `/api/latest` surfaces that as `head_state: "publisher_heartbeat_current"` vs
  `"content_head_advanced"`, and `status` reports `publisher_heartbeat_current`
  rather than `current` so a naive `status === "current"` gate does **not** pass
  a namespace whose content never moved.
- **The staleness is measurable, not just labeled.** `head_first_seen_at` (when
  this exact head was first witnessed) is never moved by a renewal, so
  `/api/latest` returns `content_unchanged_for_seconds` and
  `renewals_since_advance` — the numbers that expose a log "kept current" for
  months without producing a single row.
- **A renewal creates a new numbered record** (`pins/<ns>/<seq>.json`) and a new
  commit, exactly like a pin. Renewals are metered like pins, because they cost
  the same two commits.
- **A bare re-pin still does nothing to an existing deadline.** Without an
  explicit renew intent, same-rows/same-chain on a head that already carries a
  deadline returns the same idempotent `200` it always did. *Refreshing* a
  deadline has to be asked for out loud. `POST /api/pin` with
  `"intent":"renew"` is equivalent; `/api/renew` is the same handler with the
  intent stamped on. An unrecognized `intent` value is a `400`, never a silent
  fallthrough to the plain-pin path. The one exception is *arming the first*
  deadline on a legacy head — see "Arming a legacy head" below, where there is
  no window to refresh and nothing that can be laundered.
- **A deadline write requires the namespace's deadline-owner key.** The first
  key to renew or arm a namespace binds itself as that namespace's deadline
  owner in `owners/<namespace>.json`; every later renewal or arm must present
  that same key, or it is `403 not_deadline_owner` and writes nothing. The
  namespace-prefix gate alone is not enough here, because issued prefixes can
  overlap. This is bearer-key *continuity*, **not** owner-signature auth — a
  stolen key still renews (see "Auth honesty" below). Content advances are
  unaffected: they remain governed by the prefix gate exactly as before.

#### Auth honesty — bearer now, owner-signature is Stage-1 and NOT built

**`auth_level: "bearer-stage0"`** appears on every write response, in every
stored record, and on every `/api/latest` read. It means exactly this, and the
same sentence ships in the API responses themselves (`auth_note`):

> Bearer-key auth only. This is NOT owner-signature auth: the witness verifies
> that the caller holds a key bound to this namespace prefix, not that the
> log's owner authorized this record. Anyone who obtains the key can pin or
> renew. Owner-signature auth — a detached signature over `{namespace, rows,
> chain, timestamp}` verified against a public key registered to the namespace
> — is the Stage-1 requirement and is NOT built yet. Read
> `publisher_heartbeat_current` as proof that a key-holder was alive and
> asserting nothing changed, never as proof of the log owner's intent.

Renewal is the write where this matters most: a leaked bearer key can keep a
namespace looking alive indefinitely without the owner's involvement. That is a
real, currently-unclosed gap in Stage-0, named here rather than papered over.

The deadline-owner binding above narrows it without closing it, and the
difference is worth stating plainly. It closes *the other key* — a second
issued key whose prefix happens to cover this namespace can no longer renew or
arm its deadline, because `owners/<namespace>.json` names which key may. It
does **not** close *the stolen key*: whoever holds the bound key is still
indistinguishable from the owner, because a bearer key is all the witness ever
checks. Only Stage-1's detached owner signature closes that, and it is still
not built.
We are not claiming owner-auth. When Stage-1 lands, `auth_level` becomes
`"owner-signature"` on records that carry one, and the two will be
distinguishable in the public repo record-by-record — including retroactively,
because every record written before then says `bearer-stage0` in its own text.

### GET /api/verify?ns=&lt;namespace&gt;&rows=&lt;n&gt;&chain=&lt;hex&gt; (no auth, no metering)

One-call public proof-of-inclusion: "does this exact head exist in the
witness record?" `digest` is accepted as an alias for `chain` (both may be
given only if they agree). No auth and no metering on purpose — this is a
funnel and a trust surface, not a write path, and it can't leak anything a
stranger couldn't already read by cloning the public pins repo directly.

```bash
curl -s "https://arcaeon-witness.vercel.app/api/verify?ns=velouria-canon&rows=5&chain=fe40dd197dabe3db58341e8f54524a38"
```

```json
{
  "ok": true,
  "witnessed": true,
  "pin": { "namespace": "velouria-canon", "rows": 5, "chain": "fe40dd...", "seq": 4, "...": "..." },
  "seq": 4,
  "pinned_at": "2026-08-14T21:30:44.225Z",
  "is_current_head": true,
  "raw_record_url": "https://raw.githubusercontent.com/dan8433-user/arcaeon-witness-pins/main/pins/velouria-canon/00000004.json",
  "history": "https://github.com/dan8433-user/arcaeon-witness-pins/commits/main/pins/velouria-canon",
  "cadence_gradeable": true, "cadence_status": "current", "cadence_grade": "pass", "...": "..."
}
```

`raw_record_url` is a direct `raw.githubusercontent.com` link — the point is
a caller can confirm the pin **without trusting this API at all**, by
fetching that URL themselves. Cadence fields (`cadence_gradeable`,
`cadence_status`, `cadence_grade`, `head_state`, etc.) come from the exact
same `store.computeCadenceFields` function `/api/latest` uses (extracted
from it), so the two endpoints grade a pin identically.

**Scope.** The submitted `(rows, chain)` is checked first against the
namespace's *current* head (one read — "is my log witnessed right now?",
the common case). If it doesn't match the current head and the requested
`rows` is *lower* than the current head's `rows`, a bounded backward scan
over the namespace's numbered records looks for a historical match — a
same-rows/different-chain conflict is never written into `pins/` (it's
rejected and logged to `observations/` instead, see `POST /api/pin`), so
within `pins/` a given `rows` value has at most one accepted chain, and
finding `rows === target` there is conclusive. The scan is capped at 50
records (`MAX_HISTORY_SCAN` in `api/verify.js`) — this bounds this repo's
shared GitHub API budget per unauthenticated call, not the caller's usage.
A scan that exhausts the cap without an answer says so honestly
(`reason:"scan_bound_reached"`) rather than guessing.

Miss reasons: `no_pin_recorded_for_namespace`, `rows_match_chain_mismatch`
(a record exists at that rows count with a *different* chain — not the
accepted head), `exceeds_current_head` (rows is ahead of what's been
witnessed), `rows_never_witnessed` (that rows count was skipped by an
advance and was never itself a head), `not_found_in_history` /
`scan_bound_reached` (bounded backward scan exhausted). Every response is
HTTP `200` — `witnessed:true/false` is the signal, not the status code, the
same way this is a yes/no question, not a resource fetch.

A historical (superseded) match sets `is_current_head:false` and its
cadence fields describe that old record, not the namespace's live status —
read `is_current_head` before reading `cadence_status` on a hit.

### GET /api/status.json (no auth)

Machine-readable twin of `GET /status` — same underlying data (both call
`api/_status_data.js`'s `gatherStatusData()`, so they can't drift apart),
rendered as a stable JSON schema instead of an HTML table.

```bash
curl -s https://arcaeon-witness.vercel.app/api/status.json
```

```json
{
  "ok": false,
  "status": "indeterminate",
  "rendered_at": "2026-08-15T01:36:57.267Z",
  "store": {"kind": "public-github-repo", "repo": "dan8433-user/arcaeon-witness-pins", "branch": "main", "reachable": true},
  "summary": {"namespaces": 7, "current": 2, "heartbeat_only": 0, "overdue": 0, "not_gradeable": 5, "ever_missed_deadline": 0, "conflicts_observed": 1},
  "namespaces": [ {"namespace": "velouria-canon", "rows": 5, "chain": "fe40dd...", "status": "current", "cadence_gradeable": true, "...": "..."} ],
  "conflict_observations": {"count": 1, "sample": ["..."]},
  "anchor": {"date": "2026-08-14", "hasOts": true, "...": "..."},
  "errors": {"namespace_listing": null, "observations": null, "anchor": null, "health": null}
}
```

`status` is `"ok"` / `"degraded"` / `"indeterminate"` — the same three-state
verdict `/status`'s header badge shows (`indeterminate` means every
namespace is either current or merely ungradeable, never overdue or
erroring — see the refuse-semantics section above). `cache-control: no-store`;
this reads live at request time same as every other endpoint here.

**Independent cadence math, on purpose.** `/status`, `/api/status.json`, and
`/api/badge` all share ONE data-gathering pass (`gatherStatusData()`), but
that pass computes cadence with its own reimplementation
(`_status_data.js`'s `cadenceStatus()`) — **not** `store.computeCadenceFields`,
the function `/api/latest` and `/api/verify` share. This is the same
deliberate duplication `/status` always carried (a bug in one computation
can't silently take the whole trust surface down at once, and a stranger
diffing `/api/status.json`'s per-namespace `status` against a raw
`/api/latest?ns=<ns>` call is comparing two independent implementations of
the same public rule) — the refactor just factored it so the status family
shares one copy of its independent logic instead of each hand-copying it.

### GET /api/badge (no auth)

Shields.io-compatible [endpoint badge](https://shields.io/badges/endpoint-badge).
Point a shields.io badge URL at it and it renders live:

```bash
curl -s https://arcaeon-witness.vercel.app/api/badge
```

```json
{"schemaVersion": 1, "label": "witness", "message": "indeterminate · 7 ns · 0 overdue", "color": "yellow", "cacheSeconds": 120}
```

Markdown for a README:

```markdown
![witness status](https://img.shields.io/endpoint?url=https://arcaeon-witness.vercel.app/api/badge)
```

![witness status](https://img.shields.io/endpoint?url=https://arcaeon-witness.vercel.app/api/badge)

Color: green when every namespace is `ok` (current or heartbeat, none
overdue, none ungradeable), yellow when `indeterminate` (nothing overdue,
but at least one namespace has no gradeable deadline), red when `degraded`
(store unreachable, a namespace read failed, or anything is overdue). Same
`gatherStatusData()` pass as `/status` and `/api/status.json` — the badge
can't say "ok" while the page says otherwise.

### GET /api/health (no auth)

```bash
curl -s https://arcaeon-witness.vercel.app/api/health
```

Returns `{ok, service, store}` with a live reachability check of the pin repo.

## Trust model — what this proves, and what it does not

**Proves:** the operator of THIS witness saw your head `(rows, chain)` at time T.
Once that pin is public, no later rewrite of your log can both differ from the
pin and still verify — a truncated log has fewer rows than the witness saw; a
rewritten one has a different chain at the witnessed row.

**A stranger verifies without trusting our API:** the pins live in a public
GitHub repo. Anyone can read `pins/<namespace>/` and the commit timestamps
directly from GitHub and run the check themselves. The API is a convenience; the
repo history is the evidence. If we tampered with pins, the rewrite would show
in the repo's own history (force-push divergence visible to anyone who cloned).

**Does NOT prove:**

- that your logged content is *true* — the witness sees fingerprints, not facts;
- anything about the window since the last pin — the MAX gap between pins is your
  real security parameter (an attacker picks the gap);
- independence from GitHub — GitHub's timestamps are the third-party clock; if
  you need stronger anchoring, cross-pin to a second witness.

## Anchoring (OpenTimestamps counter-anchor)

GitHub's clock is the first witness; Bitcoin's is the second. Once a day an
automated job records the pin repo's HEAD commit hash to
`anchors/<date>-head.txt` (`<sha> <iso-timestamp>`) in
[`dan8433-user/arcaeon-witness-pins`](https://github.com/dan8433-user/arcaeon-witness-pins)
and stamps that file with [OpenTimestamps](https://opentimestamps.org),
committing the resulting `.ots` proof alongside it. Because each anchor lands
in the repo itself, the witness is self-escrowing: force-rewriting pin history
would also have to erase or fake proofs whose hashes are already anchored in
the Bitcoin blockchain.

Verify an anchor yourself — no trust in the repo's owner required:

```bash
pip install opentimestamps-client
ots verify anchors/<date>-head.txt.ots
# then confirm the sha inside the .txt is a real commit in the pin repo:
git log --format=%H | grep <sha-from-the-txt>
```

A fresh proof reads "Pending confirmation in Bitcoin blockchain" — that is
normal: `ots stamp` collects calendar-server attestations immediately, and the
Bitcoin attestation follows once the calendar's merkle root is committed to a
block (the job upgrades the previous day's proof automatically). After the
upgrade, `ots verify` reports the block height and time.

Honest scope: an anchor proves the pin repo's HEAD — and therefore every pin
beneath it — **existed by time T**. It does NOT prove any pin's contents are
true, complete, or honestly produced; only that they were not fabricated after
the fact. Each day's anchor covers all history through the previous day's
anchor commits, forming a chain.

## Stage-0 limits

- Single region, single operator, no SLA.
- GitHub API rate limits bound pin throughput (~5000 authed requests/hour, 2
  commits per pin); the per-key rate limiter is a naive per-instance counter
  that resets on cold starts.
- `latest` reads are commit-fresh via the contents API, but the raw-CDN
  fallback can lag minutes; the repo history is the source of truth either way.
- Two commits per pin (`<seq>.json` + `latest.json`) are not atomic; a crash
  between them self-heals on the next pin (seq derives from `latest.json`).
- Metering's CAS increment retries once on conflict; a three-way race on the
  same key in the same instant can still fail a request outright (`502`)
  rather than silently under-count it — see the metering section above.
- **Renewal is bearer-authorized, not owner-signed.** A leaked key can keep a
  namespace's deadline alive without the owner's involvement. `auth_level:
  "bearer-stage0"` says so on every record and every read; owner-signature auth
  is the Stage-1 requirement and is not built. See "Auth honesty" above.
- **Renewal cannot prove the publisher is honest, only that a key-holder is
  responsive.** `publisher_heartbeat_current` plus `content_unchanged_for_seconds`
  is the honest pair: alive, not active. A witness still cannot tell a finished
  log from a suppressed one — it can only stop the two from looking identical.
- **Credit balance: observed, not just theoretical, read-after-write lag.**
  In testing (2026-08-14), a `GET` on `balance/<key_hash>.json` immediately
  after the `PUT` that created it occasionally returned 404 (not-found)
  rather than the just-written content -- reproduced once in about six runs,
  not reliably reproducible in isolation, consistent with an occasional
  GitHub contents-API propagation gap rather than a bug in this code.
  Effect: a pin request landing in the same instant as its own credit
  top-up could see `ever_purchased:false` and get a `429` instead of being
  covered by the credit that, in reality, already landed. This does not
  overcharge or double-credit -- the failure mode is "denied a pin you
  should have had," not "billed twice" -- but it is a real Stage-0 gap,
  named here rather than assumed away. The Stage-2 fix is the same one
  metering already names: a real KV with atomic reads, not the contents
  API's eventual-consistency window.

## Layout

```
api/pin.js            POST /api/pin       — auth, validate, metering, credit decrement, monotonic guard, commit
api/renew.js          POST /api/renew     — publisher heartbeat: refresh the deadline, never claim an advance (thin wrapper over pin.js); deadline-owner gated
api/latest.js          GET /api/latest    — public read via raw + cache-busting
api/verify.js           GET /api/verify   — one-call public proof-of-inclusion (no auth, no metering)
api/health.js           GET /api/health   — live store reachability
api/status.js            GET /status      — public trust-surface page
api/status.json.js       GET /api/status.json — machine-readable twin of /status
api/badge.js             GET /api/badge   — shields.io-compatible uptime badge
api/balance.js           GET /api/balance — key-holder's own credit + free-tier read (auth'd, read-only)
api/credit.js           POST /api/credit  — internal/admin credit top-up (Bearer WITNESS_ADMIN_KEY)
api/stripe-webhook.js   POST /api/stripe-webhook — real top-up path (501 until WITNESS_STRIPE_WEBHOOK_SECRET is set)
api/_store.js   shared GitHub-contents-API store for the PUBLIC pin repo (not routed); also holds computeCadenceFields, the cadence-grading function api/latest.js and api/verify.js share
api/_status_data.js shared data-gathering pass behind /status, /api/status.json, and /api/badge (not routed); carries its own deliberately-independent cadence reimplementation, see its module comment
api/_meter.js   per-key monthly usage caps against the PRIVATE usage repo (not routed)
api/_balance.js per-key decrementing credit balance + ledger against the PRIVATE usage repo (not routed)
```

Plain Node 18+ serverless functions. No dependencies. No tokens in this repo —
`GITHUB_PIN_TOKEN`, `WITNESS_KEYS`, `WITNESS_PLANS`, `WITNESS_CADENCE`,
`WITNESS_ADMIN_KEY` (set 2026-08-14), and `WITNESS_STRIPE_WEBHOOK_SECRET`
(**not yet set — human step**) live only in Vercel env vars. `GITHUB_PIN_TOKEN` is reused for both the
public pins repo and the private usage repo — same account, same token, two
repos. `WITNESS_CADENCE` is optional (default cadence is 24h for every
namespace when unset or malformed) and holds no secrets, but lives with the
others for one reason: it's operational policy, not code — changing it
shouldn't require a redeploy.

## Testing

`npm test` (or `node --test "test/*.test.js"`) — a no-framework harness on
`node:test`, zero external dependencies. `test/helpers/mock_store.js` fakes
the GitHub contents API's compare-and-swap contract in memory (sha match,
create-race 422, update-race 409) so every handler runs its real code path
against a fake store, never the live public/private repos. Covers
`_balance.js`, `_meter.js`, `_store.js`, `stripe-webhook.js`, `pin.js`, and
`verify.js`, with named regressions for every bug this weekend's audits
found (the `applied_events`-dropped-on-decrement money bug, the double-grant
CAS race, `ddee22a`'s legacy-deadline arming, excelsior's owner-binding
403) plus contract tests for the pack catalogue, credit exhaustion, and the
webhook's signature/payment/livemode gates. See
`test/*.test.js` file headers for what each regression is guarding and why.
