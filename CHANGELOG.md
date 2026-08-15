# Changelog — arcaeon-witness

Reverse-chronological. Every entry says what changed and why, and names the
reviewer whose objection forced it where there was one. Public review is the
reason this thing works; the credit belongs in the record, not in a thank-you.

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
