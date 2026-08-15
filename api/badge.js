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

const { gatherStatusData } = require("./_status_data.js");

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

  const data = await gatherStatusData();

  const word = data.degraded ? "degraded" : data.indeterminate ? "indeterminate" : "ok";
  const color = data.degraded ? "red" : data.indeterminate ? "yellow" : "green";
  const message = `${word} · ${data.namespaces.length} ns · ${data.overdueCount} overdue`;

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
