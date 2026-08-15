// POST /api/distill — try-before-pip: run arcaeon_distill's deterministic
// distillation over HTTP, no install required. Metered the same way as
// /api/pin: a free-tier monthly cap per bearer key (WITNESS_KEYS /
// WITNESS_PLANS, via _meter.js), credit-pack top-up past the cap
// (_balance.js). This is a funnel to the pip package, not a cost center —
// see README's pricing section for why free-tier-then-metered is the shape.
//
// THIS ENDPOINT RUNS A JS PORT, NOT THE PYTHON PACKAGE (2026-08-15).
// arcaeon-distill is Python; this Vercel deployment is Node. The core
// algorithm (three deterministic strategies, drop receipts) is portable
// stdlib-only logic, so it was ported rather than stubbed — see
// _distill_core.js's header for exactly what a faithful port required
// (a custom JSON parser preserving Python's int/float distinction, a
// Python-repr-compatible float formatter, Map-based dict ordering) and why
// a naive JSON.parse+walk port would have silently produced DIFFERENT
// receipts than the pip package for the same input. Every receipt this
// endpoint returns is stamped `implementation:"js-port"` +
// `js_port_version` + `py_package_version_target` for exactly that reason:
// so a receiving agent can tell, without guessing, which implementation
// produced it. See scripts/distill_equivalence_check.py (repo root's
// sibling arcaeon-distill checkout) for the cross-language diff this port
// was validated against before shipping.
//
// Body (raw JSON, parsed by THIS module's own parser — see below for why
// the request body is never handed to Vercel's default JSON body parser):
//   { "content": <string|object|array>, "budget"?: <int, default 2000>,
//     "schema_hint"?: "json"|"tabular"|"text", "query"?: <string>,
//     "receipt"?: <bool, default true> }
//
// Auth: Authorization: Bearer <key> — any key present in WITNESS_KEYS (the
// namespace-prefix half of that binding is meaningless here; distill has no
// namespace concept, so only key VALIDITY is checked, same as /api/balance).

"use strict";

const core = require("./_distill_core.js");
const store = require("./_store.js");
const meter = require("./_meter.js");
const balance = require("./_balance.js");

// Vercel's default body parser runs content through JSON.parse, which loses
// exactly the two things this endpoint exists to preserve faithfully (the
// int/float distinction and dict key order — see _distill_core.js's header).
// So body parsing is disabled here and the raw text is fed to this module's
// own parser instead, all the way through.
module.exports.config = { api: { bodyParser: false } };

const MAX_BODY_BYTES = 2_000_000; // 2MB raw body cap — abuse guard, not a product limit

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        reject(Object.assign(new Error("request body too large"), { tooLarge: true }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

// ---- metering + credit charge — same shape as api/pin.js's meterAndCharge,
// minus the store-write concerns pin.js also has to juggle (no namespace,
// no monotonic guard, no wedge). Charged ONLY after distill() has already
// run successfully (below), so a 400 on malformed input burns nothing —
// same "never charge a rejection" discipline pin.js documents.
async function meterAndCharge(key) {
  let m;
  try {
    m = await meter.check(key);
  } catch (err) {
    return { deny: { status: 502, body: { error: `metering store error: ${err.message}` } }, headers: {} };
  }
  const headers = {
    "X-Meter-Cap": m.cap === null || m.cap === undefined ? "unlimited" : String(m.cap),
  };
  if (m.used !== null && m.used !== undefined) headers["X-Meter-Used"] = String(m.used);

  if (m.ok) return { ok: true, source: "free", headers };

  if (m.reason === "over_cap") {
    let c;
    try {
      c = await balance.decrementCredit(key, `over free cap ${m.month} (distill)`);
    } catch (err) {
      return { deny: { status: 502, body: { error: `credit store error: ${err.message}` } }, headers };
    }
    if (c.ok) {
      headers["X-Credit-Balance"] = String(c.balance);
      headers["X-Meter-Source"] = "credit";
      return { ok: true, source: "credit", headers };
    }
    if (c.ever_purchased) {
      return {
        deny: {
          status: 402,
          body: {
            error: "credit balance exhausted — top up to continue",
            reason: "credit_exhausted",
            credit_balance: 0,
            plan: m.plan, free_tier_used: m.used, free_tier_cap: m.cap, month: m.month,
            packs: balance.PACKS,
          },
        },
        headers,
      };
    }
    return {
      deny: {
        status: 429,
        body: {
          error: "monthly distill cap reached",
          reason: "over_cap",
          plan: m.plan, used: m.used, cap: m.cap, month: m.month,
          top_up_available: true, packs: balance.PACKS,
          note: "the free tier is shared across all metered witness endpoints (pin, distill) per key",
        },
      },
      headers,
    };
  }

  return {
    deny: {
      status: 401,
      body: { error: "no usage cap configured for this key", reason: "no_cap_configured" },
    },
    headers,
  };
}

function applyHeaders(res, headers) {
  if (!headers) return;
  for (const k of Object.keys(headers)) res.setHeader(k, headers[k]);
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.setHeader("allow", "POST");
    return res.status(405).json({ error: "POST only" });
  }

  const auth = req.headers.authorization || "";
  const key = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  const prefix = key ? store.keyPrefixFor(key) : null;
  if (prefix === null) {
    return res.status(401).json({ error: "invalid or missing bearer key" });
  }

  let raw;
  try {
    raw = await readRawBody(req);
  } catch (err) {
    if (err && err.tooLarge) return res.status(413).json({ error: "request body exceeds the 2MB cap for this endpoint" });
    return res.status(400).json({ error: `failed to read request body: ${err.message}` });
  }

  let envelope;
  try {
    envelope = core.parseJSON(raw);
  } catch (err) {
    return res.status(400).json({ error: `request body is not valid JSON: ${err.message}` });
  }
  if (!(envelope instanceof Map)) {
    return res.status(400).json({ error: "request body must be a JSON object with a \"content\" field" });
  }

  const contentVal = envelope.get("content");
  if (contentVal === undefined) {
    return res.status(400).json({ error: "missing required field \"content\"" });
  }

  // budget: PyInt -> integer, PyFloat -> its numeric value, absent -> default.
  let budget = 2000;
  const budgetVal = envelope.get("budget");
  if (budgetVal !== undefined) {
    if (budgetVal instanceof core.PyInt) budget = parseInt(budgetVal.raw, 10);
    else if (budgetVal instanceof core.PyFloat) budget = budgetVal.value;
    else return res.status(400).json({ error: "\"budget\" must be a number" });
  }

  const schemaHintVal = envelope.get("schema_hint");
  let schemaHint;
  if (schemaHintVal !== undefined && schemaHintVal !== null) {
    if (typeof schemaHintVal !== "string") return res.status(400).json({ error: "\"schema_hint\" must be a string" });
    schemaHint = schemaHintVal;
  }

  const queryVal = envelope.get("query");
  let query;
  if (queryVal !== undefined && queryVal !== null) {
    if (typeof queryVal !== "string") return res.status(400).json({ error: "\"query\" must be a string" });
    query = queryVal;
  }

  const receiptVal = envelope.get("receipt");
  let wantReceipt = true;
  if (receiptVal !== undefined && receiptVal !== null) {
    if (typeof receiptVal !== "boolean") return res.status(400).json({ error: "\"receipt\" must be a boolean" });
    wantReceipt = receiptVal;
  }

  // --- run distill() (the paid work) ---
  let result;
  try {
    result = core.distill(contentVal, { budget, schemaHint, query, receipt: wantReceipt });
  } catch (err) {
    return res.status(400).json({
      error: `distill failed: ${err.message}`,
      reason: err.name === "TypeError" || err.name === "RangeError" ? "undistillable_input" : "invalid_request",
    });
  }

  // --- charge only after successful compute ---
  const charge = await meterAndCharge(key);
  applyHeaders(res, charge.headers);
  if (charge.deny) return res.status(charge.deny.status).json(charge.deny.body);

  res.setHeader("cache-control", "no-store");
  return res.status(200).json({
    ok: true,
    content: core.toPlain(result.content),
    strategy: result.strategy,
    budget_tokens: result.budget_tokens,
    est_tokens_before: result.est_tokens_before,
    est_tokens_after: result.est_tokens_after,
    truncated: result.truncated,
    receipt: result.receipt,
    implementation: "js-port",
    js_port_version: core.JS_PORT_VERSION,
    py_package_version_target: core.PY_PACKAGE_VERSION_TARGET,
    note: "this endpoint runs a JS port of arcaeon_distill for the hosted try-before-pip demo — not the pip package itself; pip install arcaeon-distill for the canonical implementation",
  });
};
