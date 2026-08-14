// GET /api/health — liveness plus a real check that the pin repo is reachable.

"use strict";

const store = require("./_store.js");

module.exports = async (req, res) => {
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
