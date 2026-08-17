// GET/POST /api/fulfill?session_id={CHECKOUT_SESSION_ID} — INSTANT FULFILLMENT.
//
// The page a buyer lands on straight from Stripe Checkout (success_url) — and
// the page they come BACK to from Stripe's receipt email. It verifies the
// session server-side against Stripe's API, and on the first valid visit
// provisions a witness key + credits the purchased pack. Every later visit
// with the same session_id re-shows the SAME key (idempotent re-retrieval —
// the recovery path). A faked or unpaid session gets a clean denial, never a
// key.
//
// Trust model, stated plainly:
//   - The session_id itself is the only secret in the URL. Whoever holds the
//     receipt URL can see the key — that is the product promise (recovery via
//     receipt email), not an accident. The KEY never appears in any URL; it
//     renders in the page body / JSON body only.
//   - Verification is SERVER-side: GET https://api.stripe.com/v1/checkout/
//     sessions/{id} with the secret key from env. status must be "complete"
//     AND payment_status must be "paid". No signature dance needed here —
//     unlike the webhook, WE originate the call to Stripe, so the response is
//     trusted by construction.
//   - Idempotency key for crediting is the SESSION id — the same key
//     api/stripe-webhook.js uses — so this page and the webhook can never
//     double-credit one purchase between them (api/_balance.js applied_events
//     is the shared atomic gate).
//
// Pack resolution order (see resolvePack): Stripe Price ids from the
// session's line items via WITNESS_STRIPE_PRICE_MAP env JSON, then
// session.metadata.pack (the existing webhook convention), then an
// amount_total fallback derived from the ratified PACKS table.
//
// Existing-buyer top-ups: a session carrying client_reference_id =
// sha256(existing key) — the webhook's convention — is credited to THAT key
// and mints nothing (we never knew the raw key, so there is nothing to show;
// the page says "credited" instead).
//
// Storage: see api/_keys.js (private usage repo; fulfillments/<session_id>
// .json is the create-only session->key binding, keys/<hash>.json is what
// makes the minted key valid for /api/pin).

"use strict";

const balance = require("../lib/_balance.js");
const meter = require("../lib/_meter.js");
const keys = require("../lib/_keys.js");

const SUPPORT_EMAIL = "support@arcaeon.io";
const DOCS_URL = process.env.WITNESS_DOCS_URL || "https://arcaeon.io/ai";
const BASE_URL = process.env.WITNESS_BASE_URL || "https://arcaeon-witness.vercel.app";

// WITNESS_-scoped name first — house rule from api/stripe-webhook.js: bare
// Stripe env names in this account can belong to a DIFFERENT Arcaeon product
// (ascenvo). Falling back to bare STRIPE_SECRET_KEY is safe here in a way the
// webhook's fallback was not: a webhook secret from the wrong product would
// VALIDATE the wrong events, while a secret key from the wrong Stripe account
// simply fails to find the session -> clean denial, fail closed.
function stripeSecretKey() {
  return process.env.WITNESS_STRIPE_SECRET_KEY || process.env.STRIPE_SECRET_KEY || "";
}

function wantsJson(req) {
  const q = req.query || {};
  if (String(q.format || "").toLowerCase() === "json") return true;
  const accept = String((req.headers && req.headers.accept) || "");
  return accept.toLowerCase().includes("application/json");
}

function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function pageShell(title, inner) {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title)}</title>
<style>
body{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:#0d1117;color:#e6edf3;max-width:760px;margin:40px auto;padding:0 20px;line-height:1.5}
h1{font-size:1.3rem} a{color:#58a6ff}
.key{font-size:1.15rem;word-break:break-all;background:#161b22;border:1px solid #30363d;border-radius:8px;padding:16px;margin:16px 0}
pre{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:12px;overflow-x:auto;font-size:.85rem}
.muted{color:#8b949e;font-size:.85rem}
.warn{color:#d29922}
</style></head><body>${inner}
<p class="muted">support: <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a> · <a href="${esc(DOCS_URL)}">docs</a></p>
</body></html>`;
}

function errorHtml(title, detail) {
  return pageShell(title, `<h1>${esc(title)}</h1><p>${esc(detail)}</p>`);
}

// One responder for both audiences: agents (JSON) and humans (HTML).
function respond(req, res, status, jsonBody, htmlBuilder) {
  res.setHeader("cache-control", "no-store");
  if (wantsJson(req) || !htmlBuilder) return res.status(status).json(jsonBody);
  res.setHeader("content-type", "text/html; charset=utf-8");
  return res.status(status).send(htmlBuilder());
}

function deny(req, res, status, jsonBody, humanTitle, humanDetail) {
  return respond(req, res, status, jsonBody, () => errorHtml(humanTitle, humanDetail));
}

// ---- pack resolution ----
function loadPriceMap() {
  // WITNESS_STRIPE_PRICE_MAP: JSON object, Stripe Price id -> pack id,
  // e.g. {"price_1AbCdE...":"mini"}. Optional; the fallbacks below cover an
  // unset map, but the map is the preferred, tamper-proof mapping (a Price id
  // comes from Stripe's own line items, not from link metadata anyone typed).
  const raw = process.env.WITNESS_STRIPE_PRICE_MAP || "{}";
  try {
    const p = JSON.parse(raw);
    return p && typeof p === "object" && !Array.isArray(p) ? p : {};
  } catch {
    return {};
  }
}

function resolvePack(session) {
  // 1) Price ids off the session's line items (session retrieved with
  //    expand[]=line_items), mapped via WITNESS_STRIPE_PRICE_MAP.
  const priceMap = loadPriceMap();
  const items =
    session && session.line_items && Array.isArray(session.line_items.data)
      ? session.line_items.data
      : [];
  for (const it of items) {
    const pid = it && it.price && it.price.id;
    const mapped = pid && priceMap[pid] ? String(priceMap[pid]).trim().toLowerCase() : null;
    if (mapped && balance.PACKS[mapped]) return { pack: mapped, source: "price_map" };
  }
  // 2) session.metadata.pack — the existing api/stripe-webhook.js convention,
  //    normalized the same way (H3 discipline: trim + lowercase).
  const meta =
    session && session.metadata && session.metadata.pack
      ? String(session.metadata.pack).trim().toLowerCase()
      : "";
  if (meta && balance.PACKS[meta]) return { pack: meta, source: "metadata" };
  // 3) FALLBACK: exact amount_total -> pack, derived from the ratified PACKS
  //    table (never hand-maintained numbers). USD only, exact match only —
  //    least preferred (two packs at one price would be ambiguous), kept so an
  //    honest-but-unmapped Payment Link still fulfills instead of stranding a
  //    paid buyer behind a support email.
  const currency = session && session.currency ? String(session.currency).toLowerCase() : null;
  const cents = Number(session && session.amount_total);
  if (currency === "usd" && Number.isFinite(cents)) {
    for (const [id, p] of Object.entries(balance.PACKS)) {
      if (p.price_usd * 100 === cents) return { pack: id, source: "amount_total" };
    }
  }
  return null;
}

// ---- email backup copy — STUB, named honestly ----
// The witness app has NO outbound-mail mechanism: zero dependencies by design
// (README "Layout") and no mail credentials anywhere in env. Wiring new creds
// is explicitly out of this build's scope, so this logs instead of sending.
// The buyer is never stranded by the stub: the receipt-email -> success-URL
// revisit IS the recovery path, and the fulfillment record keeps the email so
// a real sender can backfill welcome mail later.
// TODO(post-deploy): route through a real sender (e.g. Resend/SES) once mail
// creds exist as env vars; send {key, namespace, quickstart, docs_url}.
function sendWelcomeEmailStub(email, sessionId) {
  console.log(
    `[fulfill] TODO welcome-email: would send backup key copy to ${email} ` +
      `for session ${sessionId.slice(0, 24)}… — no mail mechanism wired yet; ` +
      `buyer recovers via the Stripe receipt URL (this page, idempotent)`
  );
}

// ---- success pages ----
function successHtml(record, creditBalance, consentStored) {
  const ns = record.namespace_prefix;
  const consentLine = consentStored
    ? `<p class="muted">✓ You opted in to product updates. (<a href="mailto:${SUPPORT_EMAIL}?subject=unsubscribe">undo</a>)</p>`
    : `<p class="muted"><a href="?session_id=${esc(record.session_id)}&consent=yes">☐ Email me occasional product updates</a> (off unless you click — nothing is sent otherwise)</p>`;
  return pageShell(
    "Your Arcaeon witness key",
    `<h1>Payment verified — here is your witness key</h1>
<div class="key" id="key">${esc(record.key)}</div>
<p><b>${esc(String(record.credits))} prepaid pins</b> are on your balance (plus the free tier: 100 pins/month). Your key pins any namespace starting with <code>${esc(ns)}</code>.</p>
<p class="warn">Save this key now. This page re-shows it any time via your Stripe receipt link — treat that link like the key itself.</p>
<h1>Quickstart</h1>
<pre>curl -X POST ${esc(BASE_URL)}/api/pin \\
  -H "Authorization: Bearer &lt;YOUR KEY&gt;" \\
  -H "Content-Type: application/json" \\
  -d '{"namespace":"${esc(ns)}main","rows":1,"chain":"&lt;16-hex head&gt;"}'</pre>
<p>Verify (public, no key): <code>GET ${esc(BASE_URL)}/api/verify?ns=${esc(ns)}main&amp;rows=1&amp;chain=…</code> · balance: <code>GET /api/balance</code> with your key.</p>
${consentLine}`
  );
}

function topupHtml(sessionId, pack, credits, balanceAfter) {
  return pageShell(
    "Credits applied",
    `<h1>Payment verified — credits applied to your existing key</h1>
<p><b>${esc(String(credits))} pins</b> (${esc(pack)} pack) credited. Current credit balance: <b>${esc(String(balanceAfter))}</b>.</p>
<p class="muted">This purchase referenced an existing key (client_reference_id), so no new key was minted — check <code>GET /api/balance</code> with that key. Revisiting this page is safe: the credit is idempotent per checkout session.</p>`
  );
}

module.exports = async (req, res) => {
  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("allow", "GET, POST");
    return res.status(405).json({ error: "GET or POST only" });
  }
  res.setHeader("cache-control", "no-store");

  const q = req.query || {};
  const body = typeof req.body === "object" && req.body ? req.body : {};
  const sid = String(q.session_id || body.session_id || "").trim();

  // Anchored, charset-limited (see _keys.SESSION_ID_RE): this is both the
  // path-safety guarantee for the fulfillment record AND the first faked-URL
  // rejection — garbage never even reaches Stripe.
  if (!keys.SESSION_ID_RE.test(sid)) {
    return deny(req, res, 400,
      { error: "missing or malformed session_id", reason: "bad_session_id" },
      "Missing checkout session",
      "This page needs a valid session_id from a Stripe Checkout — follow the link from your receipt email or the post-checkout redirect.");
  }

  const sk = stripeSecretKey();
  if (!sk) {
    // Fail closed, loudly typed — same idiom as stripe-webhook.js's 501.
    return res.status(501).json({
      error: "fulfillment not configured yet",
      human_step:
        "set WITNESS_STRIPE_SECRET_KEY in Vercel project env (Production + Preview) to this " +
        "product's Stripe secret key; /api/fulfill verifies checkout sessions server-side with it",
    });
  }

  // --- verify the session SERVER-SIDE against Stripe ---
  let sr;
  try {
    sr = await fetch(
      `https://api.stripe.com/v1/checkout/sessions/${sid}?expand[]=line_items`,
      { headers: { authorization: `Bearer ${sk}` } }
    );
  } catch (err) {
    return deny(req, res, 502,
      { error: "payment verification unavailable", reason: "stripe_unreachable" },
      "Verification unavailable",
      "We could not reach the payment processor to verify this purchase. Nothing is lost — retry this exact URL in a minute.");
  }
  if (sr.status === 404) {
    // A faked or mistyped URL gets a clean denial — never a key.
    return deny(req, res, 404,
      { error: "no such checkout session", reason: "unknown_session" },
      "Unknown checkout session",
      "This session does not exist for this account. If you just paid, use the exact link from your Stripe receipt.");
  }
  if (!sr.ok) {
    // Upstream detail goes to the server log, never the client (house rule
    // from _store.js: callers never see upstream response bodies).
    const detail = await sr.text().catch(() => "");
    console.error(`[fulfill] stripe GET session -> ${sr.status}: ${detail.slice(0, 400)}`);
    return deny(req, res, 502,
      { error: "payment verification failed upstream", reason: "stripe_error" },
      "Verification unavailable",
      "The payment processor returned an error while verifying this purchase. Retry shortly; if it persists, email support with your receipt.");
  }
  let session;
  try {
    session = await sr.json();
  } catch {
    return deny(req, res, 502,
      { error: "payment verification failed upstream", reason: "stripe_bad_json" },
      "Verification unavailable", "Malformed verification response; retry shortly.");
  }

  // Livemode gate — same defense-in-depth as the webhook: a test-mode session
  // must never provision against the live store, nor vice versa.
  const expectedLive =
    String(process.env.WITNESS_STRIPE_LIVEMODE ?? "true").toLowerCase() !== "false";
  if (typeof session.livemode === "boolean" && session.livemode !== expectedLive) {
    return deny(req, res, 403,
      { error: "session is from the wrong Stripe mode", reason: "livemode_mismatch" },
      "Wrong environment",
      "This checkout session belongs to a different Stripe mode (test vs live) than this service.");
  }

  // The paid gate: complete AND paid. An async payment method (ACH etc.) can
  // land here with status:"complete" but payment_status:"unpaid" — money not
  // in hand yet, so no key yet; the page says come back.
  if (session.status !== "complete" || session.payment_status !== "paid") {
    return deny(req, res, 402,
      {
        error: "checkout session is not paid",
        reason: "session_not_paid",
        session_status: session.status ?? null,
        payment_status: session.payment_status ?? null,
      },
      "Payment not completed",
      "This checkout session has not been paid (or the payment has not cleared yet — bank-transfer methods can take days). Revisit this exact URL once payment clears; nothing is lost.");
  }

  // Map the purchase to a pack.
  const resolved = resolvePack(session);
  if (!resolved) {
    console.error(
      `[fulfill] PAID session could not be mapped to a pack: ${sid.slice(0, 24)}… ` +
        `amount_total=${session.amount_total} ${session.currency} metadata.pack=${session.metadata && session.metadata.pack}`
    );
    return deny(req, res, 409,
      { error: "paid session could not be mapped to a credit pack — not fulfilled automatically", reason: "unmapped_purchase", support: SUPPORT_EMAIL },
      "We got your payment — one manual step",
      "Your payment is verified, but this purchase could not be matched to a credit pack automatically. Email support with your receipt and it will be fulfilled by hand (and the mapping fixed).");
  }
  const pack = resolved.pack;
  const packDef = balance.PACKS[pack];

  // Cross-check the money against the pack (the webhook's H1 discipline): a
  // pack claim must never outrank what was actually paid.
  const paidCents = Number.isFinite(Number(session.amount_total)) ? Number(session.amount_total) : null;
  const currency = session.currency ? String(session.currency).toLowerCase() : null;
  const expectedCents = packDef.price_usd * 100;
  if (paidCents === null || paidCents < expectedCents || (currency && currency !== "usd")) {
    console.error(
      `[fulfill] payment/pack mismatch: pack=${pack} expected ${expectedCents} usd, ` +
        `paid ${paidCents} ${currency} (${sid.slice(0, 24)}…) — NOT fulfilled`
    );
    return deny(req, res, 409,
      { error: `payment does not match pack '${pack}' — not fulfilled`, reason: "amount_mismatch", support: SUPPORT_EMAIL },
      "We got your payment — one manual step",
      "The amount paid does not match the credit pack on this session, so it was not fulfilled automatically. Email support with your receipt.");
  }

  const consentAsked =
    ["1", "true", "yes", "on"].includes(String(q.consent ?? body.consent ?? "").toLowerCase());

  try {
    // --- existing-key top-up branch (webhook convention) ---
    // client_reference_id = sha256(existing key) means "credit that key";
    // normalized exactly like the webhook (trim + lowercase, H3).
    const cref = String(session.client_reference_id || "").trim().toLowerCase();
    if (/^[0-9a-f]{64}$/.test(cref)) {
      const result = await balance.creditPack(cref, pack, sid, "stripe-fulfill-topup");
      return respond(req, res, 200,
        {
          ok: true,
          mode: "topup",
          pack,
          credits: packDef.pins,
          credit_balance: result.balance_after,
          already_credited: !!result.already_credited,
          note: "session referenced an existing key (client_reference_id) — credited, no new key minted",
          docs_url: DOCS_URL,
        },
        () => topupHtml(sid, pack, packDef.pins, result.balance_after));
    }

    // --- mint-or-retrieve (idempotent per session) ---
    let firstVisit = false;
    const cur = await keys.readFulfillment(sid);
    let record;
    if (cur) {
      record = cur.json;
    } else {
      const key = keys.mintKey();
      record = {
        session_id: sid,
        mode: "new_key",
        // Raw key at rest in the PRIVATE usage repo — deliberate; see the
        // fulfillments/ paragraph in api/_keys.js for the reasoning.
        key,
        key_hash: keys.keyHash(key),
        namespace_prefix: keys.mintNamespacePrefix(),
        pack,
        pack_source: resolved.source,
        credits: packDef.pins,
        // org/pool schema — baked in now, UI later (see _keys.js header).
        // Solo purchase = single-key pool; credits live on the pool, and for
        // a solo pool the pool's credit account IS this key's hash.
        pool_id: keys.mintPoolId(),
        org: null,
        email:
          (session.customer_details && session.customer_details.email) ||
          session.customer_email ||
          null,
        consent_product_updates: false, // default UNCHECKED, always
        livemode: session.livemode === true,
        amount_total: paidCents,
        currency,
        created_at: new Date().toISOString(),
      };
      const created = await keys.createFulfillment(sid, record);
      // If a concurrent visit won the create-only race, serve the WINNER's
      // key and discard ours — one session, one key, ever.
      record = created.record;
      firstVisit = created.created;
    }

    // Idempotent side effects, run on EVERY visit so a crash between the
    // binding write and any of these self-heals on the next visit:
    //   key record  -> what makes the key valid for /api/pin (create-only)
    //   pool record -> org/pool schema (create-only)
    //   credit      -> idempotent on the SESSION id via applied_events
    await keys.writeIssuedKey({
      key_hash: record.key_hash,
      key_id: record.key_hash.slice(0, 12),
      namespace_prefix: record.namespace_prefix,
      plan: "free", // free monthly tier on top of purchased credits (meter default)
      org: record.org,
      pool_id: record.pool_id,
      source: "stripe-fulfill",
      session_id: sid,
      created_at: record.created_at,
    });
    await keys.writePool({
      pool_id: record.pool_id,
      org: record.org,
      // Solo pool: the pool's credit account is the key's own balance file.
      // Team flow (future): credit_account becomes pool-scoped and N key
      // records point at this one pool_id — see _keys.js header.
      credit_account: record.key_hash,
      member_key_hashes: [record.key_hash],
      kind: "solo",
      created_at: record.created_at,
    });
    const grant = await balance.creditPack(record.key_hash, record.pack, sid, "stripe-fulfill");

    // Consent capture (one line on the page; stored on the fulfillment
    // record; default stays false unless explicitly asked). Best-effort — a
    // consent-write hiccup must never eat the key page.
    let consentStored = record.consent_product_updates === true;
    if (consentAsked && !consentStored) {
      try {
        const updated = await keys.updateFulfillment(sid, (r) => ({
          ...r,
          consent_product_updates: true,
          consent_at: new Date().toISOString(),
        }));
        if (updated) {
          record = updated;
          consentStored = true;
        }
      } catch (err) {
        console.error(`[fulfill] consent write failed (non-fatal): ${err.message}`);
      }
    }

    // Email backup copy — stub (no mail mechanism in this app; see above).
    if (firstVisit && record.email) sendWelcomeEmailStub(record.email, sid);

    const jsonBody = {
      ok: true,
      mode: "new_key",
      key: record.key,
      credits: record.credits,
      namespace: record.namespace_prefix, // pin any namespace starting with this
      namespace_example: `${record.namespace_prefix}main`,
      docs_url: DOCS_URL,
      pack: record.pack,
      pool_id: record.pool_id,
      org: record.org,
      credit_balance: grant.balance_after,
      free_tier_monthly_cap: meter.PLAN_CAPS.free,
      already_fulfilled: !firstVisit,
      consent_product_updates: consentStored,
      support: SUPPORT_EMAIL,
    };
    return respond(req, res, 200, jsonBody, () =>
      successHtml(record, grant.balance_after, consentStored));
  } catch (err) {
    // Store failure AFTER payment verified: the buyer's money is real and the
    // page is safely retryable (every side effect above is idempotent), so
    // say exactly that.
    console.error(`[fulfill] store error for ${sid.slice(0, 24)}…: ${err.message}`);
    return deny(req, res, 502,
      { error: `fulfillment store error: ${err.message}`, reason: "store_error", retry_safe: true, support: SUPPORT_EMAIL },
      "Payment verified — provisioning hiccup",
      "Your payment is verified but provisioning hit a transient storage error. Reload this exact URL — fulfillment is idempotent and will pick up where it left off. If it persists, email support.");
  }
};
