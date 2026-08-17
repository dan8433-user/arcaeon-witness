// POST /api/stripe-webhook — Stripe `checkout.session.completed` and
// `checkout.session.async_payment_succeeded` -> credit a pack.
//
// HUMAN STEP STILL OWED, named plainly: this endpoint verifies signatures
// against WITNESS_STRIPE_WEBHOOK_SECRET, which is NOT set anywhere in this
// project as of this build (2026-08-14). The only STRIPE_WEBHOOK_SECRET
// present anywhere in this account's env belongs to a DIFFERENT Arcaeon
// product (ascenvo) — reusing it here would credit witness packs off a
// signature meant for a different product's events, so this module
// deliberately does not fall back to it. Until a Stripe webhook endpoint
// is created, subscribed to both event types above (plus
// checkout.session.async_payment_failed, logged not credited — see H2
// below), pointed at
// https://arcaeon-witness.vercel.app/api/stripe-webhook and its signing
// secret is set here as WITNESS_STRIPE_WEBHOOK_SECRET, this handler fails
// closed with 501 on every call. The crediting logic itself (creditPack,
// idempotent on whatever identity the caller supplies — this webhook passes
// the Checkout Session id, api/credit.js's admin path passes its own
// event_id) is fully built and tested via api/credit.js's internal path —
// wiring this endpoint into Stripe is the remaining step, not a placeholder
// pretending to be real.
//
// Expected event shape once wired: `checkout.session.completed` (synchronous
// payment methods; also the "session opened, not yet paid" delivery for
// asynchronous ones) and `checkout.session.async_payment_succeeded` (the
// delayed-clear signal for ACH/Klarna/etc.) with `session.client_reference_id`
// = sha256(witness key) of the buyer's key, and `session.metadata.pack` = one
// of mini|starter|standard|bulk (api/_balance.js PACKS). Setting those two
// fields on each pack's Stripe Payment Link / Checkout Session is ALSO a
// human step and is intentionally not done here — this build's scope is the
// mechanism only, not touching live Stripe config or offers.json (see
// COUNCIL_PRICING_REVIEW_2026-08-14 §4 decision #5: the pricing cutover is
// separate and comes after).
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
const balance = require("../lib/_balance.js");

// NOTE: the `config` export is attached at the BOTTOM of this file, after the
// handler is assigned to module.exports. It used to be set here, on line 40 —
// which did nothing, because line 83's `module.exports = async (req,res)=>{}`
// replaced the whole exports object and took `config` with it (2026-08-14
// audit). With `bodyParser` left at its default, the request stream is drained
// and parsed before the handler runs, so readRawBody() below would resolve to
// an EMPTY buffer and the HMAC would be computed over `${t}.` — every genuine
// Stripe delivery would have failed signature verification the day this
// endpoint was wired up. It fails closed, so this was a liveness bug rather
// than a hole, but it would have been diagnosed as "Stripe is sending bad
// signatures" and it had to be found before the wiring, not after.

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

  // Sign over the RAW BYTES. The previous form was `` `${t}.${rawBody}` ``,
  // which stringifies the Buffer through its default utf-8 decoding before
  // hashing — any byte sequence that is not valid UTF-8 gets replaced with
  // U+FFFD and the computed HMAC no longer matches what Stripe signed over the
  // original bytes. Stripe sends UTF-8 JSON so this was latent rather than
  // live, but a signature check has no business round-tripping its own input
  // through a lossy decode (2026-08-14 audit).
  const expected = crypto
    .createHmac("sha256", secret)
    .update(Buffer.concat([Buffer.from(`${t}.`, "utf8"), rawBody]))
    .digest("hex");

  // Buffer.from(x, "hex") does NOT throw on malformed input — it silently
  // stops at the first invalid pair — so the length check below is what
  // actually rejects a junk v1, not the try/catch. Reject non-hex explicitly
  // rather than relying on a truncation happening to produce a length mismatch.
  if (!/^[0-9a-fA-F]+$/.test(v1) || v1.length % 2 !== 0) {
    return { ok: false, reason: "malformed v1 signature" };
  }
  const expectedBuf = Buffer.from(expected, "hex");
  const gotBuf = Buffer.from(v1, "hex");
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

  // H2 (quad-check 2026-08-16): async payment methods (ACH, Klarna, etc.)
  // fire checkout.session.completed with payment_status:"unpaid" first —
  // that delivery is correctly skipped below by the payment gate — and the
  // ACTUAL money-cleared signal arrives later as its own event,
  // checkout.session.async_payment_succeeded. This handler used to discard
  // that second event right here ("unhandled event type"), even though the
  // payment-gate comment two screens down promised "the real credit arrives
  // later on the async success event." It never did: $150 ACH buyers paid
  // and got zero pins, silently, with a 200 to Stripe on both deliveries (no
  // retry, no dashboard alert). Both event types describe the same fact —
  // "money arrived" — and both carry a `session` object with the same
  // shape (client_reference_id, metadata.pack, payment_status, amount_total,
  // currency), so both are handled identically below.
  const CREDITING_TYPES = new Set([
    "checkout.session.completed",
    "checkout.session.async_payment_succeeded",
  ]);
  if (event.type === "checkout.session.async_payment_failed") {
    // Not a silent nothing (H3's "every paid-but-uncredited path must log"
    // discipline applied to the mirror case): an async payment that FAILED
    // to clear is worth a server-side line, even though there is nothing to
    // credit and Stripe should not retry it.
    console.error(`[webhook] async payment failed evt=${event.id} — no credit due, nothing to retry`);
    return res.status(200).json({ ok: true, skipped: "async payment failed — nothing to credit", event_id: event.id });
  }
  if (!CREDITING_TYPES.has(event.type)) {
    // 200, not an error — Stripe sends every subscribed event type; we
    // only act on the ones above. Returning non-2xx here would make Stripe
    // retry an event we were never going to handle differently.
    return res.status(200).json({ ok: true, skipped: `unhandled event type: ${event.type}` });
  }

  // Livemode gate (2026-08-14 billing audit). A test-mode event must never
  // credit a live balance, nor a live event a test store. The signing secret
  // already differs between modes, so a cross-mode delivery can't even pass
  // signature verification — this is defense in depth, and it's cheap. Expected
  // mode defaults to live; set WITNESS_STRIPE_LIVEMODE=false for a test-mode
  // endpoint. Only asserted when the event actually carries the boolean.
  const expectedLive =
    String(process.env.WITNESS_STRIPE_LIVEMODE ?? "true").toLowerCase() !== "false";
  if (typeof event.livemode === "boolean" && event.livemode !== expectedLive) {
    return res.status(200).json({
      ok: true,
      skipped: `livemode mismatch (event.livemode=${event.livemode}, expected=${expectedLive})`,
      event_id: event.id,
    });
  }

  const session = event.data && event.data.object;

  // Payment gate (2026-08-14 billing audit). `checkout.session.completed` fires
  // when the Checkout Session COMPLETES, which for asynchronous payment methods
  // (and unpaid/expired sessions) is NOT the same as the money having cleared.
  // Crediting on completion alone would grant a pack for a payment that never
  // settled. Only `payment_status:"paid"` is money in hand; anything else
  // (`unpaid`, `no_payment_required`, missing) is skipped with a 200 so Stripe
  // does not retry — the real credit now DOES arrive later, on the
  // `checkout.session.async_payment_succeeded` delivery, once CREDITING_TYPES
  // (above) actually subscribes to it (H2, quad-check 2026-08-16 — this
  // sentence used to be a promise the code didn't keep).
  const paymentStatus = session && session.payment_status;
  if (paymentStatus !== "paid") {
    return res.status(200).json({
      ok: true,
      skipped: `session not paid (payment_status=${paymentStatus === undefined ? "missing" : paymentStatus})`,
      event_id: event.id,
    });
  }

  // Normalize the hash (accept upper-case sha256 — PowerShell Get-FileHash
  // emits caps) and the pack key (trim + lower-case) BEFORE lookup. H3
  // (quad-check 2026-08-16): byte-exact matching silently no-op-credited
  // "Mini"/" mini"/uppercase-hash checkouts — paid, delivered, zero granted,
  // no retry. Normalize so a benign metadata/tooling variance still credits.
  const hash = (session && session.client_reference_id || "").trim().toLowerCase();
  const pack = ((session && session.metadata && session.metadata.pack) || "").trim().toLowerCase();

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

  // VERIFY THE MONEY (H1, quad-check 2026-08-16 — THE big one): the prior
  // three passes all audited the CREDIT and none audited the PAYMENT. This
  // handler read only who-to-credit + a hand-typed pack name and NEVER read
  // amount_total — so a link whose metadata.pack outranked its price (or a
  // tampered/misconfigured link) granted the full pack for any amount: a
  // real signed $5 event with pack=bulk credited 40,000 pins ($200 of value)
  // and returned 200. Cross-check the paid amount against the pack's ratified
  // price before crediting. Currency pinned to USD (all packs are USD).
  const expectedCents = balance.PACKS[pack].price_usd * 100;
  const paidCents = session && Number.isFinite(Number(session.amount_total)) ? Number(session.amount_total) : null;
  const currency = session && session.currency ? String(session.currency).toLowerCase() : null;
  if (paidCents === null || paidCents < expectedCents || (currency && currency !== "usd")) {
    return res.status(200).json({
      ok: true,
      skipped: `payment does not match pack '${pack}': paid ${paidCents} ${currency || "?"}, expected ${expectedCents} usd — NOT credited`,
      event_id: event.id,
    });
  }

  try {
    // Keyed on the Checkout SESSION id, not the event id (H2, quad-check
    // 2026-08-16, mechanically traced). An earlier version of this comment
    // argued event.id was the right key because a delivery retry resends the
    // same event.id — true, but incomplete: CREDITING_TYPES above now
    // subscribes to TWO event types, `checkout.session.completed` and
    // `checkout.session.async_payment_succeeded`, and Stripe's own
    // fulfillment guidance names the actual invariant: "your fulfill_checkout
    // function might be called multiple times, possibly concurrently, for
    // the same Checkout Session" — its reference handler dedupes on the
    // SESSION id for exactly this reason, because two different event ids
    // can both carry a paid signal for one real-world purchase. In this
    // handler's own flow that's mostly foreclosed already (the `completed`
    // delivery for an async method arrives `unpaid` and returns above before
    // this line ever runs), but keying the atomic claim in
    // api/_balance.js's `applied_events` on event.id ALONE would still leave
    // a real gap the moment Stripe redelivers `completed` a second time
    // already-paid (redelivery races, dashboard-triggered resends, or any
    // future change to which event types are subscribed) — a second, PAID
    // `completed` event and the `async_payment_succeeded` event would carry
    // two different event ids for the one session and both would look
    // "not yet applied." Falls back to event.id only if the session
    // somehow carries no id (belt-and-suspenders; real Checkout Sessions
    // always have one).
    const idempotencyKey = (session && session.id) ? String(session.id) : event.id;
    const result = await balance.creditPack(hash, pack, idempotencyKey, "stripe-webhook");
    return res.status(200).json({
      ok: true,
      credited: !result.already_credited,
      already_credited: !!result.already_credited,
      balance_after: result.balance_after,
      event_id: event.id,
      session_id: session && session.id,
    });
  } catch (err) {
    // A real store failure — 500 so Stripe retries per its own backoff
    // schedule, rather than us silently eating a paid top-up.
    return res.status(500).json({ error: `credit store error: ${err.message}` });
  }
};

// Attached AFTER the handler assignment above, which is the whole point — see
// the note near the top of this file. Vercel reads `config` off this module's
// exports, so it has to survive the `module.exports = handler` line.
// bodyParser MUST stay disabled: Stripe signs the raw request bytes, and a
// re-serialized parse does not reproduce them byte for byte.
module.exports.config = { api: { bodyParser: false } };
