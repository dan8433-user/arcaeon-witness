// POST /api/renew — publisher heartbeat: refresh a namespace's cadence
// deadline WITHOUT claiming the content head moved.
//
// Why this exists (excelsior's review, 2026-08-14): before it, a namespace
// whose log genuinely stopped changing went permanently overdue. The
// idempotent re-pin branch returned the stored pin untouched, and the deadline
// only moved when rows advanced — so "the log is quiet but the publisher is
// alive" had no way to be said, and a legitimately finished log looked
// identical to an abandoned one.
//
// This is deliberately a thin wrapper over api/pin.js rather than a second
// write path. Same auth, same rate limit, same metering and credit accounting,
// same monotonic guard, same conflict-observation branch — one implementation
// of the invariants, so a renewal cannot slip past a check that a pin has to
// pass. All this module does is stamp intent:"renew" onto the body.
//
// Body: {namespace, rows, chain} — rows and chain MUST restate the current
// head exactly. Mismatched rows -> 409 renewal_head_mismatch; same rows with a
// different chain still takes the conflict-observation path, unchanged.
//
// AUTH IS BEARER-KEY ONLY (auth_level:"bearer-stage0"), narrowed since
// 2026-08-15 to the namespace's DEADLINE-OWNER key: the prefix gate is not
// enough for a deadline write, so pin.js's ownerGate requires the key bound in
// owners/<namespace>.json (excelsior). That closes the other key, not the
// stolen one. Owner-signature auth is still the Stage-1 requirement and is not
// built. See _store.AUTH_LEVEL_NOTE and _store.ownerKeyId.

"use strict";

const pin = require("./pin.js");

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.setHeader("allow", "POST");
    return res.status(405).json({ error: "POST only" });
  }

  if (req.body && typeof req.body === "object" && !Array.isArray(req.body)) {
    const given = req.body.intent;
    if (given !== undefined && given !== null && String(given).toLowerCase() !== "renew") {
      // Fails closed rather than quietly overriding: a caller who asked for a
      // different intent on this path has a bug, and guessing which one they
      // meant is exactly how a renewal gets laundered into something else.
      return res.status(400).json({
        error: `/api/renew implies intent "renew"; body said "${given}"`,
        reason: "conflicting_intent",
      });
    }
    req.body = { ...req.body, intent: "renew" };
  }

  return pin(req, res);
};
