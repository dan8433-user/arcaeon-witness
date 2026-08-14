// POST /api/credit — internal/admin credit top-up path.
//
// This is the stand-in for real-time Stripe crediting (api/stripe-webhook.js)
// until WITNESS_STRIPE_WEBHOOK_SECRET exists in Vercel env — it does NOT
// today (checked at build time, 2026-08-14: the only STRIPE_WEBHOOK_SECRET
// in this account belongs to a different Arcaeon product, ascenvo, not
// this witness). It lets a trusted operator (or a test harness) credit a
// pack through the exact same idempotent creditPack() function the
// webhook will call, so the crediting logic is fully built and tested
// even though live Stripe wiring is a separate, later, human step.
//
// Auth: Authorization: Bearer <WITNESS_ADMIN_KEY> — a Vercel env var,
// distinct from any per-buyer WITNESS_KEYS entry. Fails CLOSED: if
// WITNESS_ADMIN_KEY is unset, every call is refused (500), never silently
// open. This secret is ours to mint (not a third-party credential), but
// it is not hardcoded here — see README for the human step of setting it.

"use strict";

const crypto = require("crypto");
const balance = require("./_balance.js");

const HASH_RE = /^[0-9a-f]{64}$/;

function timingSafeStringEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.setHeader("allow", "POST");
    return res.status(405).json({ error: "POST only" });
  }

  const adminKey = process.env.WITNESS_ADMIN_KEY;
  if (!adminKey) {
    return res.status(500).json({
      error: "WITNESS_ADMIN_KEY not configured — internal credit path is disabled until it is set",
      human_step: "set WITNESS_ADMIN_KEY in Vercel project env vars (Production + Preview)",
    });
  }

  const auth = req.headers.authorization || "";
  const provided = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!provided || !timingSafeStringEqual(provided, adminKey)) {
    return res.status(401).json({ error: "invalid or missing admin bearer key" });
  }

  const body = typeof req.body === "object" && req.body ? req.body : null;
  if (!body || typeof body.pack !== "string" || !balance.PACKS[body.pack]) {
    return res.status(400).json({
      error: "body.pack must be one of: " + Object.keys(balance.PACKS).join(", "),
    });
  }
  if (typeof body.event_id !== "string" || !body.event_id.trim()) {
    return res.status(400).json({ error: "body.event_id is required (idempotency key — reuse it on retry, never mint a new one for the same real-world purchase)" });
  }

  let hash;
  if (typeof body.key_hash === "string" && HASH_RE.test(body.key_hash)) {
    hash = body.key_hash;
  } else if (typeof body.key === "string" && body.key.trim()) {
    hash = balance.keyHash(body.key.trim());
  } else {
    return res.status(400).json({ error: "body.key_hash (sha256 hex, 64 chars) or body.key (raw witness key) is required" });
  }

  try {
    const result = await balance.creditPack(hash, body.pack, body.event_id.trim(), "internal-admin");
    if (!result.ok) {
      return res.status(400).json({ error: result.reason, ...result });
    }
    return res.status(200).json({
      ok: true,
      key_hash: hash,
      pack: body.pack,
      pins_added: balance.PACKS[body.pack].pins,
      already_credited: !!result.already_credited,
      balance_after: result.balance_after,
    });
  } catch (err) {
    return res.status(502).json({ error: `credit store error: ${err.message}` });
  }
};
