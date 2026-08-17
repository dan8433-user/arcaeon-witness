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
  // rev-2: the JSON no-form path auto-suggests the prefix from the buyer's
  // email local part (buyer@example.com -> "buyer-"); response carries it.
  assert.equal(b.namespace, "buyer-");
  assert.equal(b.prefix_source, "suggested");
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

test("HTML success page shows the key in a copy-box, brand, quickstart, support, consent line; no-store; key never in a URL", async () => {
  const id = sid();
  stripe.seed(paidSession({ id, _pack: "mini" }));
  // rev-2: the human first visit renders the picker form; mint via the form
  // POST, then a plain GET revisit shows the key page (the receipt-link view).
  const minted = await call({ method: "POST", body: { session_id: id, prefix: "copybox-buyer-" } });
  assert.equal(minted._status, 200);
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
  // rev-2 ceremony: Arcaeon wordmark + copy-boxes for the key AND pip install
  assert.ok(html.includes(">Arcaeon</div>"));
  assert.ok(html.includes('data-copy-target="key"'));
  assert.ok(html.includes('data-copy-target="pip"'));
  assert.ok(html.includes("pip install arcaeon-ledger"));
  assert.ok(html.includes("navigator.clipboard")); // vanilla-JS copy wired
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

// ---------------------------------------------------------------------
// rev-2: the prefix picker (board item 27)
// ---------------------------------------------------------------------

const welcome = require("../lib/_welcome_email.js");

// Seed an issued-key record so its prefix is "spoken for" in the store.
function seedIssuedPrefix(prefix) {
  const hash = keys.keyHash(`seed-${prefix}-${Math.random()}`);
  gh.seed(USAGE, `keys/${hash}.json`, {
    key_hash: hash, key_id: hash.slice(0, 12), namespace_prefix: prefix,
    plan: "free", org: null, pool_id: "pool_seedseedseedseed",
    source: "test-seed", created_at: new Date().toISOString(),
  });
}

test("rev-2: first-visit HTML GET renders the prefix-picker form — session verified, NOTHING minted", async () => {
  const id = sid();
  stripe.seed(paidSession({ id, _pack: "starter" }));
  const res = await call({ query: { session_id: id } }); // human, no Accept: json
  assert.equal(res._status, 200);
  assert.equal(res._headers["content-type"], "text/html; charset=utf-8");
  const html = String(res._body);
  assert.ok(html.includes('<form method="post"'));
  assert.ok(html.includes('name="prefix"'));
  assert.ok(html.includes('value="buyer-"')); // pre-suggested from buyer@example.com
  assert.ok(html.includes(`value="${id}"`)); // hidden session_id for the POST back
  assert.ok(html.includes(">Arcaeon</div>")); // wordmark on the ceremony page too
  assert.ok(!html.includes("wk_")); // no key anywhere — nothing was minted
  assert.equal(gh.read(USAGE, `fulfillments/${id}.json`), null);
  assert.equal(gh.putLog.length, 0); // zero store writes of any kind
  assert.ok(stripe.calls.length >= 1); // but the session WAS verified first
});

test("rev-2: form POST with a valid custom prefix mints under it (the form->POST mint path)", async () => {
  const id = sid();
  stripe.seed(paidSession({ id, _pack: "mini" }));
  const res = await call({ method: "POST", body: { session_id: id, prefix: "acme-" } });
  assert.equal(res._status, 200);
  const html = String(res._body);
  const rec = gh.read(USAGE, `fulfillments/${id}.json`);
  assert.equal(rec.namespace_prefix, "acme-");
  assert.equal(rec.prefix_source, "custom");
  assert.ok(html.includes(rec.key)); // the key page, not the form
  assert.ok(html.includes("acme-"));
  const keyRec = gh.read(USAGE, `keys/${rec.key_hash}.json`);
  assert.equal(keyRec.namespace_prefix, "acme-"); // the binding /api/pin enforces
});

test("rev-2: form POST normalizes case/whitespace before validating (voice-to-text-proof H3 discipline)", async () => {
  const id = sid();
  stripe.seed(paidSession({ id, _pack: "mini" }));
  const res = await call({ method: "POST", body: { session_id: id, prefix: "  Acme-Labs-  " } });
  assert.equal(res._status, 200);
  assert.equal(gh.read(USAGE, `fulfillments/${id}.json`).namespace_prefix, "acme-labs-");
});

test("rev-2: taken prefix on the HTML form re-renders the form with a clear message, mints nothing", async () => {
  const id = sid();
  stripe.seed(paidSession({ id, _pack: "mini" }));
  seedIssuedPrefix("acme-");
  const res = await call({ method: "POST", body: { session_id: id, prefix: "acme-" } });
  assert.equal(res._status, 409);
  const html = String(res._body);
  assert.ok(html.includes('<form method="post"')); // back to the form
  assert.ok(html.includes("taken")); // the clear message
  assert.ok(html.includes('value="acme-"')); // their pick kept editable
  assert.equal(gh.read(USAGE, `fulfillments/${id}.json`), null); // nothing minted
});

test("rev-2: two-way overlap rejected in BOTH directions (JSON 409 prefix_taken), nothing minted", async () => {
  // direction 1: existing "acme-" IS a prefix of the new "acme-labs-"
  const id1 = sid();
  stripe.seed(paidSession({ id: id1, _pack: "mini" }));
  seedIssuedPrefix("acme-");
  const r1 = await call({ query: { session_id: id1, prefix: "acme-labs-" }, headers: JSON_HDR });
  assert.equal(r1._status, 409);
  assert.equal(r1._body.reason, "prefix_taken");
  assert.equal(gh.read(USAGE, `fulfillments/${id1}.json`), null);

  // direction 2: the new "zeta-" IS a prefix of an existing "zeta-labs-"
  const id2 = sid();
  stripe.seed(paidSession({ id: id2, _pack: "mini" }));
  seedIssuedPrefix("zeta-labs-");
  const r2 = await call({ query: { session_id: id2, prefix: "zeta-" }, headers: JSON_HDR });
  assert.equal(r2._status, 409);
  assert.equal(r2._body.reason, "prefix_taken");
  assert.equal(gh.read(USAGE, `fulfillments/${id2}.json`), null);

  // a dash-bounded near-miss is NOT an overlap: "acm-" vs existing "acme-"
  const id3 = sid();
  stripe.seed(paidSession({ id: id3, _pack: "mini" }));
  const r3 = await call({ query: { session_id: id3, prefix: "acm-" }, headers: JSON_HDR });
  assert.equal(r3._status, 200);
  assert.equal(r3._body.namespace, "acm-");
});

test("rev-2: illegal prefixes rejected 400 bad_prefix (chars, no trailing dash, leading dash, empty, reserved wk-)", async () => {
  for (const bad of ["acme_labs-", "acme", "-acme-", "", "wk-mine-"]) {
    const id = sid();
    stripe.seed(paidSession({ id, _pack: "mini" }));
    const res = await call({ query: { session_id: id, prefix: bad }, headers: JSON_HDR });
    assert.equal(res._status, 400, `prefix ${JSON.stringify(bad)} must be rejected`);
    assert.equal(res._body.reason, "bad_prefix");
    assert.equal(gh.read(USAGE, `fulfillments/${id}.json`), null);
  }
});

test("rev-2: JSON with ?prefix= mints under the chosen prefix and the key really pins there", async () => {
  const id = sid();
  stripe.seed(paidSession({ id, _pack: "mini" }));
  const res = await call({ query: { session_id: id, prefix: "my-agent-" }, headers: JSON_HDR });
  assert.equal(res._status, 200);
  assert.equal(res._body.namespace, "my-agent-"); // JSON response carries the chosen prefix
  assert.equal(res._body.prefix_source, "custom");

  const req = makeReq({
    method: "POST",
    headers: { authorization: `Bearer ${res._body.key}` },
    body: { namespace: "my-agent-prod", rows: 1, chain: "deadbeefdeadbeef" },
  });
  const pres = makeRes();
  await pin(req, pres);
  assert.equal(pres._status, 201);
});

test("rev-2: JSON without ?prefix= keeps working (POST too) — auto-suggested prefix, no form roundtrip", async () => {
  const id = sid();
  stripe.seed(paidSession({ id, _pack: "mini" }));
  const res = await call({ method: "POST", body: { session_id: id }, headers: JSON_HDR });
  assert.equal(res._status, 200);
  assert.equal(res._body.namespace, "buyer-");
  assert.equal(res._body.prefix_source, "suggested");
});

test("rev-2: auto-suggest FALLS BACK to the random wk- mint when the suggestion is taken (never fails)", async () => {
  const id = sid();
  stripe.seed(paidSession({ id, _pack: "mini" }));
  seedIssuedPrefix("buyer-"); // someone already owns the email-derived suggestion
  const res = await call({ query: { session_id: id }, headers: JSON_HDR });
  assert.equal(res._status, 200);
  assert.match(res._body.namespace, /^wk-[0-9a-f]{12}-$/);
  assert.equal(res._body.prefix_source, "random");
});

test("rev-2: suggestion is sanitized from a messy email local part", async () => {
  const id = sid();
  stripe.seed(paidSession({
    id, _pack: "mini",
    customer_details: { email: "Weird.Local+Tag@example.com" },
  }));
  const res = await call({ query: { session_id: id }, headers: JSON_HDR });
  assert.equal(res._status, 200);
  assert.equal(res._body.namespace, "weird-local-tag-");
});

test("rev-2: env WITNESS_KEYS prefixes count as taken for the overlap check", async () => {
  process.env.WITNESS_KEYS = "some-env-key:envcorp-";
  try {
    const id = sid();
    stripe.seed(paidSession({ id, _pack: "mini" }));
    const res = await call({ query: { session_id: id, prefix: "envcorp-agents-" }, headers: JSON_HDR });
    assert.equal(res._status, 409);
    assert.equal(res._body.reason, "prefix_taken");
  } finally {
    delete process.env.WITNESS_KEYS;
  }
});

test("rev-2: an EXISTING fulfillment is unaffected — key re-shown, no form, ?prefix= ignored", async () => {
  const id = sid();
  stripe.seed(paidSession({ id, _pack: "mini" }));
  const minted = await call({ query: { session_id: id }, headers: JSON_HDR });
  assert.equal(minted._status, 200);

  // HTML revisit with a stray ?prefix= — the picker only exists at first mint
  const res = await call({ query: { session_id: id, prefix: "hijack-" } });
  assert.equal(res._status, 200);
  const html = String(res._body);
  assert.ok(html.includes(minted._body.key)); // the key page, same key
  assert.ok(!html.includes('name="prefix"')); // not the form
  assert.equal(gh.read(USAGE, `fulfillments/${id}.json`).namespace_prefix, minted._body.namespace);

  // JSON revisit with a different ?prefix= — also ignored, same key back
  const res2 = await call({ query: { session_id: id, prefix: "hijack-" }, headers: JSON_HDR });
  assert.equal(res2._status, 200);
  assert.equal(res2._body.key, minted._body.key);
  assert.equal(res2._body.namespace, minted._body.namespace);
});

// ---------------------------------------------------------------------
// rev-2: welcome email template (lib/_welcome_email.js)
// ---------------------------------------------------------------------

test("rev-2: welcome email renders branded HTML with key, prefix, credits, pip command — key never in a URL", async () => {
  const record = {
    session_id: "cs_test_welcome0000000000000000",
    key: "wk_" + "ab".repeat(24),
    namespace_prefix: "acme-",
    credits: 3000,
    email: "buyer@example.com",
  };
  const html = welcome.renderWelcomeEmailHtml(record);
  assert.ok(html.includes(record.key));
  assert.ok(html.includes("acme-"));
  assert.ok(html.includes("3000"));
  assert.ok(html.includes("Arcaeon"));
  assert.ok(html.includes("pip install arcaeon-ledger"));
  assert.ok(html.includes("support@arcaeon.io"));
  assert.ok(!/href="[^"]*wk_/.test(html)); // house rule: key only in body text
  assert.ok(!html.includes("<style")); // email clients strip <style>; inline only

  const text = welcome.renderWelcomeEmailText(record);
  assert.ok(text.includes(record.key));
  assert.ok(text.includes("acme-"));
  assert.ok(text.includes("pip install arcaeon-ledger"));
  assert.ok(!/<[a-z]+[\s>]/.test(text)); // no markup tags (the <YOUR KEY> placeholder is fine)
  assert.equal(typeof welcome.WELCOME_SUBJECT, "string");
});

test("rev-2: first mint renders the welcome email through the stub without breaking fulfillment", async () => {
  // The stub logs instead of sending (no mail mechanism); this proves the
  // real template renders on the live mint path with a REAL record shape.
  const logged = [];
  const origLog = console.log;
  console.log = (...a) => logged.push(a.join(" "));
  try {
    const id = sid();
    stripe.seed(paidSession({ id, _pack: "mini" }));
    const res = await call({ query: { session_id: id }, headers: JSON_HDR });
    assert.equal(res._status, 200);
  } finally {
    console.log = origLog;
  }
  assert.ok(logged.some((l) => l.includes("welcome-email") && l.includes("B html")));
});
