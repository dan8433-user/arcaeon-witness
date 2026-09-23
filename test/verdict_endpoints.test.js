// test/verdict_endpoints.test.js — the verdict requirement, at each call site
// that used to be able to build a success from defaults.
//
// Two halves, always together, because a fix that only ever refuses is as
// wrong as one that never does:
//   DAMAGED  -> non-200 (or a thrown error on the library paths), and a body
//               that does not say "nothing here" / "legacy" / "not witnessed"
//   EMPTY    -> the legitimate brand-new answer still comes back
//
// MUST-FAIL ARMS: every DAMAGED test was run red once with its defect put
// back (the judge call removed or the `|| 0` restored). Red lines are in
// VERDICT_SURVEY.md.

"use strict";

process.env.GITHUB_PIN_REPO = "test-owner/test-pins";
process.env.GITHUB_PIN_BRANCH = "main";
process.env.GITHUB_USAGE_REPO = "test-owner/test-usage";
process.env.GITHUB_PIN_TOKEN = "test-token";
process.env.WITNESS_KEYS = "testkeyA:demo-";
delete process.env.WITNESS_PLANS;
delete process.env.WITNESS_CADENCE;
process.env.STAMP_REPO = "test-owner/test-stamps";
process.env.STAMP_BRANCH = "main";
process.env.STAMP_TOKEN = "test-stamp-token";
process.env.STAMP_DAILY_CAP = "3";

const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const { MockGitHubStore, install } = require("./helpers/mock_store.js");
const { makeReq, makeRes } = require("./helpers/http_mocks.js");
const verdict = require("../lib/_verdict.js");
const realStore = require("../lib/_store.js");
const latestHandler = require("../api/latest.js");
const verifyHandler = require("../api/verify.js");
const pinHandler = require("../api/pin.js");
const statusJson = require("../lib/_status_json.js");
const balance = require("../lib/_balance.js");
const meter = require("../lib/_meter.js");
const stamp = require("../lib/_stamp.js");

const PIN_REPO = process.env.GITHUB_PIN_REPO;
const USAGE_REPO = process.env.GITHUB_USAGE_REPO;
const STAMP_REPO = process.env.STAMP_REPO;

let gh;
let restore;

beforeEach(() => {
  gh = new MockGitHubStore();
  restore = install(gh);
});
afterEach(() => restore());

const goodPin = (ns, over = {}) => ({
  namespace: ns, rows: 42, chain: "cafebabe", seq: 3,
  pinned_at: new Date().toISOString(),
  next_pin_due_by: new Date(Date.now() + 3600_000).toISOString(),
  ...over,
});

async function call(handler, reqOpts) {
  const res = makeRes();
  await handler(makeReq(reqOpts), res);
  return res;
}

// Valid JSON, present, and not a pin record: what a bad merge, a hand edit, or
// a half-written file looks like. `{rows:0, chain:"genesis"}` is on the list on
// purpose — it is the exact payload the original bug manufactured.
const DAMAGED_HEADS = [
  {},
  { rows: 0, chain: "genesis" },
  { namespace: "demo-dmg", rows: "42", chain: "cafebabe", seq: 3 },
  { namespace: "demo-dmg", rows: 42, chain: "cafebabe" },
];

// ---------------------------------------------------------------- /api/latest

test("LATEST / DAMAGED: a head that is present but is not a pin record is a 503, never 200 ok:true status:legacy", async () => {
  for (const dmg of DAMAGED_HEADS) {
    gh.seed(PIN_REPO, "pins/demo-dmg/latest.json", dmg);
    const res = await call(latestHandler, { query: { ns: "demo-dmg" } });
    assert.notEqual(res._status, 200, `damaged head ${JSON.stringify(dmg)} answered 200`);
    assert.notEqual(res._status, 404, "a damaged head is not 'no pin recorded'");
    assert.equal(res._body.ok, false);
    assert.ok(!("pin" in res._body) && !("status" in res._body) && !("cadence_grade" in res._body),
      "the refusal body must not carry the success body's fields");
    assert.doesNotMatch(JSON.stringify(res._body), /legacy_no_deadline|genesis|no pin recorded/);
  }
});

test("LATEST / EMPTY: a namespace with nothing recorded is still the honest 404", async () => {
  const res = await call(latestHandler, { query: { ns: "demo-neverseen" } });
  assert.equal(res._status, 404);
  assert.match(res._body.error, /no pin recorded/);
});

test("LATEST / GOOD: a real head still answers 200 ok:true with the pin", async () => {
  gh.seed(PIN_REPO, "pins/demo-good/latest.json", goodPin("demo-good"));
  const res = await call(latestHandler, { query: { ns: "demo-good" } });
  assert.equal(res._status, 200);
  assert.equal(res._body.ok, true);
  assert.equal(res._body.pin.rows, 42);
  assert.equal(res._body.status, "current");
});

// ---------------------------------------------------------------- /api/verify

test("VERIFY / DAMAGED HEAD: not a conclusive 'not witnessed' — a 503 with no witnessed field", async () => {
  for (const dmg of DAMAGED_HEADS) {
    gh.seed(PIN_REPO, "pins/demo-dmg/latest.json", dmg);
    // a historical record that DOES match what is being asked about: the old
    // code never reached it, because the damaged head started the scan at seq 0
    gh.seed(PIN_REPO, "pins/demo-dmg/00000001.json", goodPin("demo-dmg", { rows: 7, chain: "deadbeef", seq: 1 }));
    const res = await call(verifyHandler, { query: { ns: "demo-dmg", rows: "7", chain: "deadbeef" } });
    assert.notEqual(res._status, 200, `damaged head ${JSON.stringify(dmg)} answered 200`);
    assert.equal(res._body.ok, false);
    assert.ok(!("witnessed" in res._body),
      `a damaged head produced a witnessed verdict: ${JSON.stringify(res._body.witnessed)} (${res._body.reason})`);
    assert.doesNotMatch(JSON.stringify(res._body), /not_found_in_history|no_pin_recorded|reached the start/);
  }
});

test("VERIFY / EMPTY: a never-pinned namespace is still 200 witnessed:null no_pin_recorded_for_namespace", async () => {
  const res = await call(verifyHandler, { query: { ns: "demo-neverseen", rows: "5", chain: "aaaaaaaa" } });
  assert.equal(res._status, 200);
  assert.equal(res._body.ok, true);
  assert.equal(res._body.witnessed, null);
  assert.equal(res._body.reason, "no_pin_recorded_for_namespace");
});

test("VERIFY / DAMAGED HISTORY: an unreadable record on the way down turns a conclusive false into null", async () => {
  const ns = "demo-hist";
  gh.seed(PIN_REPO, `pins/${ns}/latest.json`, goodPin(ns, { rows: 30, seq: 3 }));
  gh.seed(PIN_REPO, `pins/${ns}/00000002.json`, { namespace: ns, note: "this was the rows=20 record, and it is damaged" });
  gh.seed(PIN_REPO, `pins/${ns}/00000001.json`, goodPin(ns, { rows: 10, chain: "aaaaaaaa", seq: 1 }));
  const res = await call(verifyHandler, { query: { ns, rows: "20", chain: "bbbbbbbb" } });
  assert.equal(res._status, 200);
  assert.equal(res._body.witnessed, null, `a scan that could not read one record still concluded: ${res._body.reason}`);
  assert.equal(res._body.reason, "history_unreadable");
  assert.equal(res._body.unreadable_records, 1);

  // control: the same history with the record intact IS conclusive
  gh.seed(PIN_REPO, `pins/${ns}/00000002.json`, goodPin(ns, { rows: 25, chain: "cccccccc", seq: 2 }));
  const ok = await call(verifyHandler, { query: { ns, rows: "20", chain: "bbbbbbbb" } });
  assert.equal(ok._body.witnessed, false);
  assert.equal(ok._body.reason, "rows_never_witnessed");
});

// ------------------------------------------------------------------- /api/pin

test("PIN / DAMAGED HEAD: the pin is refused before any charge, and nothing is written", async () => {
  gh.seed(PIN_REPO, "pins/demo-dmg/latest.json", { rows: 0, chain: "genesis" });
  const res = await call(pinHandler, {
    method: "POST", headers: { authorization: "Bearer testkeyA" },
    body: { namespace: "demo-dmg", rows: 5, chain: "cafebabe" },
  });
  assert.equal(res._status, 503, `pin over a damaged head answered ${res._status}: ${JSON.stringify(res._body)}`);
  assert.equal(res._body.ok, false);
  assert.equal(gh.putLog.length, 0, `wrote ${gh.putLog.map((p) => p.path).join(", ")} over a head it could not read`);
});

test("PIN / EMPTY: the first pin of a brand-new namespace still lands as seq 1", async () => {
  const res = await call(pinHandler, {
    method: "POST", headers: { authorization: "Bearer testkeyA" },
    body: { namespace: "demo-brandnew", rows: 5, chain: "cafebabe" },
  });
  assert.equal(res._status, 201, JSON.stringify(res._body));
  assert.equal(res._body.ok, true);
  assert.equal(gh.read(PIN_REPO, "pins/demo-brandnew/latest.json").seq, 1);
});

// --------------------------------------------------------------- status board

function stubStore({ namespaces, pins, getTree }) {
  const saved = {};
  for (const k of ["repoReachable", "listDir", "getFile", "getRawFile", "getTree"]) saved[k] = realStore[k];
  const headName = `${new Date().toISOString().slice(0, 10)}-head.txt`;
  realStore.repoReachable = async () => true;
  realStore.listDir = async (dir) =>
    dir === "anchors"
      ? [{ type: "file", name: headName }, { type: "file", name: `${headName}.ots` }]
      : namespaces.map((n) => ({ type: "dir", name: n }));
  realStore.getRawFile = async () => ({ text: `deadbeef ${new Date().toISOString()}` });
  realStore.getFile = async (path) => {
    const m = path.match(/^pins\/([^/]+)\/latest\.json$/);
    return m && pins[m[1]] ? { json: pins[m[1]] } : null;
  };
  realStore.getTree = getTree || (async () => []);
  return () => Object.assign(realStore, saved);
}

async function boardJson() {
  const res = makeRes();
  await statusJson(makeReq({ method: "GET" }), res);
  return res._body;
}

test("STATUS / DAMAGED ROW: a head that is not a pin record is an ERROR row and the board is degraded — not a 'legacy' row", async () => {
  const undo = stubStore({
    namespaces: ["acme-prod", "acme-dmg"],
    pins: { "acme-prod": goodPin("acme-prod"), "acme-dmg": { rows: 0, chain: "genesis" } },
  });
  try {
    const body = await boardJson();
    const row = body.namespaces.find((n) => n.namespace === "acme-dmg");
    assert.ok(row.error, `damaged head rendered as a graded row: ${JSON.stringify(row)}`);
    assert.notEqual(row.status, "legacy_no_deadline");
    assert.equal(body.ok, false);
    assert.equal(body.status, "degraded");
  } finally { undo(); }
});

test("STATUS / UNCOUNTED CONFLICTS: an unreadable observations tree is null and not-ok — never conflicts_observed: 0 under ok:true", async () => {
  const undo = stubStore({
    namespaces: ["acme-prod"], pins: { "acme-prod": goodPin("acme-prod") },
    getTree: async () => { throw new Error("github GET tree -> 502"); },
  });
  try {
    const body = await boardJson();
    assert.equal(body.summary.conflicts_observed, null, "an uncounted conflict log reported a number");
    assert.equal(body.conflict_observations.count, null);
    assert.equal(body.ok, false, "the board was green over a conflict log it could not read");
    assert.equal(body.status, "indeterminate");
    assert.match(body.errors.observations, /502/);
  } finally { undo(); }
});

test("STATUS / EMPTY: a conflict log that WAS read and holds nothing is an honest 0 on a green board", async () => {
  const undo = stubStore({ namespaces: ["acme-prod"], pins: { "acme-prod": goodPin("acme-prod") } });
  try {
    const body = await boardJson();
    assert.equal(body.summary.conflicts_observed, 0);
    assert.equal(body.ok, true);
    assert.equal(body.status, "ok");
  } finally { undo(); }
});

// ------------------------------------------------------------------- counters

test("BALANCE / DAMAGED: a balance file with no readable balance throws on read, on debit and on grant — and the grant does NOT overwrite it", async () => {
  const hash = balance.keyHash("some-key");
  const path = `balance/${hash}.json`;
  const dmg = { key_id: hash.slice(0, 12), note: "balance field lost" };
  gh.seed(USAGE_REPO, path, dmg);

  await assert.rejects(() => balance.readBalance(hash), verdict.RedVerdictError);
  await assert.rejects(() => balance.debitCredits("some-key", 1, "test"), verdict.RedVerdictError);
  await assert.rejects(() => balance.grantCredits(hash, 100, "mini", "evt_1", "test"), verdict.RedVerdictError);
  assert.deepEqual(gh.read(USAGE_REPO, path), dmg, "the grant replaced a damaged balance file with a fresh one");
});

test("BALANCE / EMPTY: a key that never bought credit still reads as an honest 0, and its first grant still lands", async () => {
  const hash = balance.keyHash("fresh-key");
  const b = await balance.readBalance(hash);
  assert.equal(b.balance, 0);
  assert.equal(b.ever_purchased, false);
  const g = await balance.grantCredits(hash, 100, "mini", "evt_first", "test");
  assert.equal(g.ok, true);
  assert.equal((await balance.readBalance(hash)).balance, 100);
});

test("METER / DAMAGED: a usage file with no readable count throws — it does not re-open a spent free tier", async () => {
  const hash = meter.keyHash("testkeyA");
  const path = `usage/${hash}/${meter.utcMonth()}.json`;
  gh.seed(USAGE_REPO, path, { key_id: hash.slice(0, 12), used: "100" });
  await assert.rejects(() => meter.check("testkeyA"), verdict.RedVerdictError);
  await assert.rejects(() => meter.peek("testkeyA"), verdict.RedVerdictError);
  assert.equal(gh.putLog.length, 0, "a grant was written over a damaged usage counter");
});

test("METER / EMPTY: a key with no usage file this month still starts at 0 and is granted", async () => {
  assert.equal((await meter.peek("testkeyA")).used, 0);
  const r = await meter.check("testkeyA");
  assert.equal(r.ok, true);
  assert.equal(r.used, 1);
});

test("STAMP BUDGET / DAMAGED vs EMPTY: a day counter with no readable count refuses the stamp (503, nothing written); a day with no counter yet starts at 0", async () => {
  stamp._resetLimiterForTests();
  const day = new Date().toISOString().slice(0, 10);
  const path = `stamps/_meta/day-${day}.json`;
  const SHA_A = "a".repeat(64);
  const SHA_B = "b".repeat(64);
  const post = async (sha) => {
    const res = makeRes();
    await stamp.handleStamp(makeReq({ method: "POST", body: { sha256: sha }, headers: { "x-forwarded-for": "203.0.113.9" } }), res);
    return res;
  };

  // EMPTY: no counter file yet -> the stamp lands and the day reads 1
  const first = await post(SHA_A);
  assert.equal(first._status, 201, JSON.stringify(first._body));
  assert.equal(gh.read(STAMP_REPO, path).count, 1);

  // DAMAGED: the counter is there and its count is gone
  gh.seed(STAMP_REPO, path, { day });
  const writesBefore = gh.putLog.length;
  const second = await post(SHA_B);
  assert.equal(second._status, 503, `a damaged day counter re-opened the budget: ${second._status} ${JSON.stringify(second._body)}`);
  assert.equal(second._body.ok, false);
  assert.equal(gh.putLog.length, writesBefore, "something was written over a damaged budget counter");
});

test("STAMP BUDGET / COUNTER NULL MID-WRITE: a day counter whose JSON turns into the literal null during the write is refused, not restarted at 0", async () => {
  stamp._resetLimiterForTests();
  const day = new Date().toISOString().slice(0, 10);
  const path = `stamps/_meta/day-${day}.json`;
  gh.seed(STAMP_REPO, path, { day, count: 0 }); // a readable counter under the free ceiling, so the stamp reaches the write

  const realSleep = realStore._putRetry.sleep;
  realStore._putRetry.sleep = async () => {};
  const routed = global.fetch;
  let planted = false;
  let bytesAfterPlant = null;
  global.fetch = async (url, opts) => {
    if (!planted && opts && opts.method === "PUT" && String(url).includes(encodeURI(path))) {
      planted = true;
      gh.seed(STAMP_REPO, path, null); // present, new sha, content is the JSON literal null
      bytesAfterPlant = gh._repoMap(STAMP_REPO).get(path).content;
      return { status: 409, ok: false, json: async () => ({}), text: async () => "mock: moved" };
    }
    return routed(url, opts);
  };
  try {
    const res = makeRes();
    await stamp.handleStamp(makeReq({ method: "POST", body: { sha256: "e".repeat(64) }, headers: { "x-forwarded-for": "203.0.113.10" } }), res);
    assert.equal(planted, true, "the fixture never planted the damage; the test proves nothing");
    assert.equal(res._status, 503, `a present-but-null day counter must refuse the stamp: ${res._status} ${JSON.stringify(res._body)}`);
    assert.equal(gh.putLog.filter((p) => p.path === path).length, 0, "a write landed on the day counter");
    assert.equal(gh._repoMap(STAMP_REPO).get(path).content, bytesAfterPlant, "the day counter bytes changed");
  } finally {
    global.fetch = routed;
    realStore._putRetry.sleep = realSleep;
  }
});

// ------------------------------------------------------------------- listings

test("LISTINGS / DAMAGED vs EMPTY: a 200 that is not a listing throws; a 404 is still an honest empty directory", async () => {
  assert.deepEqual(await realStore.listDir("pins"), [], "404 must stay an empty listing");

  const original = global.fetch;
  global.fetch = async () => ({ status: 200, ok: true, json: async () => ({ message: "this is not a listing" }) });
  try {
    await assert.rejects(() => realStore.listDir("pins"), /refusing to read that as empty/);
    await assert.rejects(() => realStore.getTree(), /refusing to read that as empty/);
    await assert.rejects(() => realStore.getTreeMeta(), /refusing to read that as empty/);
  } finally { global.fetch = original; }
});

test("KEY PREFIX LISTING / DAMAGED: a 200 that is not a listing throws — it does not read as 'no prefixes are spoken for'", async () => {
  const keys = require("../lib/_keys.js");
  const original = global.fetch;
  global.fetch = async () => ({ status: 200, ok: true, json: async () => ({ message: "this is not a listing" }) });
  try {
    await assert.rejects(() => keys.listPrefixes(), /refusing to read that as empty/);
  } finally { global.fetch = original; }
});

// ------------------------------------------------ the latest-pointer rebuild hook

test("PIN / POINTER DAMAGED MID-WRITE: a pointer that turns unreadable between the read and the write is not overwritten as if it were seq 0", async () => {
  const ns = "demo-race";
  const head = `pins/${ns}/latest.json`;
  gh.seed(PIN_REPO, head, goodPin(ns, { rows: 10, seq: 1 }));
  gh.seed(PIN_REPO, `pins/${ns}/00000001.json`, goodPin(ns, { rows: 10, seq: 1 }));

  const realSleep = realStore._putRetry.sleep;
  realStore._putRetry.sleep = async () => {};
  const routed = global.fetch;
  let planted = false;
  const damaged = { note: "pointer damaged by another writer" };
  global.fetch = async (url, opts) => {
    if (!planted && opts && opts.method === "PUT" && String(url).includes(encodeURI(head))) {
      planted = true;
      gh.seed(PIN_REPO, head, damaged); // new sha: the path MOVED, so putFile calls the rebuild hook
      return { status: 409, ok: false, json: async () => ({}), text: async () => "mock: moved" };
    }
    return routed(url, opts);
  };
  try {
    const res = await call(pinHandler, {
      method: "POST", headers: { authorization: "Bearer testkeyA" },
      body: { namespace: ns, rows: 11, chain: "deadbeef" },
    });
    assert.equal(planted, true, "the fixture never planted the damage; the test proves nothing");
    assert.deepEqual(gh.read(PIN_REPO, head), damaged,
      `the rebuild hook read a damaged pointer as seq 0 and wrote over it (handler answered ${res._status})`);
  } finally {
    global.fetch = routed;
    realStore._putRetry.sleep = realSleep;
  }
});

test("PIN / POINTER DAMAGED MID-WRITE (content = null): a pointer whose stored JSON is the literal null is refused by name, not rebuilt over as a 404", async () => {
  // The 404 and the present-but-null read used to reach the rebuild hook as
  // the same value (lib/_store.js passed `fresh ? fresh.json : null`), so a
  // latest.json holding `null` read as "gone" and was overwritten at seq 0.
  const ns = "demo-race-null";
  const head = `pins/${ns}/latest.json`;
  gh.seed(PIN_REPO, head, goodPin(ns, { rows: 10, seq: 1 }));
  gh.seed(PIN_REPO, `pins/${ns}/00000001.json`, goodPin(ns, { rows: 10, seq: 1 }));

  const realSleep = realStore._putRetry.sleep;
  realStore._putRetry.sleep = async () => {};
  const routed = global.fetch;
  let planted = false;
  let bytesAfterPlant = null;
  global.fetch = async (url, opts) => {
    if (!planted && opts && opts.method === "PUT" && String(url).includes(encodeURI(head))) {
      planted = true;
      gh.seed(PIN_REPO, head, null); // present, new sha, content is the JSON literal null
      bytesAfterPlant = gh._repoMap(PIN_REPO).get(head).content;
      return { status: 409, ok: false, json: async () => ({}), text: async () => "mock: moved" };
    }
    return routed(url, opts);
  };
  try {
    const res = await call(pinHandler, {
      method: "POST", headers: { authorization: "Bearer testkeyA" },
      body: { namespace: ns, rows: 11, chain: "deadbeef" },
    });
    assert.equal(planted, true, "the fixture never planted the damage; the test proves nothing");
    assert.equal(res._status, 503, `a present-but-null pointer must be refused, not answered ${res._status} ${JSON.stringify(res._body)}`);
    assert.equal(res._body.ok, false);
    assert.equal(res._body.reason, "not_a_json_object", "the refusal names its reason");
    assert.equal(gh.putLog.filter((p) => p.path === head).length, 0, "a write landed on the pointer");
    assert.equal(gh._repoMap(PIN_REPO).get(head).content, bytesAfterPlant, "the pointer bytes changed");
  } finally {
    global.fetch = routed;
    realStore._putRetry.sleep = realSleep;
  }
});

// --------------------------------------------------------------------- stamps

test("STAMP LOOKUP / DAMAGED vs EMPTY vs GOOD: a stamp file that is not a stamp is a 503, an absent one is the honest 404, a real one is 200", async () => {
  stamp._resetLimiterForTests();
  const SHA_C = "c".repeat(64);
  const SHA_D = "d".repeat(64);
  const path = (sha) => `stamps/${sha.slice(0, 2)}/${sha}.json`;
  const get = async (sha) => {
    const res = makeRes();
    await stamp.handleStamp(makeReq({ method: "GET", query: { sha256: sha } }), res);
    return res;
  };

  // EMPTY
  const miss = await get(SHA_C);
  assert.equal(miss._status, 404);
  assert.equal(miss._body.stamped, false);

  // DAMAGED: present, not a stamp / a stamp for a DIFFERENT fingerprint
  for (const dmg of [{}, { kind: "file-stamp", v: 1, sha256: SHA_D, size: null, stamped_at: new Date().toISOString() },
                     { kind: "file-stamp", v: 1, sha256: SHA_C, size: null }]) {
    gh.seed(STAMP_REPO, path(SHA_C), dmg);
    const res = await get(SHA_C);
    assert.notEqual(res._status, 200, `a damaged stamp record answered 200: ${JSON.stringify(res._body)}`);
    assert.notEqual(res._status, 404, "a damaged stamp record is not 'no stamp recorded'");
    assert.equal(res._body.ok, false);
    assert.ok(!("permalink" in res._body) && !("stamp" in res._body));
  }

  // GOOD
  gh.seed(STAMP_REPO, path(SHA_C), { kind: "file-stamp", v: 1, sha256: SHA_C, size: null, stamped_at: new Date().toISOString() });
  const ok = await get(SHA_C);
  assert.equal(ok._status, 200);
  assert.equal(ok._body.ok, true);
  assert.equal(ok._body.existing, true);
});
