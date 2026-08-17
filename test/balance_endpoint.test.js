// test/balance_endpoint.test.js — api/balance.js: the ENDPOINT (the lib
// ledger underneath it is test/balance.test.js's job). Two contracts live
// here since the rev-2 human page (founder design 34378):
//
//   1. The JSON contract is UNCHANGED — same fields, same auth, same errors,
//      and (the load-bearing regression) a bare curl with Accept: */* still
//      gets JSON, never the HTML page. Content negotiation must not repaint
//      an existing API caller.
//   2. The HTML page: browser GET renders the paste-your-key form (password
//      field, POST — the key never in any URL), POST renders the balance or
//      re-renders the form with a clean error that never echoes the key.
"use strict";

process.env.GITHUB_USAGE_REPO = "test-owner/test-usage";
process.env.GITHUB_PIN_TOKEN = "test-token";
process.env.WITNESS_KEYS = "balance-env-key:acme-";
delete process.env.WITNESS_PLANS;

const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const { MockGitHubStore, install } = require("./helpers/mock_store.js");
const { makeReq, makeRes } = require("./helpers/http_mocks.js");
const balanceLib = require("../lib/_balance.js");
const meter = require("../lib/_meter.js");
const page = require("../lib/_page.js");
const handler = require("../api/balance.js");

const KEY = "balance-env-key";
const KEY_HASH = balanceLib.keyHash(KEY);

// A realistic browser Accept header — the ONLY thing that opts into HTML.
const BROWSER_ACCEPT =
  "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,*/*;q=0.8";

let gh, restore;

beforeEach(() => {
  gh = new MockGitHubStore();
  restore = install(gh);
});

afterEach(() => {
  restore();
});

async function call({ method = "GET", headers = {}, body = null, query = {} } = {}) {
  const req = makeReq({ method, headers, body, query });
  const res = makeRes();
  await handler(req, res);
  return res;
}

// ---------------------------------------------------------------------
// 1. JSON contract regression — unchanged by the page
// ---------------------------------------------------------------------

test("CONTRACT (JSON): GET with valid Bearer returns the exact pre-page response shape", async () => {
  const res = await call({ headers: { authorization: `Bearer ${KEY}`, accept: "application/json" } });
  assert.equal(res._status, 200);
  assert.equal(res._headers["cache-control"], "no-store");
  // Exact-field assertion: any added, renamed, or dropped field fails here.
  assert.deepEqual(res._body, {
    ok: true,
    key_id: KEY_HASH.slice(0, 12),
    credit_balance: 0,
    credit_ever_purchased: false,
    credit_updated_at: null,
    free_tier: {
      plan: "free",
      month: meter.utcMonth(),
      used: 0,
      cap: 100,
    },
  });
});

test("REGRESSION (JSON default): a bare-curl GET (Accept: */*) still gets JSON, never the HTML page", async () => {
  // curl sends Accept: */* unless told otherwise — this is THE existing agent
  // caller the content negotiation must not repaint.
  const res = await call({ headers: { authorization: `Bearer ${KEY}`, accept: "*/*" } });
  assert.equal(res._status, 200);
  assert.equal(typeof res._body, "object");
  assert.equal(res._body.ok, true);
  assert.equal(res._body.credit_balance, 0);
  assert.notEqual(res._headers["content-type"], "text/html; charset=utf-8");

  // ...and with no Accept header at all, same thing.
  const res2 = await call({ headers: { authorization: `Bearer ${KEY}` } });
  assert.equal(res2._status, 200);
  assert.equal(res2._body.ok, true);
});

test("CONTRACT (JSON): invalid/missing bearer key is the same 401 body as before", async () => {
  const bad = await call({ headers: { authorization: "Bearer not-a-real-key", accept: "application/json" } });
  assert.equal(bad._status, 401);
  assert.deepEqual(bad._body, { error: "invalid or missing bearer key" });

  const missing = await call({ headers: { accept: "application/json" } });
  assert.equal(missing._status, 401);
  assert.deepEqual(missing._body, { error: "invalid or missing bearer key" });
});

test("CONTRACT (JSON): non-GET without a browser Accept keeps the original 405 GET-only error", async () => {
  const res = await call({ method: "POST", headers: { accept: "application/json" }, body: { key: KEY } });
  assert.equal(res._status, 405);
  assert.deepEqual(res._body, { error: "GET only" });
  assert.equal(res._headers["allow"], "GET");
});

test("JSON reflects a purchased pack (endpoint wired to the real ledger)", async () => {
  await balanceLib.creditPack(KEY_HASH, "mini", "evt-balance-endpoint-1", "test");
  const res = await call({ headers: { authorization: `Bearer ${KEY}`, accept: "application/json" } });
  assert.equal(res._status, 200);
  assert.equal(res._body.credit_balance, 1000);
  assert.equal(res._body.credit_ever_purchased, true);
});

// ---------------------------------------------------------------------
// 2. HTML mode — the human page
// ---------------------------------------------------------------------

test("browser GET without a key renders the paste-your-key form: password input, POST method, key never in a URL", async () => {
  const res = await call({ headers: { accept: BROWSER_ACCEPT } });
  assert.equal(res._status, 200);
  assert.equal(res._headers["content-type"], "text/html; charset=utf-8");
  assert.equal(res._headers["cache-control"], "no-store");
  const html = String(res._body);
  assert.ok(html.includes('<form method="post"'), "form must POST");
  assert.ok(!/method="get"/i.test(html), "no GET form anywhere");
  assert.ok(html.includes('type="password"'), "key field is type=password");
  assert.ok(html.includes('name="key"'));
  assert.ok(html.includes(">Arcaeon</div>"), "brand shell present");
  assert.ok(html.includes("Bearer"), "agent path taught on the front door");
  // remember-my-key is client-side only, default OFF:
  assert.ok(html.includes('type="checkbox"'));
  assert.ok(!/<input[^>]*type="checkbox"[^>]*\schecked/.test(html), "remember checkbox defaults OFF (no checked attribute)");
  assert.ok(html.includes("localStorage"));
});

test("browser POST with a valid key renders the balance: credits, free tier, prefix, curl copy-box — key never echoed", async () => {
  await balanceLib.creditPack(KEY_HASH, "starter", "evt-balance-endpoint-2", "test");
  const res = await call({ method: "POST", headers: { accept: BROWSER_ACCEPT }, body: { key: KEY } });
  assert.equal(res._status, 200);
  assert.equal(res._headers["content-type"], "text/html; charset=utf-8");
  const html = String(res._body);
  assert.ok(html.includes("3000"), "prepaid credits shown");
  assert.ok(html.includes("of 100 used"), "free tier cap shown");
  assert.ok(html.includes("100 remaining"), "free tier remaining computed");
  assert.ok(html.includes("acme-"), "namespace prefix shown");
  assert.ok(html.includes(KEY_HASH.slice(0, 12)), "key id shown");
  assert.ok(html.includes('data-copy-target="curl"'), "curl one-liner in a copy-box");
  assert.ok(html.includes("/api/balance"), "the copy-box teaches the JSON path");
  assert.ok(html.includes("&lt;YOUR KEY&gt;"), "curl line uses a placeholder");
  assert.ok(!html.includes(KEY), "the raw key is NEVER echoed into the page");
});

test("browser POST with an invalid key re-renders the form with a clean error and does NOT echo the key", async () => {
  const attempted = "wk_totally_bogus_key_1234567890";
  const res = await call({ method: "POST", headers: { accept: BROWSER_ACCEPT }, body: { key: attempted } });
  assert.equal(res._status, 401);
  const html = String(res._body);
  assert.ok(html.includes('class="error"'), "inline error present");
  assert.ok(html.includes("isn&#39;t recognized") || html.includes("isn't recognized"), "clean message");
  assert.ok(html.includes('<form method="post"'), "the form again");
  assert.ok(!html.includes(attempted), "the attempted key is never echoed");
});

test("browser POST with an empty key gets the form back with a message (400), nothing leaked", async () => {
  const res = await call({ method: "POST", headers: { accept: BROWSER_ACCEPT }, body: {} });
  assert.equal(res._status, 400);
  const html = String(res._body);
  assert.ok(html.includes('class="error"'));
  assert.ok(html.includes('<form method="post"'));
});

test("browser GET with an Authorization header renders the HTML balance (header path, per the design)", async () => {
  const res = await call({
    headers: { accept: BROWSER_ACCEPT, authorization: `Bearer ${KEY}` },
  });
  assert.equal(res._status, 200);
  assert.equal(res._headers["content-type"], "text/html; charset=utf-8");
  const html = String(res._body);
  assert.ok(html.includes("acme-"));
  assert.ok(!html.includes(KEY), "key not echoed on the header path either");
});

// ---------------------------------------------------------------------
// 3. the extracted template still carries fulfill's ceremony
//    (fulfill.test.js exercises api/fulfill.js end-to-end on the same
//    shared shell; this pins the lib/_page.js markers both pages rely on)
// ---------------------------------------------------------------------

test("REGRESSION (extraction): lib/_page.js pageShell/copyBox render the ceremony markers fulfill's pages assert on", async () => {
  const html = page.pageShell("t", page.copyBox("key", "wk_example") + page.copyBox("pip", "pip install arcaeon-ledger"));
  assert.ok(html.includes(">Arcaeon</div>"), "wordmark");
  assert.ok(html.includes('data-copy-target="key"'));
  assert.ok(html.includes('data-copy-target="pip"'));
  assert.ok(html.includes("navigator.clipboard"), "vanilla-JS copy wired once in the shell");
  assert.ok(html.includes("support@arcaeon.io"));
  assert.equal(page.esc('<a b="c">&'), "&lt;a b=&quot;c&quot;&gt;&amp;");
});
