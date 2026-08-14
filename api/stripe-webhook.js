// POST /api/stripe-webhook — Stripe `checkout.session.completed` -> credit a pack.
//
// HUMAN STEP STILL OWED, named plainly: this endpoint verifies signatures
// against WITNESS_STRIPE_WEBHOOK_SECRET, which is NOT set anywhere in this
// project as of this build (2026-08-14). The only STRIPE_WEBHOOK_SECRET
// present anywhere in this account's env belongs to a DIFFERENT Arcaeon
// product (ascenvo) — reusing it here would credit witness packs off a
// signature meant for a different product's events, so this module
// deliberately does not fall back to it. Until a Stripe webhook endpoint
// is created for checkout.session.completed pointed at
// https://arcaeon-witness.vercel.app/api/stripe-webhook and its signing
// secret is set here as WITNESS_STRIPE_WEBHOOK_SECRET, this handler fails
// closed with 501 on every call. The crediting logic itself (creditPack,
// idempotent on the Stripe event id) is fully built and tested via
// api/credit.js's internal path — wiring this endpoint into Stripe is the
// remaining step, not a placeholder pretending to be real.
//
// Expected event shape once wired: `checkout.session.completed` with
// `session.client_reference_id` = sha256(witness key) of the buyer's key,
// and `session.metadata.pack` = one of starter|standard|bulk (api/_balance.js
// PACKS). Setting those two fields on each pack's Stripe Payment Link /
// Checkout Session is ALSO a human step and is intentionally not done
// here — this build's scope is the mechanism only, not touching live
// Stripe config or offers.json (see COUNCIL_PRICING_REVIEW_2026-08-14 §4
// decision #5: the pricing cutover is separate and comes after).
//
// No Stripe SDK / no dependencies (this repo has none, on purpose — see
// README "Layout"). Stripe's webhook signature scheme is simple enough to
// verify by hand: header is `t=<unix seconds>,v1=<hex hmac>`; the hmac is
// HMAC-SHA256(signing_secret, `${t}.${raw_request_body}`). Verifying
// against the RAW body (not the parsed JSON re-serialized) is why
// bodyParser is disabled below — re-serializing parsed JSON does not
// byte-for-byte match what Stripe signed.

"use strict";

const crypto = require("crypto");
const balance = require("./_balance.js");

module.exports.config = { api: { bodyParser: false } };

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

const TOLERANCE_SECONDS = 300; // guards against replaying an old, valid signature

function verifyStripeSignature(rawBody, sigHeader, secret) {
  if (!sigHeader) return { ok: false, reason: "missing stripe-signature header" };
  const parts = {};
  for (const kv of sigHeader.split(",")) {
    const i = kv.indexOf("=");
    if (i < 1) continue;
    parts[kv.slice(0, i)] = kv.slice(i + 1);
  }
  const t = parts.t;
  const v1 = parts.v1;
  if (!t || !v1) return { ok: false, reason: "malformed stripe-signature header" };

  const expected = crypto.createHmac("sha256", secret).update(`${t}.${rawBody}`, "utf8").digest("hex");
  let expectedBuf, gotBuf;
  try {
    expectedBuf = Buffer.from(expected, "hex");
    gotBuf = Buffer.from(v1, "hex");
  } catch {
    return { ok: false, reason: "malformed v1 signature" };
  }
  if (expectedBuf.length !== gotBuf.length || !crypto.timingSafeEqual(expectedBuf, gotBuf)) {
    return { ok: false, reason: "signature mismatch" };
  }
  const age = Math.abs(Date.now() / 1000 - Number(t));
  if (!Number.isFinite(age) || age > TOLERANCE_SECONDS) {
    return { ok: false, reason: "timestamp outside tolerance" };
  }
  return { ok: true };
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.setHeader("allow", "POST");
    return res.status(405).json({ error: "POST only" });
  }

  const secret = process.env.WITNESS_STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    return res.status(501).json({
      error: "witness Stripe webhook not configured yet",
      human_step:
        "create a Stripe webhook endpoint for checkout.session.completed pointed at " +
        "/api/stripe-webhook, then set WITNESS_STRIPE_WEBHOOK_SECRET in Vercel env to its " +
        "signing secret. Crediting logic is already built and tested via /api/credit.",
    });
  }

  let rawBody;
  try {
    rawBody = await readRawBody(req);
  } catch (err) {
    return res.status(400).json({ error: `could not read request body: ${err.message}` });
  }

  const check = verifyStripeSignature(rawBody, req.headers["stripe-signature"], secret);
  if (!check.ok) {
    return res.status(400).json({ error: `signature verification failed: ${check.reason}` });
  }

  let event;
  try {
    event = JSON.parse(rawBody.toString("utf8"));
  } catch {
    return res.status(400).json({ error: "invalid JSON payload" });
  }

  if (event.type !== "checkout.session.completed") {
    // 200, not an error — Stripe sends every subscribed event type; we
    // only act on this one. Returning non-2xx here would make Stripe
    // retry an event we were never going to handle differently.
    return res.status(200).json({ ok: true, skipped: `unhandled event type: ${event.type}` });
  }

  const session = event.data && event.data.object;
  const hash = session && session.client_reference_id;
  const pack = session && session.metadata && session.metadata.pack;

  if (!hash || !/^[0-9a-f]{64}$/.test(hash)) {
    return res.status(200).json({
      ok: true,
      skipped: "session.client_reference_id missing or not a sha256 hash — cannot credit",
      event_id: event.id,
    });
  }
  if (!pack || !balance.PACKS[pack]) {
    return res.status(200).json({
      ok: true,
      skipped: `session.metadata.pack missing or unknown (${pack})`,
      event_id: event.id,
    });
  }

  try {
    // Keyed on the Stripe EVENT id (not the session id) — Stripe's own
    // idempotency guidance: a delivery retry resends the same event.id,
    // which is what api/_balance.js's grantCredits uses as its atomic
    // claim key, so a replay never double-credits.
    const result = await balance.creditPack(hash, pack, event.id, "stripe-webhook");
    return res.status(200).json({
      ok: true,
      credited: !result.already_credited,
      already_credited: !!result.already_credited,
      balance_after: result.balance_after,
      event_id: event.id,
    });
  } catch (err) {
    // A real store failure — 500 so Stripe retries per its own backoff
    // schedule, rather than us silently eating a paid top-up.
    return res.status(500).json({ error: `credit store error: ${err.message}` });
  }
};
