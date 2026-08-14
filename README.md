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

## Stage-0 limits

- Single region, single operator, no SLA.
- GitHub API rate limits bound pin throughput (~5000 authed requests/hour, 2
  commits per pin); the per-key rate limiter is a naive per-instance counter
  that resets on cold starts.
- `latest` reads are commit-fresh via the contents API, but the raw-CDN
  fallback can lag minutes; the repo history is the source of truth either way.
- Two commits per pin (`<seq>.json` + `latest.json`) are not atomic; a crash
  between them self-heals on the next pin (seq derives from `latest.json`).

## Layout

```
api/pin.js      POST /api/pin     — auth, validate, monotonic guard, commit
api/latest.js   GET  /api/latest  — public read via raw + cache-busting
api/health.js   GET  /api/health  — live store reachability
api/_store.js   shared GitHub-contents-API store (not routed)
```

Plain Node 18+ serverless functions. No dependencies. No tokens in this repo —
`GITHUB_PIN_TOKEN` and `WITNESS_KEYS` live only in Vercel env vars.
