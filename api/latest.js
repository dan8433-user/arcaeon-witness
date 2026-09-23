// GET /api/latest?ns=<namespace> — the most recent pin for a namespace.
//
// No auth: pins are public by design (that's the point of a public witness).
// Primary read path is the GitHub contents API (authoritative, no CDN lag);
// fallback is raw.githubusercontent with a cache-busting query — measured in
// practice, raw can serve stale content for MINUTES (its CDN largely ignores
// query-string cache-busters), so the response names which source served it
// and always points at the commit history as the authoritative record.
//
// Per-IP rate limit (2026-09-05 audit finding, same shape as api/verify.js's
// — see lib/_ratelimit.js for the honest per-instance limitation). This
// endpoint was unauthenticated AND unlimited: it shares GITHUB_PIN_TOKEN with
// every paying customer's /api/pin write, and GitHub's contents API rate
// limit (~5000 authed requests/hour, per README) is a budget the WHOLE
// service draws from, reads included. A free, unlimited read endpoint that
// spends the same shared budget as the money path is a way to deny paying
// customers without ever touching a key — this closes it the same way
// verify.js already was.

"use strict";

const store = require("../lib/_store.js");
const verdict = require("../lib/_verdict.js");
const ratelimit = require("../lib/_ratelimit.js");

const HISTORY_BASE = `https://github.com/${store.REPO}/commits/${store.BRANCH}`;

module.exports = async (req, res) => {
  // HEAD is a read and must answer like one. Uptime monitors and link checkers
  // default to HEAD; 405-ing them reports this endpoint as DOWN while it is in
  // fact serving 200. /api/health and /status never had this guard and always
  // answered HEAD correctly — these read endpoints now match them. Node drops
  // the body from a HEAD response on its own, so the handler needs no branch.
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.setHeader("allow", "GET, HEAD");
    return res.status(405).json({ error: "GET or HEAD only" });
  }

  const rl = ratelimit.check(req);
  if (rl.limited) {
    res.setHeader("retry-after", String(rl.retryAfterSeconds));
    res.setHeader("cache-control", "no-store");
    return res.status(429).json({
      ok: false,
      error: "rate limit exceeded",
      note: `naive per-instance, per-IP limiter (Stage-0): ~${rl.limit} calls per IP per ${Math.round(rl.windowSeconds / 60)} minutes`,
      retry_after_seconds: rl.retryAfterSeconds,
    });
  }

  const ns = (req.query && req.query.ns) || "";
  if (!store.NS_RE.test(ns)) {
    return res.status(400).json({ error: "ns must match [a-z0-9-]{1,64}" });
  }

  const path = `pins/${ns}/latest.json`;
  let pinRead; // deliberately NOT initialised: undefined makes judgePin throw, so no road reaches a 200 without a read
  let source, note;
  let unparseable = false;

  // Primary: contents API — commit-fresh, no CDN cache.
  try {
    pinRead = await store.getFile(path); // null = the store's 404, and only that
    source = "github-contents-api";
    note = "read via the GitHub contents API (commit-fresh)";
  } catch (primaryErr) {
    // The fallback below is for a contents API that could not be REACHED. A
    // file that was reached and is not JSON is a different event: that is the
    // commit-fresh truth, and falling back from it to a CDN that may still be
    // serving the last good copy would answer 200 over a head that is, right
    // now, damaged. So a parse failure is a red verdict and goes nowhere else.
    if (primaryErr instanceof SyntaxError) unparseable = true;
  }
  if (pinRead === undefined && !unparseable) {
    // Fallback: raw CDN with cache-buster. Honest note: raw can lag well
    // beyond the folk ~60s — the repo history is the source of truth.
    try {
      const r = await fetch(
        `https://raw.githubusercontent.com/${store.REPO}/${store.BRANCH}/${path}?cb=${Date.now()}`,
        { headers: { "cache-control": "no-cache" } }
      );
      if (!r.ok && r.status !== 404) {
        return res.status(502).json({ error: `pin store read failed: ${r.status}` });
      }
      pinRead = r.status === 404 ? null : { json: await r.json(), sha: null };
      source = "raw.githubusercontent";
      note = "served from the raw CDN, which can lag minutes behind the newest commit";
    } catch (err) {
      return res.status(502).json({ error: `pin store read error: ${err.message}` });
    }
  }

  // --- cadence-deadline status (excelsior's review) ---
  // "The public conflict log says what the witness saw; the deadline says
  // when absence has become unknowable." A verifier polling this endpoint
  // sees "overdue" without trusting our API — silence becomes a
  // stranger-gradeable alarm. This is visibility, not proof: a missed
  // cadence could mean tampering, or could mean the writer is dead,
  // compromised, or just done (availability and integrity are distinct).
  //
  // Extracted into store.computeCadenceFields (2026-08-14, board item 20) so
  // api/verify.js grades a pin exactly the same way this endpoint does —
  // this call is a pure extraction, output is unchanged from before.
  //
  // The verdict comes first (lib/_verdict.js). A latest.json that is present
  // but is not a pin record used to fall through every typeof-guard in
  // computeCadenceFields and come out as 200 ok:true status:"legacy_no_deadline"
  // — a damaged head wearing the costume of an old one. It is a 503 now, and
  // the success body below cannot be built without the green verdict in hand.
  const HEAD = { what: `pins/${ns}/latest.json` }; // lib/_verdict.js rule 6
  const pinVerdict = unparseable
    ? verdict.red(HEAD.what, "not_json")
    : verdict.judgePin(pinRead, { what: HEAD.what, namespace: ns });
  if (verdict.isEmpty(pinVerdict, "latest", HEAD)) {
    // The one legitimate "nothing here": the store said 404. Reached through
    // the verdict, never by falling past it.
    return res.status(404).json({ error: `no pin recorded for namespace "${ns}"` });
  }
  if (!pinVerdict.ok) {
    const refused = verdict.refusal(pinVerdict, "latest", HEAD);
    res.setHeader("cache-control", "no-store");
    return res.status(refused.status).json(refused.body);
  }
  const pin = pinRead.json;
  const cadenceFields = store.computeCadenceFields(pin);

  res.setHeader("cache-control", "no-store");
  // Header form so a proxy or a gate can refuse without parsing the body.
  res.setHeader("x-cadence-gradeable", cadenceFields.cadence_gradeable ? "true" : "false");

  const out = verdict.success(pinVerdict, {
    pin,
    source,
    freshness_note: `${note}; the authoritative record is the commit history at ${HISTORY_BASE}/pins/${ns}`,
    history: `${HISTORY_BASE}/pins/${ns}`,
    ...cadenceFields,
  }, "latest", HEAD);

  return res.status(200).json(out);
};
