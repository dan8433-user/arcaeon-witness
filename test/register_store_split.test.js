// test/register_store_split.test.js — the registration store split
// (lib/_keys.js registerStore(), 2026-09-28). With REGISTER_STORE_REPO +
// REGISTER_STORE_TOKEN set, every registration-owned file (registrations/ and
// its _ip/_ipc/_domain/_sends/_tok/_timing subtrees, trial_namespaces/,
// fulfillments/reg-*, the registration pool, the durable hour counter) goes to
// the register store on the register token and branch, and none goes to the
// pin store. The issued-key record, the balance and its ledger stay in the pin
// store (api/pin.js reads them there). Two separate MockGitHubStore instances;
// every request is routed by repo and its token and branch are checked.
// With the env unset the other test files run unchanged (they never set it).
"use strict";

process.env.GITHUB_USAGE_REPO = "test-owner/test-usage";
process.env.GITHUB_PIN_REPO = "test-owner/test-pins";
process.env.GITHUB_PIN_BRANCH = "main";
process.env.GITHUB_PIN_TOKEN = "test-token";
process.env.REGISTER_IP_SALT = "test-salt-not-a-secret";
process.env.WITNESS_ADMIN_KEY = "test-admin-key";
delete process.env.RESEND_API_KEY;
delete process.env.RESEND_FROM;
delete process.env.WITNESS_KEYS;
delete process.env.WITNESS_PLANS;
delete process.env.WITNESS_CADENCE;

const REG_REPO = "test-owner/test-registrations";
const REG_TOKEN = "test-register-token";
const REG_BRANCH = "reg-main";
function setSplitEnv() {
  process.env.REGISTER_STORE_REPO = REG_REPO;
  process.env.REGISTER_STORE_TOKEN = REG_TOKEN;
  process.env.REGISTER_STORE_BRANCH = REG_BRANCH;
}
function clearSplitEnv() {
  delete process.env.REGISTER_STORE_REPO;
  delete process.env.REGISTER_STORE_TOKEN;
  delete process.env.REGISTER_STORE_BRANCH;
}

const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const { MockGitHubStore } = require("./helpers/mock_store.js");
const { makeReq, makeRes } = require("./helpers/http_mocks.js");
const store = require("../lib/_store.js");
const balance = require("../lib/_balance.js");
const keys = require("../lib/_keys.js");
const meter = require("../lib/_meter.js");
const register = require("../lib/_register.js");
const fulfill = require("../api/fulfill.js");
const pin = require("../api/pin.js");

const USAGE = process.env.GITHUB_USAGE_REPO;

// Registration-owned paths: the set that must live in the register store.
function registrationOwned(path) {
  return /^registrations\//.test(path) ||
    /^trial_namespaces\//.test(path) ||
    /^fulfillments\/reg-/.test(path) ||
    /^pools\//.test(path) ||
    /^usage\/[0-9a-f]{64}\/hour-/.test(path);
}

let pinGh, regGh, sent, calls, restoreFetch;
const realPutSleep = store._putRetry.sleep;
const realRetrySleep = register._timing.retrySleep;
const realFloorSleep = register._timing.floorSleep;

beforeEach(() => {
  setSplitEnv();
  pinGh = new MockGitHubStore();
  regGh = new MockGitHubStore();
  sent = [];
  calls = []; // {repo, method, path, auth, branch}
  const original = global.fetch;
  global.fetch = (url, opts) => {
    const u = new URL(String(url));
    assert.equal(u.origin, "https://api.github.com", `no host but the mocked GitHub API: ${u.origin}`);
    const m = u.pathname.match(/^\/repos\/([^/]+\/[^/]+)\/(?:contents|git\/trees)\/(.*)$/);
    const repo = m ? m[1] : "?";
    const method = (opts && opts.method) || "GET";
    const headers = (opts && opts.headers) || {};
    const branch = method === "PUT" ? JSON.parse(opts.body).branch : u.searchParams.get("ref");
    calls.push({ repo, method, path: m ? decodeURIComponent(m[2]) : u.pathname, auth: headers.authorization, branch });
    return (repo === REG_REPO ? regGh : pinGh).handleFetch(url, opts);
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
  register.setSender(null);
  store._putRetry.sleep = realPutSleep;
  register._timing.retrySleep = realRetrySleep;
  register._timing.floorSleep = realFloorSleep;
  restoreFetch();
  clearSplitEnv();
});

let ipCounter = 0;
function freshIp() {
  ipCounter += 1;
  return `10.9.${(ipCounter >> 8) & 255}.${ipCounter & 255}`;
}
async function call(req) {
  const res = makeRes();
  await fulfill(req, res);
  return res;
}
function registerReq(email) {
  return makeReq({ method: "POST", headers: { "x-forwarded-for": freshIp(), accept: "application/json" }, body: { email }, query: { op: "register" } });
}
function confirmReq(t) {
  return makeReq({ method: "POST", headers: { accept: "application/json", "x-forwarded-for": freshIp() }, query: { op: "confirm" }, body: { t } });
}
function tokenFrom(msg) {
  const m = /[?&]t=([0-9a-f]{64})/.exec(msg.text);
  assert.ok(m, "the email carries a confirm link");
  return m[1];
}
function pinReq(key, namespace, rows) {
  return makeReq({ method: "POST", headers: { authorization: `Bearer ${key}` }, body: { namespace, rows, chain: rows.toString(16).padStart(8, "a") } });
}

test("SPLIT: registerStore() binds to REGISTER_STORE_*; unset or half-set, it IS the pin store", () => {
  const rs = keys.registerStore();
  assert.equal(rs.split, true);
  assert.equal(rs.repo, REG_REPO);
  assert.equal(rs.branch, REG_BRANCH);
  assert.equal(rs.headers().authorization, `Bearer ${REG_TOKEN}`);
  delete process.env.REGISTER_STORE_BRANCH;
  assert.equal(keys.registerStore().branch, "main", "branch defaults to main");
  delete process.env.REGISTER_STORE_TOKEN;
  assert.equal(keys.registerStore(), keys.pinStore(), "repo without token: the pin store");
  process.env.REGISTER_STORE_TOKEN = REG_TOKEN;
  delete process.env.REGISTER_STORE_REPO;
  assert.equal(keys.registerStore(), keys.pinStore(), "token without repo: the pin store");
  clearSplitEnv();
  const ps = keys.registerStore();
  assert.equal(ps, keys.pinStore());
  assert.equal(ps.split, false);
  assert.equal(ps.repo, USAGE);
  assert.equal(ps.headers().authorization, "Bearer test-token");
});

test("SPLIT: a full registration lifecycle writes every registration file to the register store and none to the pin store", async () => {
  const email = "split@example.com";
  const emailHash = register.sha256(email);

  // register, then register again while pending (fresh token, _sends counter, _ip window)
  let r = await call(registerReq(email));
  assert.equal(r._status, 200, JSON.stringify(r._body));
  r = await call(registerReq(email));
  assert.equal(r._status, 200, JSON.stringify(r._body));
  const token = tokenFrom(sent[sent.length - 1]);

  const st = await call(makeReq({ method: "GET", headers: { "x-forwarded-for": freshIp() }, query: { op: "register-status", eh: emailHash } }));
  assert.equal(st._status, 200);

  // confirm: mint (fulfillments/reg-*), pool, issued key, balance grant, mark claimed
  const c = await call(confirmReq(token));
  assert.equal(c._status, 200, JSON.stringify(c._body));
  assert.equal(c._body.credit_balance, 500);
  const kh = keys.keyHash(c._body.key);

  // pins under two namespaces: durable hour counter + trial namespace list
  let rows = 0;
  for (const suffix of ["main", "alt"]) {
    rows += 1;
    const res = makeRes();
    await pin(pinReq(c._body.key, `${c._body.namespace}${suffix}`, rows), res);
    assert.equal(res._status, 201, JSON.stringify(res._body));
  }

  // confirmed revisit past the re-show window: updateFulfillment nulls the raw key
  const rp = register.regPath(emailHash);
  const regNow = regGh.read(REG_REPO, rp);
  regGh.seed(REG_REPO, rp, { ...regNow, key_shown_at: new Date(Date.now() - register.KEY_RESHOW_MS - 1000).toISOString() });
  const c2 = await call(confirmReq(token));
  assert.equal(c2._status, 409, JSON.stringify(c2._body));

  const rep = await call(makeReq({ method: "GET", headers: { authorization: "Bearer test-admin-key", "x-forwarded-for": freshIp() }, query: { op: "register-report" } }));
  assert.equal(rep._status, 200, JSON.stringify(rep._body));

  // ---- the assertions on the two mock store instances ----
  const pinWrites = pinGh.putLog.map((w) => w.path);
  const regWrites = regGh.putLog.map((w) => w.path);
  assert.deepEqual(pinWrites.filter(registrationOwned), [], "no registration-owned write reached the pin store");
  assert.deepEqual(regWrites.filter((p) => !registrationOwned(p)), [], "the register store holds only registration-owned files");
  assert.deepEqual(pinGh.getLog.filter(registrationOwned), [], "no registration-owned read reached the pin store");
  for (const re of [/^registrations\/[0-9a-f]{64}\.json$/, /^registrations\/_tok\//, /^registrations\/_ip\//,
    /^registrations\/_ipc\//, /^registrations\/_sends\//, /^registrations\/_timing\//,
    /^fulfillments\/reg-/, /^pools\//, /^trial_namespaces\//, /\/hour-/]) {
    assert.ok(regWrites.some((p) => re.test(p)), `register store got a write matching ${re}`);
  }
  assert.ok(pinGh.putLog.every((w) => w.repo !== REG_REPO));
  assert.equal(regGh.read(REG_REPO, keys.fulfillmentPath(register.fulfillId(emailHash))).key, null, "the re-show nulling landed in the register store");

  // what stays in the pin store: the issued-key record and the balance (pin.js reads both there)
  assert.equal(pinGh.read(USAGE, keys.issuedKeyPath(kh)).source, "register");
  assert.equal((await balance.readBalance(kh)).balance, 498, "grant 500, two pins charged from the pin store balance");
  assert.equal(regGh.has(REG_REPO, keys.issuedKeyPath(kh)), false);
  assert.equal(regGh.has(REG_REPO, balance.balancePath(kh)), false);
  assert.ok(regGh.has(REG_REPO, meter.hourPath(kh, meter.utcHour())));
  assert.equal(pinGh.has(USAGE, meter.hourPath(kh, meter.utcHour())), false);

  // every request carried its own store's token and branch
  for (const x of calls) {
    if (x.repo === REG_REPO) {
      assert.equal(x.auth, `Bearer ${REG_TOKEN}`, `${x.method} ${x.path}`);
      assert.equal(x.branch, REG_BRANCH, `${x.method} ${x.path}`);
    } else {
      assert.equal(x.auth, "Bearer test-token", `${x.method} ${x.path}`);
    }
  }
});

test("SPLIT: a Stripe fulfillment id and a Stripe pool still go to the pin store", async () => {
  const sid = "cs_test_abcdefgh12345678";
  await keys.createFulfillment(sid, { session_id: sid, pack: "p100" });
  await keys.writePool({ pool_id: "pool_stripe", kind: "solo" });
  assert.ok(pinGh.has(USAGE, keys.fulfillmentPath(sid)));
  assert.ok(pinGh.has(USAGE, keys.poolPath("pool_stripe")));
  assert.equal(regGh.putLog.length, 0);
  assert.equal((await keys.readFulfillment(sid)).json.pack, "p100");
});

test("UNSET: with no REGISTER_STORE_* env, registration writes go to the pin store exactly as before", async () => {
  clearSplitEnv();
  const email = "unsplit@example.com";
  const r = await call(registerReq(email));
  assert.equal(r._status, 200, JSON.stringify(r._body));
  const c = await call(confirmReq(tokenFrom(sent[sent.length - 1])));
  assert.equal(c._status, 200, JSON.stringify(c._body));
  assert.equal(regGh.putLog.length + regGh.getLog.length, 0, "the register mock was never touched");
  assert.ok(pinGh.has(USAGE, register.regPath(register.sha256(email))));
  assert.ok(pinGh.has(USAGE, keys.fulfillmentPath(register.fulfillId(register.sha256(email)))));
  assert.ok(calls.every((x) => x.auth === "Bearer test-token"));
});
