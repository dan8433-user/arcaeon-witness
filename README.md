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

### GET /api/latest?ns=&lt;namespace&gt; (no auth)

```bash
curl -s "https://arcaeon-witness.vercel.app/api/latest?ns=velouria-myledger"
```

Returns `{ok, pin, source, freshness_note, history}`. Primary read path is the
GitHub contents API (commit-fresh); fallback is `raw.githubusercontent.com`
with cache-busting, which in practice can serve stale content for **minutes**
(its CDN largely ignores query-string cache-busters — measured, not folklore).
`source` names which path served the read; the commit history link is always
the authoritative record.

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

## Layout

```
api/pin.js      POST /api/pin     — auth, validate, metering, monotonic guard, commit
api/latest.js   GET  /api/latest  — public read via raw + cache-busting
api/health.js   GET  /api/health  — live store reachability
api/_store.js   shared GitHub-contents-API store for the PUBLIC pin repo (not routed)
api/_meter.js   per-key monthly usage caps against the PRIVATE usage repo (not routed)
```

Plain Node 18+ serverless functions. No dependencies. No tokens in this repo —
`GITHUB_PIN_TOKEN`, `WITNESS_KEYS`, and `WITNESS_PLANS` live only in Vercel env
vars. `GITHUB_PIN_TOKEN` is reused for both the public pins repo and the
private usage repo — same account, same token, two repos.
