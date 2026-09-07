// GET /api/health — liveness plus a real check that the pin repo is reachable.
//
// Per-IP rate limit (2026-09-05 audit finding — see api/latest.js's comment
// for the full reasoning): unauthenticated + unlimited + a real GitHub API
// call per hit is exactly the shape that can drain the shared
// GITHUB_PIN_TOKEN budget the paying /api/pin path also depends on.

"use strict";

const store = require("../lib/_store.js");
const cors = require("../lib/_cors.js");
const ratelimit = require("../lib/_ratelimit.js");

module.exports = async (req, res) => {
  // GET-only CORS: answers an OPTIONS preflight with 204 and returns. See
  // _cors.js for scope (read endpoints only). This handler otherwise has no
  // method guard (any method has always gotten a live liveness answer) —
  // that's unchanged; this only adds the ACAO header and the preflight.
  if (cors.applyGetCors(req, res)) return;

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

  const reachable = await store.repoReachable();
  res.setHeader("cache-control", "no-store");
  return res.status(reachable ? 200 : 503).json({
    ok: reachable,
    service: "arcaeon-witness",
    store: {
      kind: "public-github-repo",
      repo: store.REPO,
      branch: store.BRANCH,
      reachable,
    },
  });
};
