// GET /api/health — liveness plus a real check that the pin repo is reachable.

"use strict";

const store = require("../lib/_store.js");
const cors = require("../lib/_cors.js");

module.exports = async (req, res) => {
  // GET-only CORS: answers an OPTIONS preflight with 204 and returns. See
  // _cors.js for scope (read endpoints only). This handler otherwise has no
  // method guard (any method has always gotten a live liveness answer) —
  // that's unchanged; this only adds the ACAO header and the preflight.
  if (cors.applyGetCors(req, res)) return;

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
