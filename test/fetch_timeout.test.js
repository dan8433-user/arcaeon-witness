// test/fetch_timeout.test.js — lib/_fetch.js timedFetch (2026-09-27,
// registration release gate item 3): every outbound store / mail / Stripe
// call carries an AbortController timeout (WITNESS_FETCH_TIMEOUT_MS, default
// 10 s). A call that never answers is aborted at the timeout and reads as a
// store error, so the caller's existing 503/502 paths and refunds run.
"use strict";

process.env.GITHUB_USAGE_REPO = "test-owner/test-usage";
process.env.GITHUB_PIN_REPO = "test-owner/test-pins";
process.env.GITHUB_PIN_BRANCH = "main";
process.env.GITHUB_PIN_TOKEN = "test-token";
process.env.REGISTER_IP_SALT = "test-salt-not-a-secret";
process.env.WITNESS_KEYS = "testkeyA:demo-";
delete process.env.RESEND_API_KEY;
delete process.env.RESEND_FROM;
delete process.env.WITNESS_PLANS;
delete process.env.WITNESS_CADENCE;
delete process.env.WITNESS_FETCH_TIMEOUT_MS;

const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const { MockGitHubStore } = require("./helpers/mock_store.js");
const { makeReq, makeRes } = require("./helpers/http_mocks.js");
const { timedFetch, timeoutMs, DEFAULT_TIMEOUT_MS } = require("../lib/_fetch.js");
const store = require("../lib/_store.js");
const balance = require("../lib/_balance.js");
const register = require("../lib/_register.js");
const fulfill = require("../api/fulfill.js");
const pin = require("../api/pin.js");

const USAGE = process.env.GITHUB_USAGE_REPO;
const PIN_REPO = process.env.GITHUB_PIN_REPO;
const TIMEOUT = 40; // ms, for the tests below

let gh, hang, original;
const realPutSleep = store._putRetry.sleep;
const realRetrySleep = register._timing.retrySleep;
const realFloorSleep = register._timing.floorSleep;

// hang(url, opts) -> true makes that one call a promise that never settles
// (and ignores the abort signal, the worst case the race exists for).
beforeEach(() => {
  gh = new MockGitHubStore();
  hang = () => false;
  original = global.fetch;
  global.fetch = (url, opts) => {
    if (!String(url).startsWith("https://api.github.com/")) {
      return Promise.resolve({ status: 599, ok: false, json: async () => ({}), text: async () => "blocked in tests" });
    }
    if (hang(String(url), opts || {})) return new Promise(() => {});
    return gh.handleFetch(url, opts);
  };
  process.env.WITNESS_FETCH_TIMEOUT_MS = String(TIMEOUT);
  store._putRetry.sleep = async () => {};
  register._timing.retrySleep = async () => {};
  register._timing.floorSleep = async () => {};
  register._timing.reset();
  register.setSender({ send: async () => ({ ok: true }), probe: async () => ({ ok: true }) });
  pin._resetRateBuckets();
});

afterEach(() => {
  global.fetch = original;
  delete process.env.WITNESS_FETCH_TIMEOUT_MS;
  store._putRetry.sleep = realPutSleep;
  register._timing.retrySleep = realRetrySleep;
  register._timing.floorSleep = realFloorSleep;
  register.setSender(null);
});

test("timeout: default is 10 s; WITNESS_FETCH_TIMEOUT_MS tunes it; junk falls back to the default", () => {
  delete process.env.WITNESS_FETCH_TIMEOUT_MS;
  assert.equal(DEFAULT_TIMEOUT_MS, 10000);
  assert.equal(timeoutMs(), 10000);
  process.env.WITNESS_FETCH_TIMEOUT_MS = "2500";
  assert.equal(timeoutMs(), 2500);
  for (const junk of ["0", "-5", "abc", ""]) {
    process.env.WITNESS_FETCH_TIMEOUT_MS = junk;
    assert.equal(timeoutMs(), 10000, `junk ${JSON.stringify(junk)}`);
  }
});

test("timeout: a fetch that never resolves is aborted at the timeout and rejects with a timeout error", async () => {
  let seenSignal = null;
  global.fetch = (url, opts) => { seenSignal = opts.signal; return new Promise(() => {}); };
  const t0 = Date.now();
  await assert.rejects(timedFetch("https://api.github.com/x", { headers: {} }), (err) => {
    assert.equal(err.timeout, true);
    assert.match(err.message, /timed out after 40 ms/);
    return true;
  });
  const elapsed = Date.now() - t0;
  assert.ok(elapsed >= TIMEOUT - 5 && elapsed < 2000, `aborted near the timeout (took ${elapsed} ms)`);
  assert.ok(seenSignal, "the fetch was handed an AbortSignal");
  assert.equal(seenSignal.aborted, true, "the signal fired");
});

test("timeout: a fetch that answers in time passes through untouched, caller options kept", async () => {
  let seen = null;
  global.fetch = async (url, opts) => { seen = opts; return { status: 200, ok: true, json: async () => ({ a: 1 }) }; };
  const r = await timedFetch("https://api.github.com/y", { method: "PUT", headers: { h: "1" }, body: "b" });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { a: 1 });
  assert.equal(seen.method, "PUT");
  assert.equal(seen.body, "b");
  assert.deepEqual(seen.headers, { h: "1" });
});

test("timeout: a fetch that rejects on its own rejects with its own error", async () => {
  global.fetch = async () => { throw new Error("socket reset"); };
  await assert.rejects(timedFetch("https://api.github.com/z"), /socket reset/);
});

test("REGISTER: a store write that never answers is aborted; 503 store_error and the slot is refunded", async () => {
  const ip = "10.9.9.9";
  const email = "stuck@example.com";
  const eh = register.sha256(register.normaliseEmail(email).normalised);
  const regUrl = `/contents/${register.regPath(eh)}`;
  hang = (url, opts) => opts.method === "PUT" && url.includes(regUrl);

  const res = makeRes();
  await fulfill(makeReq({
    method: "POST",
    headers: { "x-forwarded-for": ip, accept: "application/json" },
    body: { email },
    query: { op: "register" },
  }), res);

  assert.equal(res._status, 503, JSON.stringify(res._body));
  assert.equal(res._body.reason, "store_error");
  assert.equal(res._body.retry_safe, true);
  assert.equal(gh.has(USAGE, register.regPath(eh)), false, "the stuck write did not land");
  const month = new Date().toISOString().slice(0, 7);
  assert.deepEqual(gh.read(USAGE, register.ipPath(register.ipHash(ip), month)).events, [], "the ip slot was refunded");
  // Every window file this call touched (ip, network, domain) holds no event.
  const windows = [...gh.repos.get(USAGE).keys()].map((p) => [p, gh.read(USAGE, p)]).filter(([, j]) => j && Array.isArray(j.events));
  assert.ok(windows.length >= 1, "the call did reserve at least one window before the stuck write");
  for (const [p, j] of windows) assert.deepEqual(j.events, [], `window ${p} was refunded`);

  // The next attempt from the same address goes through: nothing stayed spent.
  hang = () => false;
  const again = makeRes();
  await fulfill(makeReq({
    method: "POST",
    headers: { "x-forwarded-for": ip, accept: "application/json" },
    body: { email },
    query: { op: "register" },
  }), again);
  assert.equal(again._status, 200, JSON.stringify(again._body));
});

test("PIN: a pin-record write that never answers is aborted; the existing store-error 502, credit refunded", async () => {
  const hash = balance.keyHash("testkeyA");
  await balance.grantCredits(hash, 5, "test-seed", "evt-timeout-seed-1", "test");
  process.env.WITNESS_PLANS = JSON.stringify({ [hash]: { plan: "free", monthly_cap: 0 } });
  try {
    const ns = "demo-timeout1";
    hang = (url, opts) => opts.method === "PUT" && url.includes(`/repos/${PIN_REPO}/contents/pins/${ns}/00000001.json`);
    const res = makeRes();
    await pin(makeReq({
      method: "POST",
      headers: { authorization: "Bearer testkeyA" },
      body: { namespace: ns, rows: 1, chain: "aa11bb22" },
    }), res);
    assert.equal(res._status, 502, JSON.stringify(res._body));
    assert.equal(gh.has(PIN_REPO, `pins/${ns}/00000001.json`), false);
    assert.equal((await balance.readBalance(hash)).balance, 5, "the debited credit came back");
  } finally {
    delete process.env.WITNESS_PLANS;
  }
});
