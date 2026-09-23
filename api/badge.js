// GET /api/badge — shields.io-compatible endpoint badge (board item 25).
//
// Schema: https://shields.io/badges/endpoint-badge — {schemaVersion, label,
// message, color, cacheSeconds}. Point a shields.io badge URL at this path
// and it renders live, e.g.:
//   https://img.shields.io/endpoint?url=https://arcaeon-witness.vercel.app/api/badge
//
// Reuses the same gatherStatusData() pass as /status and /api/status.json —
// one data source, three renderings, so the badge can't say "ok" while the
// page says otherwise.

"use strict";

const { gatherStatusData, overallWord } = require("../lib/_status_data.js");
const ratelimit = require("../lib/_ratelimit.js");

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

  // Per-IP rate limit (2026-09-05 audit finding — see api/latest.js's
  // comment for the full reasoning). This calls the same expensive
  // gatherStatusData() pass as /status — unauthenticated and, until now,
  // unlimited, on the shared GITHUB_PIN_TOKEN budget.
  const rl = ratelimit.check(req);
  if (rl.limited) {
    res.setHeader("retry-after", String(rl.retryAfterSeconds));
    res.setHeader("cache-control", "no-store");
    return res.status(429).json({
      schemaVersion: 1,
      label: "witness",
      message: "rate limited",
      color: "lightgrey",
      isError: true,
    });
  }

  const data = await gatherStatusData();

  const word = overallWord(data); // throws rather than fall through to "ok"
  const color = { degraded: "red", indeterminate: "yellow", ok: "green" }[word];
  // Board item 26: a stale/cannot_determine anchor already pulls `word`/
  // `color` red or yellow via data.degraded/data.indeterminate (see
  // _status_data.js) — this just makes the badge SAY why at a glance instead
  // of leaving a stranger to click through for the reason.
  const anchorNote = data.anchorStatus && data.anchorStatus !== "current"
    ? ` · anchor ${data.anchorStatus}`
    : "";
  const message = `${word} · ${data.namespaces.length} ns · ${data.overdueCount} overdue${anchorNote}`;

  // shields.io caches endpoint badges itself; this just sets our own
  // response's freshness window shorter than a status/latest read (a badge
  // doesn't need second-granularity freshness, but it shouldn't go stale
  // for long either).
  res.setHeader("cache-control", "public, max-age=120, stale-while-revalidate=300");

  return res.status(200).json({
    schemaVersion: 1,
    label: "witness",
    message,
    color,
    cacheSeconds: 120,
  });
};
