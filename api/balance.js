// GET /api/balance — a key-holder's own read-only view: purchased credit
// balance plus current free-tier monthly usage. Auth-gated the same way
// as /api/pin (Bearer <key> from WITNESS_KEYS) — this is a self-read of
// account state, not a public witnessing fact like /api/latest, so it is
// not open to the world.
//
// Read-only by construction: it calls meter.peek() (added alongside this
// endpoint), never meter.check(), so looking at your own balance can
// never itself consume a pin.

"use strict";

const store = require("./_store.js");
const meter = require("./_meter.js");
const balance = require("./_balance.js");
const issuedKeys = require("./_keys.js");

module.exports = async (req, res) => {
  if (req.method !== "GET") {
    res.setHeader("allow", "GET");
    return res.status(405).json({ error: "GET only" });
  }

  // Same two-tier auth as api/pin.js: WITNESS_KEYS env first, then the
  // dynamic issued-key store (self-serve keys from api/fulfill.js).
  const auth = req.headers.authorization || "";
  const key = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  let prefix = key ? store.keyPrefixFor(key) : null;
  if (prefix === null && key) {
    try {
      prefix = await issuedKeys.issuedKeyPrefix(key);
    } catch (err) {
      return res.status(502).json({ error: `key store error: ${err.message}` });
    }
  }
  if (prefix === null) {
    return res.status(401).json({ error: "invalid or missing bearer key" });
  }

  try {
    const [bal, freeTier] = await Promise.all([
      balance.readBalance(balance.keyHash(key)),
      meter.peek(key),
    ]);
    res.setHeader("cache-control", "no-store");
    return res.status(200).json({
      ok: true,
      key_id: bal.key_id,
      credit_balance: bal.balance,
      credit_ever_purchased: bal.ever_purchased,
      credit_updated_at: bal.updated_at,
      free_tier: {
        plan: freeTier.plan,
        month: freeTier.month,
        used: freeTier.used,
        cap: freeTier.cap,
      },
    });
  } catch (err) {
    return res.status(502).json({ error: `balance read error: ${err.message}` });
  }
};
