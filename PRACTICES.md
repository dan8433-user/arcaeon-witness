# Arcaeon Witness Practices Statement

**v1.2 · effective 2026-08-15 · applies to** `arcaeon-witness.vercel.app` **and its backing repos**
[`arcaeon-witness-pins`](https://github.com/dan8433-user/arcaeon-witness-pins) (public) and
`arcaeon-witness-usage` (private, metering only).

This is the CA/Browser-Forum-BR-§8.1 analog for a zero-history operator: no track record to point
to, so here is exactly what we promise instead — in writing, dated, and falsifiable. The industry
precedent for trusting a young verifier on *promises + falsifiability* rather than *institutional
age* is Certificate Transparency (logs are called **untrusted** in the RFC itself) and Let's
Encrypt (bootstrapped on a published practices statement, not a track record). We're playing the
same game, at solo-operator scale.

**Who operates this.** One person (the Architect, sole proprietor, Arcaeon), one AI collaborator
(Velouria/Nora) who writes the code and this document. No company behind it. No SLA in the
legal-contract sense — see Stage-0 limits below, unchanged from the README, restated here because
a practices statement that hides its own limits isn't one.

---

## 1. What the witness does

You send us `(namespace, rows, chain)` — a hash-chain head from your own log. We commit it,
as-is, to a public GitHub repository, and hand back the commit. That's the entire mechanism. A
later reader can ask "what did the witness see, and when" and get an answer they don't have to
trust us for, because the answer lives in a public git history with GitHub's own commit
timestamps, not in a database only we can read.

## 2. What we store — fingerprints, never content

Every pin is exactly: `{namespace, rows, chain, pinned_at, seq, cadence_hours,
next_pin_due_by}` plus, since 2026-08-14, the cadence bookkeeping that makes a renewal
honest — `{record_kind, head_first_seen_at, renewals_since_advance, renewals_total,
auth_level, auth_note, intervals[], intervals_total, missed_deadlines[],
missed_deadline_count, ever_missed_deadline, missed_due_at?, first_missed_due_at?,
had_ungradeable_history?}` (§5). That is the complete schema: every added field is a
timestamp, a counter, a type tag, or our own auth caveat. **Not one of them derives from
your log's content.** We never receive, request, or store:

- the content of your log rows,
- any artifact your log references,
- anything that would let a breach of our store reconstruct your data.

"Password nowhere": if the pin repo leaked in full tomorrow, an attacker would have hashes and
row counts, useless without your log to match them against. Usage-metering counts (how many pins
a key has used this month) live in a **separate, private** repo — they're operational data, not
fingerprints, and don't belong in the public commit log either.

## 3. What a pin proves, and what it does not

**Proves:** the witness saw your head `(rows, chain)` at time T (GitHub's commit timestamp — a
clock we don't control). Once public, no later version of your log can both differ from that pin
and still verify: fewer rows than we witnessed is a truncation; a different chain at the witnessed
row is a rewrite.

**Does not prove — named plainly, not buried:**

- **Anything about the window since the last pin.** A witness only sees what you send it, when
  you send it. Truncation *relative to the last pin* is caught; truncation-and-repin inside the
  gap is not, by construction — **the maximum gap between pins is your real security parameter,
  not the existence of a witness.** A cadence promise (§5) narrows that gap; it does not close it.
- **That your logged content is true.** We witness a fingerprint. A hash chain notarizes a
  hallucination exactly as faithfully as a fact — content truth is out of scope for this tool by
  design, not by oversight.
- **Availability, from integrity.** These are different properties. A namespace that stops
  pinning could be tampered with, or its operator could be dead, migrated, compromised, or simply
  done with the project. §5's cadence deadline makes the *silence* visible. It cannot and does not
  distinguish *why* the silence happened.
- **Independence from GitHub**, on its own. GitHub's commit clock is the first witness. §6
  describes the second (Bitcoin, via OpenTimestamps) — cross-anchoring exists specifically because
  one clock alone is a trust concentration, not a proof.

## 4. Service promises (the SLO section)

Modeled on Certificate Transparency's own bar for what a young, unaccountable-by-institution log
commits to — CT's own precedent is forgiving at solo scale (roughly a 99%-over-90-days
availability norm), and we're not claiming more than that shape affords:

- **Availability target: 99% over any trailing 90 days**, measured against `GET /api/health`.
  Honest gap, named rather than hidden: we do not yet run independent third-party uptime
  monitoring — today this is a declared target you can audit yourself by polling `/api/health` on
  your own cadence, not a number we're already publishing from a monitor. That's the next
  instrument to build, not a claim we're making early.
- **Pin latency: no separate merge delay.** Unlike CT's Maximum Merge Delay (a promise about how
  long an accepted-but-not-yet-logged item can sit before inclusion), `POST /api/pin` commits
  synchronously — a `201` response means the commit already landed in the public repo, in the
  same request. The one documented gap: the pin's own two commits (per-seq file, then
  `latest.json`) aren't atomic with each other; a crash between them self-heals on the next pin
  (README, "Stage-0 limits").
- **Key custody:** a single GitHub personal-access token, held only in Vercel environment
  variables, never in this repo, reused across the public pins repo and the private usage repo
  (same account). No HSM, no key-rotation schedule published yet, single operator holds it. That
  is a real single point of failure at Stage-0 and we're not dressing it up as anything else.
- **Incident disclosure — pre-committed, before an incident, not after:**
  - Any provable inconsistency (a pin that doesn't match its own commit, a rewritten history, a
    cadence-deadline miscalculation, metering that under- or over-counted) gets **disclosed
    within 72 hours** of confirmation.
  - Disclosure is a **public postmortem** — what happened, what it affected, what changed —
    posted to this repo's README/CHANGELOG and to the same public channels the "greatest hits"
    review table already uses (The Colony, Moltbook), not a quiet fix.
  - **Self-freeze on provable inconsistency:** the affected key is revoked from `WITNESS_KEYS`
    and the affected namespace's writes are held pending investigation. This is a manual
    operator action today (Stage-0, one person), not yet an automated kill switch — named
    honestly rather than implied to be more automatic than it is.

## 5. Cadence deadline — silence as a gradeable signal

Every accepted pin stores `next_pin_due_by = pinned_at + the namespace's declared cadence`
(default 24h; overridable per namespace-prefix via `WITNESS_CADENCE`). `GET /api/latest` computes
`status` live: `"current"`, `"publisher_heartbeat_current"`, `"overdue"` (with
`overdue_by_seconds`), or `"legacy_no_deadline"` for pins recorded before this field existed.

**A record that declared no deadline is not graded, and not passed.** Legacy pins return
`cadence_gradeable:false` / `cadence_grade:"cannot_determine"` (and an `X-Cadence-Gradeable`
header), and `/status` renders them hatched amber and labeled "cadence not gradeable" rather
than in the neutral grey that reads as fine. A consumer gating on cadence **must** treat that as
cannot-determine, never as a pass. We do not backfill deadlines onto records that never made a
promise; the ungradeable stretch stays ungradeable permanently
(`had_ungradeable_history:true`), and a namespace becomes gradeable only forward, from its next
pin, renewal, or arm. **The refusal has an exit:** a bare re-pin of a head that carries no
deadline arms the first one (`201`, `armed_cadence:true`), one-time per namespace and
forward-only, so a quiet legacy publisher is not stuck reporting cannot-determine forever. The
only movement that creates is cannot-determine → gradeable, which is strictly stronger for the
consumer; nothing before that record is graded. (atomic-raven's objection, which this answers:
*"a warning that cannot refuse is telemetry, not a control."*)

**A publisher who is alive but quiet can renew, and it is never laundered into activity.**
`POST /api/renew` refreshes the deadline for an unchanged head. The renewal is typed
(`record_kind:"publisher_heartbeat"` → `head_state:"publisher_heartbeat_current"`), appends a new
interval rather than rewriting the old one, and **retains any missed deadline permanently** —
`missed_due_at` and `ever_missed_deadline` survive every later renewal and every later content
advance, and are shown on `/status` even for a namespace that is healthy again. **A deadline
write must come from that namespace's deadline-owner key**: the first key to renew or arm binds
itself in the public `owners/<namespace>.json`, and any other key — including one whose issued
namespace-prefix covers it — gets `403 not_deadline_owner` and writes nothing. That is still
**bearer-key** auth (`auth_level:"bearer-stage0"`): it closes the *other* key, not the *stolen*
one, and it proves a key-holder was responsive, not that the log's owner authorized anything.
Owner-signature auth is the Stage-1 requirement and is not built. (excelsior's invariants, which
this implements.)

This is the mechanism that turns an absence of pins into something a stranger can grade without
asking us: poll `/api/latest`, read `status`. No trust in our honesty required — the computation
(`now` vs. a deadline derived from the pin's own recorded `pinned_at` and declared cadence) is
reproducible by anyone.

**Restated because it matters:** the deadline says a promise was missed. It does not say why.
*"The public conflict log says what the witness saw; the deadline says when absence has become
unknowable."* (excelsior, whose review asked for exactly this instrument.)

## 6. Anchoring — the witness watching itself

The pin repo's own history is rewritable by anyone with write access to it (us). So once a day an
automated job records the pin repo's HEAD commit hash and stamps it with
[OpenTimestamps](https://opentimestamps.org) — a free, third-party, Bitcoin-blockchain timestamp
— committing the proof back into the same repo. Verify without trusting us:

```bash
pip install opentimestamps-client
git clone https://github.com/dan8433-user/arcaeon-witness-pins
ots verify anchors/<date>-head.txt.ots
```

Honest scope: an anchor proves the pin repo's HEAD **existed by time T**. It does not prove any
pin's *contents* are true, complete, or honestly produced — only that they weren't fabricated
after the fact.

## 7. Conflict-observation log

A same-`rows`-different-`chain` submission (the re-mint signature: someone claiming a different
history at a row count we already witnessed) never silently overwrites the accepted head. It's
rejected (`409`) **and** appended to `observations/<namespace>/<timestamp>.json` in the public
repo — an append-only record of every detected conflict attempt, kept even though the attempt
failed, so the failure itself is part of the public record and can't quietly disappear.

## 8. Standing challenge — break this

We'd rather a real attacker find a real gap and get credited publicly than have no one try. This
challenge is standing, not a one-time event, and it works the same way the public review that
shipped `arcaeon-ledger`'s external-witness feature already worked (see `ai.html`'s "greatest
hits" table — that table is the actual track record this statement can't yet claim on its own).

**No credentials needed — attack the public record itself:**

- Try to show `GET /api/latest` can be made to disagree with the raw commit history at
  `github.com/dan8433-user/arcaeon-witness-pins/commits/main/pins/<namespace>` for the same
  namespace at the same moment.
- Try to defeat the OpenTimestamps anchor — forge a `.ots` proof that `ots verify` accepts for a
  HEAD commit that was never actually that repo's HEAD.
- Try to make `next_pin_due_by` or `status` lie relative to what's recoverable from the pin's own
  `pinned_at` and the declared cadence — e.g., get `/api/latest` to report `"current"` for a
  namespace that's genuinely missed its deadline.
- Try to get a **legacy** record graded as a pass: `cadence_gradeable:true` or
  `cadence_grade:"pass"` on a record that never declared a deadline, or find a
  deadline we backfilled onto one that didn't have one.
- Try to **launder a renewal into an advance**: get `/api/latest` to report
  `head_state:"content_head_advanced"` (or plain `"current"`) for a namespace whose head never
  moved, or get any write — renewal or advance — to erase `missed_due_at` /
  `ever_missed_deadline` from a namespace that genuinely missed a deadline, or to rewrite an
  existing `intervals[]` entry instead of appending a new one.

**Needs a scoped write key — attack the accept path:** email **hello@arcaeon.io** for a free
demo key bound to a `breakthis-<your-handle>-` namespace prefix (capped low, revocable on sight).
With it, try to:

- push a pin with `rows` lower than the current latest (should `409`, monotonic guard, README
  §"Monotonic guard"),
- push a same-`rows`/different-`chain` pin (should `409`, land in `observations/`, accepted head
  unchanged — §7 above),
- get two pins to disagree about `seq` or leave the `pins/<ns>/latest.json` and
  `pins/<ns>/<seq>.json` records inconsistent with each other after a forced mid-request failure.

**What we'll do with a validated break:** disclose it per §4's incident policy (72h, public
postmortem), fix it, and credit the finder by name in this document's changelog and in the same
public channels the existing review table draws from. **The bounty is reputational credit, named
in public** — the same currency the seven-agent review that shipped 0.4.0's external witness
already ran on. We don't have a cash bounty program; we're not pretending otherwise.

---

## Changelog

- **2026-08-15 — v1.2.** §5 gains the second half of both review debts: the legacy-head **arm**
  (a bare re-pin of a deadline-less head arms the first deadline — atomic-raven's refusal now has
  an exit) and the **deadline-owner binding** (`owners/<namespace>.json`; renewal and arm require
  the bound key, not merely a prefix-matching one — excelsior's "owner-authorized, not merely
  bearer-authorized", as far as Stage-0 can honestly go).
- **2026-08-14 — v1.1.** §2 schema updated for the renewal bookkeeping (all timestamps, counters
  and type tags — no field derives from log content). §5 gains the two review debts paid the same
  day: **atomic-raven's** refuse-semantics (`cadence_gradeable:false` = cannot-determine, never a
  pass — a warning that can't refuse is telemetry, not a control) and **excelsior's** renewal
  invariants (`POST /api/renew`: retained miss, appended interval, heartbeat typed apart from a
  content advance, bearer-only auth stated as interim). §8 gains two new standing-challenge
  targets for exactly those paths.
- **2026-08-14 — v1.0.** First publication. Companion to the `next_pin_due_by`/`status` cadence
  fields shipped the same day (§5). Written in response to `RESEARCH_28`'s week-1 recommendation
  and excelsior's review point on making pinning silence gradeable.
