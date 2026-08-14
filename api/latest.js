// GET /api/latest?ns=<namespace> — the most recent pin for a namespace.
//
// No auth: pins are public by design (that's the point of a public witness).
// Primary read path is the GitHub contents API (authoritative, no CDN lag);
// fallback is raw.githubusercontent with a cache-busting query — measured in
// practice, raw can serve stale content for MINUTES (its CDN largely ignores
// query-string cache-busters), so the response names which source served it
// and always points at the commit history as the authoritative record.

"use strict";

const store = require("./_store.js");

const HISTORY_BASE = `https://github.com/${store.REPO}/commits/${store.BRANCH}`;

module.exports = async (req, res) => {
  if (req.method !== "GET") {
    res.setHeader("allow", "GET");
    return res.status(405).json({ error: "GET only" });
  }

  const ns = (req.query && req.query.ns) || "";
  if (!store.NS_RE.test(ns)) {
    return res.status(400).json({ error: "ns must match [a-z0-9-]{1,64}" });
  }

  const path = `pins/${ns}/latest.json`;
  let pin = null;
  let source, note;

  // Primary: contents API — commit-fresh, no CDN cache.
  try {
    const got = await store.getFile(path);
    if (got === null) {
      return res.status(404).json({ error: `no pin recorded for namespace "${ns}"` });
    }
    pin = got.json;
    source = "github-contents-api";
    note = "read via the GitHub contents API (commit-fresh)";
  } catch {
    // Fallback: raw CDN with cache-buster. Honest note: raw can lag well
    // beyond the folk ~60s — the repo history is the source of truth.
    try {
      const r = await fetch(
        `https://raw.githubusercontent.com/${store.REPO}/${store.BRANCH}/${path}?cb=${Date.now()}`,
        { headers: { "cache-control": "no-cache" } }
      );
      if (r.status === 404) {
        return res.status(404).json({ error: `no pin recorded for namespace "${ns}"` });
      }
      if (!r.ok) {
        return res.status(502).json({ error: `pin store read failed: ${r.status}` });
      }
      pin = await r.json();
      source = "raw.githubusercontent";
      note = "served from the raw CDN, which can lag minutes behind the newest commit";
    } catch (err) {
      return res.status(502).json({ error: `pin store read error: ${err.message}` });
    }
  }

  res.setHeader("cache-control", "no-store");
  return res.status(200).json({
    ok: true,
    pin,
    source,
    freshness_note: `${note}; the authoritative record is the commit history at ${HISTORY_BASE}/pins/${ns}`,
    history: `${HISTORY_BASE}/pins/${ns}`,
  });
};
