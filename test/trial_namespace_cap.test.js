// test/trial_namespace_cap.test.js — namespace hygiene for trial keys
// (2026-09-27, pricing council "Anti-abuse controls" 5). A registration key
// (source "register") gets a "trial-<8 hex>-" prefix and may pin under at
// most 3 distinct namespaces until it makes a real purchase; the 4th is 403
// namespace_cap naming the cap and the three. Stripe-minted keys: no cap.
// Mock store only; the mail sender is injected; no network host is reached.
"use strict";

process.env.GITHUB_USAGE_REPO = "test-owner/test-usage";
process.env.GITHUB_PIN_REPO = "test-owner/test-pins";
process.env.GITHUB_PIN_BRANCH = "main";
process.env.GITHUB_PIN_TOKEN = "test-token";
process.env.REGISTER_IP_SALT = "test-salt-not-a-secret";
delete process.env.RESEND_API_KEY;
delete process.env.RESEND_FROM;
delete process.env.WITNESS_KEYS;
delete process.env.WITNESS_PLANS;
delete process.env.WITNESS_CADENCE;

const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const { MockGitHubStore } = require("./helpers/mock_store.js");
const { makeReq, makeRes } = require("./helpers/http_mocks.js");
const store = require("../lib/_store.js");
const balance = require("../lib/_balance.js");
const keys = require("../lib/_keys.js");
const register = require("../lib/_register.js");
const fulfill = require("../api/fulfill.js");
const pin = require("../api/pin.js");

const USAGE = process.env.GITHUB_USAGE_REPO;
const PINS = process.env.GITHUB_PIN_REPO;

let gh, sent, foreignCalls, restoreFetch;
const realPutSleep = store._putRetry.sleep;
const realRetrySleep = register._timing.retrySleep;
const realFloorSleep = register._timing.floorSleep;

beforeEach(() => {
  gh = new MockGitHubStore();
  sent = [];
  foreignCalls = [];
  const original = global.fetch;
  global.fetch = (url, opts) => {
    if (!String(url).startsWith("https://api.github.com/")) {
      foreignCalls.push(String(url));
      return Promise.resolve({ status: 599, ok: false, json: async () => ({}), text: async () => "blocked in tests" });
    }
    return gh.handleFetch(url, opts);
  };
  restoreFetch = () => { global.fetch = original; };
  register.setSender({
    send: async (msg) => { sent.push(msg); return { ok: true }; },
    probe: async () => ({ ok: true }),
  });
  store._putRetry.sleep = async () => {};
  register._timing.retrySleep = async () => {};
  register._timing.floorSleep = async () => {};
  register._timing.reset();
  pin._resetRateBuckets();
});

afterEach(() => {
  assert.deepEqual(foreignCalls, [], "a test reached a non-GitHub host");
  register.setSender(null);
  store._putRetry.sleep = realPutSleep;
  register._timing.retrySleep = realRetrySleep;
  register._timing.floorSleep = realFloorSleep;
  restoreFetch();
});

let ipCounter = 0;
function freshIp() {
  ipCounter += 1;
  return `10.${(ipCounter >> 16) & 255}.${(ipCounter >> 8) & 255}.${ipCounter & 255}`;
}
async function call(req) {
  const res = makeRes();
  await fulfill(req, res);
  return res;
}
async function registerAndConfirm(email) {
  const r = await call(makeReq({
    method: "POST",
    headers: { "x-forwarded-for": freshIp(), accept: "application/json" },
    body: { email },
    query: { op: "register" },
  }));
  assert.equal(r._status, 200, JSON.stringify(r._body));
  const m = /[?&]t=([0-9a-f]{64})/.exec(sent[sent.length - 1].text);
  assert.ok(m, "the email carries a confirm link");
  const c = await call(makeReq({
    method: "POST",
    headers: { accept: "application/json", "x-forwarded-for": freshIp() },
    query: { op: "confirm" },
    body: { t: m[1] },
  }));
  assert.equal(c._status, 200, JSON.stringify(c._body));
  return c._body;
}
async function pinAs(key, namespace, rows) {
  const res = makeRes();
  await pin(makeReq({
    method: "POST",
    headers: { authorization: `Bearer ${key}` },
    body: { namespace, rows, chain: rows.toString(16).padStart(8, "a") },
  }), res);
  return res;
}

test("PREFIX FORMAT: a registration key's prefix is trial-<8 hex>-, recorded in the key record; the stem is reserved to pickers", async () => {
  const c = await registerAndConfirm("fmt@example.com");
  assert.match(c.namespace, /^trial-[0-9a-f]{8}-$/);
  assert.match(c.namespace, keys.TRIAL_PREFIX_RE);
  assert.equal(c.namespace_cap, 3);
  const rec = gh.read(USAGE, keys.issuedKeyPath(keys.keyHash(c.key)));
  assert.equal(rec.source, "register");
  assert.equal(rec.namespace_prefix, c.namespace);
  for (let i = 0; i < 50; i++) assert.match(keys.mintTrialNamespacePrefix(), keys.TRIAL_PREFIX_RE);
  assert.match(keys.mintNamespacePrefix(), /^wk-[0-9a-f]{12}-$/, "the Stripe/random mint is unchanged");
  const v = keys.validatePrefix("trial-mine-");
  assert.equal(v.ok, false);
  assert.equal(v.reason, "reserved");
});

test("CAP: a registration key pins under 3 namespaces; the 4th is 403 namespace_cap naming the cap and the three, charging nothing", async () => {
  const c = await registerAndConfirm("cap@example.com");
  const h = keys.keyHash(c.key);
  const three = ["a", "b", "c"].map((s) => `${c.namespace}${s}`);
  for (const ns of three) {
    const r = await pinAs(c.key, ns, 1);
    assert.equal(r._status, 201, `${ns}: ${JSON.stringify(r._body)}`);
  }
  // advancing and re-pinning inside the three stays fine
  assert.equal((await pinAs(c.key, three[0], 2))._status, 201);
  assert.equal((await pinAs(c.key, three[1], 1))._status, 200, "idempotent re-pin");
  const before = (await balance.readBalance(h)).balance;
  const putsBefore = gh.putLog.length;

  const r4 = await pinAs(c.key, `${c.namespace}d`, 1);
  assert.equal(r4._status, 403, JSON.stringify(r4._body));
  assert.equal(r4._body.reason, "namespace_cap");
  assert.equal(r4._body.cap, 3);
  assert.deepEqual(r4._body.namespaces, three);
  assert.match(r4._body.error, /at most 3 distinct namespaces/);
  for (const ns of three) assert.ok(r4._body.error.includes(ns), `error names ${ns}`);
  assert.equal((await balance.readBalance(h)).balance, before, "the refused pin charged nothing");
  assert.equal(gh.putLog.length, putsBefore, "the refusal wrote nothing");
  assert.equal(gh.has(PINS, `pins/${c.namespace}d/latest.json`), false);
  assert.deepEqual(gh.read(USAGE, keys.trialNamespacesPath(h)).namespaces, three, "durable list in the sibling file");
});

test("CAP IS DURABLE AND CAS: concurrent pins under 4 new namespaces land exactly 3", async () => {
  const c = await registerAndConfirm("race@example.com");
  const nss = ["w", "x", "y", "z"].map((s) => `${c.namespace}${s}`);
  const results = await Promise.all(nss.map((ns) => pinAs(c.key, ns, 1)));
  const statuses = results.map((r) => r._status).sort();
  assert.deepEqual(statuses, [201, 201, 201, 403], JSON.stringify(results.map((r) => r._body)));
  const list = gh.read(USAGE, keys.trialNamespacesPath(keys.keyHash(c.key))).namespaces;
  assert.equal(list.length, 3);
  pin._resetRateBuckets(); // cold start: the cap is in the store, not in memory
  const refused = nss.find((ns) => !list.includes(ns));
  assert.equal((await pinAs(c.key, refused, 1))._status, 403);
});

test("PURCHASE LIFTS THE CAP: after a real pack, the 4th and 5th namespaces pin; the prefix is unchanged; a refund does not lift it", async () => {
  const c = await registerAndConfirm("buyer@example.com");
  const h = keys.keyHash(c.key);
  for (const s of ["a", "b", "c"]) assert.equal((await pinAs(c.key, `${c.namespace}${s}`, 1))._status, 201);
  assert.equal((await pinAs(c.key, `${c.namespace}d`, 1))._status, 403);

  await balance.creditPack(h, "mini", "cs_test_trialbuy1", "stripe-webhook");
  assert.equal((await balance.readBalance(h)).ever_purchased, true);
  assert.equal((await pinAs(c.key, `${c.namespace}d`, 1))._status, 201);
  assert.equal((await pinAs(c.key, `${c.namespace}e`, 1))._status, 201);
  assert.equal(gh.read(USAGE, keys.issuedKeyPath(h)).namespace_prefix, c.namespace, "a prefix is a name, not a tier");

  const c2 = await registerAndConfirm("refund@example.com");
  const h2 = keys.keyHash(c2.key);
  for (const s of ["a", "b", "c"]) assert.equal((await pinAs(c2.key, `${c2.namespace}${s}`, 1))._status, 201);
  await balance.grantCredits(h2, 1, "refund", "refund-t1", "pin-write-failure-refund");
  assert.equal((await pinAs(c2.key, `${c2.namespace}d`, 1))._status, 403, "a refund is not a purchase");
});

test("STRIPE KEY: no cap and no trial-namespace file; env key the same", async () => {
  const key = keys.mintKey();
  const h = keys.keyHash(key);
  gh.seed(USAGE, keys.issuedKeyPath(h), { key_hash: h, namespace_prefix: "stripeco-", plan: "grant", source: "stripe-fulfill" });
  gh.seed(USAGE, balance.balancePath(h), { key_hash: h, balance: 20, seq: 1, purchased: true, applied_events: [] });
  for (const s of ["a", "b", "c", "d", "e"]) {
    const r = await pinAs(key, `stripeco-${s}`, 1);
    assert.equal(r._status, 201, `${s}: ${JSON.stringify(r._body)}`);
  }
  assert.equal(gh.has(USAGE, keys.trialNamespacesPath(h)), false);

  process.env.WITNESS_KEYS = "env-test-key:envco-";
  try {
    for (const s of ["a", "b", "c", "d"]) {
      const r = await pinAs("env-test-key", `envco-${s}`, 1);
      assert.equal(r._status, 201, `${s}: ${JSON.stringify(r._body)}`);
    }
    assert.equal(gh.putLog.filter((w) => w.path.startsWith("trial_namespaces/")).length, 0);
  } finally {
    delete process.env.WITNESS_KEYS;
  }
});

test("FAILS CLOSED: an unreadable namespace store answers 503 and charges nothing", async () => {
  const c = await registerAndConfirm("closed@example.com");
  const h = keys.keyHash(c.key);
  gh.forceFailure(USAGE, keys.trialNamespacesPath(h), 5, 500);
  const r = await pinAs(c.key, `${c.namespace}main`, 1);
  assert.equal(r._status, 503);
  assert.equal(r._body.reason, "namespace_store_error");
  assert.equal((await balance.readBalance(h)).balance, 500);
});
