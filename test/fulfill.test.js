// test/fulfill.test.js — api/fulfill.js: GET/POST /api/fulfill (instant
// fulfillment: Stripe session -> witness key + credits, idempotent per
// session). NO live calls: Stripe's API is mocked alongside the mock GitHub
// store, both behind one patched global.fetch.
"use strict";

process.env.GITHUB_USAGE_REPO = "test-owner/test-usage";
process.env.GITHUB_PIN_REPO = "test-owner/test-pins";
process.env.GITHUB_PIN_TOKEN = "test-token";
process.env.WITNESS_STRIPE_SECRET_KEY = "sk_test_fulfill_mock_only"; // test-only literal, not a real credential
process.env.WITNESS_STRIPE_LIVEMODE = "false"; // fixtures are cs_test_/livemode:false
process.env.WITNESS_STRIPE_PRICE_MAP = JSON.stringify({
  price_mini_test: "mini",
  price_starter_test: "starter",
  price_standard_test: "standard",
  price_bulk_test: "bulk",
});
delete process.env.WITNESS_KEYS; // no env-provisioned keys: exercises the dynamic store
delete process.env.WITNESS_PLANS;

const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const { MockGitHubStore } = require("./helpers/mock_store.js");
const { makeReq, makeRes } = require("./helpers/http_mocks.js");
const balance = require("../lib/_balance.js");
const keys = require("../lib/_keys.js");
const fulfill = require("../api/fulfill.js");
const pin = require("../api/pin.js");

const USAGE = process.env.GITHUB_USAGE_REPO;

// ---- Stripe API mock (GET /v1/checkout/sessions/:id) ----
function fakeResponse(status, bodyObj) {
  const bodyText = JSON.stringify(bodyObj);
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => bodyObj,
    text: async () => bodyText,
  };
}

class MockStripe {
  constructor() {
    this.sessions = new Map();
    this.calls = [];
  }
  seed(session) {
    this.sessions.set(session.id, session);
  }
  async handle(url, opts) {
    this.calls.push({ url: String(url), opts });
    const u = new URL(String(url));
    const m = u.pathname.match(/^\/v1\/checkout\/sessions\/([^/]+)$/);
    if (!m) return fakeResponse(404, { error: { message: "mock: unknown stripe path" } });
    const auth = (opts && opts.headers && (opts.headers.authorization || opts.headers.Authorization)) || "";
    if (auth !== `Bearer ${process.env.WITNESS_STRIPE_SECRET_KEY}`) {
      return fakeResponse(401, { error: { message: "mock: bad api key" } });
    }
    const s = this.sessions.get(decodeURIComponent(m[1]));
    if (!s) {
      return fakeResponse(404, { error: { type: "invalid_request_error", message: "No such checkout.session" } });
    }
    return fakeResponse(200, s);
  }
}

let gh, stripe, restoreFetch;

beforeEach(() => {
  gh = new MockGitHubStore();
  stripe = new MockStripe();
  const original = global.fetch;
  global.fetch = (url, opts) => {
    if (String(url).startsWith("https://api.stripe.com/")) return stripe.handle(url, opts);
    return gh.handleFetch(url, opts);
  };
  restoreFetch = () => { global.fetch = original; };
});

afterEach(() => {
  restoreFetch();
});

// ---- fixtures ----
let sidCounter = 0;
function sid() {
  sidCounter += 1;
  return `cs_test_${String(sidCounter).padStart(4, "0")}${"a".repeat(20)}`;
}

const PACK_CENTS = { mini: 500, starter: 1500, standard: 5000, bulk: 15000 };

function paidSession(over = {}) {
  const pack = over._pack || "starter";
  return {
    id: over.id,
    object: "checkout.session",
    livemode: false,
    status: "complete",
    payment_status: "paid",
    amount_total: PACK_CENTS[pack],
    currency: "usd",
    client_reference_id: null,
    customer_details: { email: "buyer@example.com" },
    metadata: {},
    line_items: { data: [{ price: { id: `price_${pack}_test` } }] },
    ...over,
  };
}

async function call({ query = {}, headers = {}, method = "GET", body = null } = {}) {
  const req = makeReq({ method, headers, body, query });
  const res = makeRes();
  await fulfill(req, res);
  return res;
}

const JSON_HDR = { accept: "application/json" };

// ---------------------------------------------------------------------
// happy path: mint once
// ---------------------------------------------------------------------

test("valid paid session mints a key once — JSON shape {key, credits, namespace, docs_url} + pool fields", async () => {
  const id = sid();
  stripe.seed(paidSession({ id, _pack: "starter" }));
  const res = await call({ query: { session_id: id }, headers: JSON_HDR });

  assert.equal(res._status, 200);
  const b = res._body;
  // the spec's agent-facing shape:
  assert.match(b.key, /^wk_[0-9a-f]{48}$/);
  assert.equal(b.credits, 3000); // starter, via price map (source of truth: PACKS)
  assert.match(b.namespace, /^wk-[0-9a-f]{12}-$/);
  assert.ok(typeof b.docs_url === "string" && b.docs_url.startsWith("http"));
  // org/pool schema baked in:
  assert.match(b.pool_id, /^pool_[0-9a-f]{16}$/);
  assert.equal(b.org, null);
  assert.equal(b.mode, "new_key");
  assert.equal(b.already_fulfilled, false);
  assert.equal(b.consent_product_updates, false); // default UNCHECKED

  // storage: session binding + key record + pool record + credited balance
  const hash = keys.keyHash(b.key);
  const binding = gh.read(USAGE, `fulfillments/${id}.json`);
  assert.equal(binding.key, b.key);
  assert.equal(binding.consent_product_updates, false);
  assert.equal(binding.email, "buyer@example.com");
  const keyRec = gh.read(USAGE, `keys/${hash}.json`);
  assert.equal(keyRec.namespace_prefix, b.namespace);
  assert.equal(keyRec.pool_id, b.pool_id);
  assert.equal(keyRec.org, null);
  const poolRec = gh.read(USAGE, `pools/${b.pool_id}.json`);
  assert.equal(poolRec.credit_account, hash); // solo pool: pool draws the key's own balance file
  assert.deepEqual(poolRec.member_key_hashes, [hash]);
  const bal = await balance.readBalance(hash);
  assert.equal(bal.balance, 3000);
});

// ---------------------------------------------------------------------
// idempotent re-retrieval (the recovery path)
// ---------------------------------------------------------------------

test("revisit with the same session_id re-shows the SAME key and never double-credits", async () => {
  const id = sid();
  stripe.seed(paidSession({ id, _pack: "mini" }));

  const first = await call({ query: { session_id: id }, headers: JSON_HDR });
  assert.equal(first._status, 200);
  const second = await call({ query: { session_id: id }, headers: JSON_HDR });
  assert.equal(second._status, 200);

  assert.equal(second._body.key, first._body.key); // same key, never minted twice
  assert.equal(second._body.already_fulfilled, true);
  const bal = await balance.readBalance(keys.keyHash(first._body.key));
  assert.equal(bal.balance, 1000); // mini credited exactly once across both visits
});

test("a pre-existing session binding wins over minting (create-race / prior-visit shape)", async () => {
  const id = sid();
  stripe.seed(paidSession({ id, _pack: "mini" }));
  // simulate a concurrent/prior visit having already bound this session
  const winnerKey = keys.mintKey();
  gh.seed(USAGE, `fulfillments/${id}.json`, {
    session_id: id, mode: "new_key", key: winnerKey, key_hash: keys.keyHash(winnerKey),
    namespace_prefix: "wk-aaaaaaaaaaaa-", pack: "mini", credits: 1000,
    pool_id: "pool_bbbbbbbbbbbbbbbb", org: null, email: null,
    consent_product_updates: false, created_at: new Date().toISOString(),
  });
  const res = await call({ query: { session_id: id }, headers: JSON_HDR });
  assert.equal(res._status, 200);
  assert.equal(res._body.key, winnerKey); // serves the winner's key, discards any fresh mint
});

// ---------------------------------------------------------------------
// denials — a faked/unpaid URL never yields a key
// ---------------------------------------------------------------------

test("unknown session id (Stripe 404) -> clean 404 denial, nothing provisioned", async () => {
  const id = sid(); // never seeded in the Stripe mock
  const res = await call({ query: { session_id: id }, headers: JSON_HDR });
  assert.equal(res._status, 404);
  assert.equal(res._body.reason, "unknown_session");
  assert.equal(res._body.key, undefined);
  assert.equal(gh.read(USAGE, `fulfillments/${id}.json`), null);
});

test("unpaid session -> 402 denial, nothing provisioned", async () => {
  const id = sid();
  stripe.seed(paidSession({ id, payment_status: "unpaid" }));
  const res = await call({ query: { session_id: id }, headers: JSON_HDR });
  assert.equal(res._status, 402);
  assert.equal(res._body.reason, "session_not_paid");
  assert.equal(res._body.key, undefined);
  assert.equal(gh.read(USAGE, `fulfillments/${id}.json`), null);
});

test("incomplete (open) session -> 402 even if payment_status lies 'paid'", async () => {
  const id = sid();
  stripe.seed(paidSession({ id, status: "open" }));
  const res = await call({ query: { session_id: id }, headers: JSON_HDR });
  assert.equal(res._status, 402);
});

test("malformed session_id is rejected 400 BEFORE Stripe is ever called", async () => {
  const res = await call({ query: { session_id: "../../etc/passwd" }, headers: JSON_HDR });
  assert.equal(res._status, 400);
  assert.equal(stripe.calls.length, 0); // never reached the network
});

test("livemode mismatch -> 403 denial (test session against live-expecting service)", async () => {
  const id = sid();
  stripe.seed(paidSession({ id, livemode: true })); // env says expect test mode
  const res = await call({ query: { session_id: id }, headers: JSON_HDR });
  assert.equal(res._status, 403);
  assert.equal(res._body.reason, "livemode_mismatch");
});

test("amount/pack mismatch -> 409, NOT fulfilled (metadata cannot outrank money)", async () => {
  const id = sid();
  // metadata claims bulk ($150 worth) but only $5 was paid; no price map hit
  stripe.seed(paidSession({
    id, metadata: { pack: "bulk" }, amount_total: 500,
    line_items: { data: [{ price: { id: "price_unmapped" } }] },
  }));
  const res = await call({ query: { session_id: id }, headers: JSON_HDR });
  assert.equal(res._status, 409);
  assert.equal(res._body.reason, "amount_mismatch");
  assert.equal(gh.read(USAGE, `fulfillments/${id}.json`), null);
});

test("missing Stripe secret key -> 501 fail-closed with the named human step", async () => {
  const saved = process.env.WITNESS_STRIPE_SECRET_KEY;
  delete process.env.WITNESS_STRIPE_SECRET_KEY;
  delete process.env.STRIPE_SECRET_KEY;
  try {
    const res = await call({ query: { session_id: sid() }, headers: JSON_HDR });
    assert.equal(res._status, 501);
    assert.ok(res._body.human_step.includes("WITNESS_STRIPE_SECRET_KEY"));
  } finally {
    process.env.WITNESS_STRIPE_SECRET_KEY = saved;
  }
});

// ---------------------------------------------------------------------
// price -> pack mapping
// ---------------------------------------------------------------------

test("pack resolves from line-item price id via WITNESS_STRIPE_PRICE_MAP (preferred path)", async () => {
  const id = sid();
  // amount deliberately overpaid; the price id is what names the pack
  stripe.seed(paidSession({ id, _pack: "bulk", amount_total: 20000 }));
  const res = await call({ query: { session_id: id }, headers: JSON_HDR });
  assert.equal(res._status, 200);
  assert.equal(res._body.credits, 40000);
  assert.equal(res._body.pack, "bulk");
});

test("pack falls back to metadata.pack (webhook convention), then amount_total", async () => {
  // metadata path
  const id1 = sid();
  stripe.seed(paidSession({
    id: id1, metadata: { pack: " Standard " }, amount_total: 5000,
    line_items: { data: [{ price: { id: "price_unmapped" } }] },
  }));
  const r1 = await call({ query: { session_id: id1 }, headers: JSON_HDR });
  assert.equal(r1._status, 200);
  assert.equal(r1._body.credits, 12000); // normalized " Standard " -> standard

  // pure amount_total path (no price map hit, no metadata)
  const id2 = sid();
  stripe.seed(paidSession({
    id: id2, amount_total: 1500, metadata: {},
    line_items: { data: [{ price: { id: "price_unmapped" } }] },
  }));
  const r2 = await call({ query: { session_id: id2 }, headers: JSON_HDR });
  assert.equal(r2._status, 200);
  assert.equal(r2._body.credits, 3000); // $15.00 -> starter, derived from PACKS
});

test("paid but unmappable purchase -> 409 unmapped_purchase (manual fulfillment, support named)", async () => {
  const id = sid();
  stripe.seed(paidSession({
    id, amount_total: 777, metadata: {},
    line_items: { data: [{ price: { id: "price_unmapped" } }] },
  }));
  const res = await call({ query: { session_id: id }, headers: JSON_HDR });
  assert.equal(res._status, 409);
  assert.equal(res._body.reason, "unmapped_purchase");
  assert.equal(res._body.support, "support@arcaeon.io");
});

// ---------------------------------------------------------------------
// dual response: HTML for humans, JSON for agents
// ---------------------------------------------------------------------

test("HTML page (default) shows the key big, quickstart, support email, consent line; no-store; key never in a URL", async () => {
  const id = sid();
  stripe.seed(paidSession({ id, _pack: "mini" }));
  const res = await call({ query: { session_id: id } }); // no Accept: json
  assert.equal(res._status, 200);
  assert.equal(res._headers["content-type"], "text/html; charset=utf-8");
  assert.equal(res._headers["cache-control"], "no-store");
  const html = String(res._body);
  const key = gh.read(USAGE, `fulfillments/${id}.json`).key;
  assert.ok(html.includes(key)); // key renders in the BODY
  assert.ok(!/href="[^"]*wk_/.test(html)); // ...and never inside any URL
  assert.ok(html.includes("support@arcaeon.io"));
  assert.ok(html.includes("consent=yes")); // the one-line consent link
  assert.ok(html.includes("/api/pin")); // quickstart present
});

test("?format=json returns JSON without an Accept header", async () => {
  const id = sid();
  stripe.seed(paidSession({ id, _pack: "mini" }));
  const res = await call({ query: { session_id: id, format: "json" } });
  assert.equal(res._status, 200);
  assert.match(res._body.key, /^wk_/); // parsed object, not HTML
});

// ---------------------------------------------------------------------
// consent capture
// ---------------------------------------------------------------------

test("consent defaults UNCHECKED; &consent=yes stores it on the fulfillment record", async () => {
  const id = sid();
  stripe.seed(paidSession({ id, _pack: "mini" }));
  await call({ query: { session_id: id }, headers: JSON_HDR });
  assert.equal(gh.read(USAGE, `fulfillments/${id}.json`).consent_product_updates, false);

  const res = await call({ query: { session_id: id, consent: "yes" }, headers: JSON_HDR });
  assert.equal(res._status, 200);
  assert.equal(res._body.consent_product_updates, true);
  const rec = gh.read(USAGE, `fulfillments/${id}.json`);
  assert.equal(rec.consent_product_updates, true);
  assert.ok(typeof rec.consent_at === "string");
});

// ---------------------------------------------------------------------
// existing-key top-up branch
// ---------------------------------------------------------------------

test("session with client_reference_id = sha256(existing key) credits THAT key, mints nothing", async () => {
  const existingHash = balance.keyHash("existing-env-key");
  const id = sid();
  stripe.seed(paidSession({ id, _pack: "standard", client_reference_id: existingHash.toUpperCase() })); // caps: H3 normalization
  const res = await call({ query: { session_id: id }, headers: JSON_HDR });
  assert.equal(res._status, 200);
  assert.equal(res._body.mode, "topup");
  assert.equal(res._body.key, undefined); // nothing to show — we never knew the raw key
  assert.equal(res._body.credits, 12000);
  const bal = await balance.readBalance(existingHash);
  assert.equal(bal.balance, 12000);
  assert.equal(gh.read(USAGE, `fulfillments/${id}.json`), null); // no binding minted
});

// ---------------------------------------------------------------------
// the minted key is REAL: it authenticates against /api/pin
// ---------------------------------------------------------------------

test("a freshly minted key pins under its namespace prefix via /api/pin (dynamic key store auth)", async () => {
  const id = sid();
  stripe.seed(paidSession({ id, _pack: "mini" }));
  const fres = await call({ query: { session_id: id }, headers: JSON_HDR });
  assert.equal(fres._status, 200);
  const { key, namespace } = fres._body;

  const req = makeReq({
    method: "POST",
    headers: { authorization: `Bearer ${key}` },
    body: { namespace: `${namespace}main`, rows: 1, chain: "deadbeefdeadbeef" },
  });
  const res = makeRes();
  await pin(req, res);
  assert.equal(res._status, 201);
  assert.equal(res._body.pin.namespace, `${namespace}main`);

  // and OUTSIDE its prefix it is refused (prefix binding is real, not cosmetic)
  const req2 = makeReq({
    method: "POST",
    headers: { authorization: `Bearer ${key}` },
    body: { namespace: "someone-elses-ns", rows: 1, chain: "deadbeefdeadbeef" },
  });
  const res2 = makeRes();
  await pin(req2, res2);
  assert.equal(res2._status, 403);
});
