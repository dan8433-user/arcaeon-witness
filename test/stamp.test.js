// test/stamp.test.js — lib/_stamp.js: POST/GET /api/stamp (public, unauthenticated).
"use strict";

process.env.GITHUB_PIN_REPO = "test-owner/test-pins";
process.env.GITHUB_PIN_BRANCH = "main";
process.env.GITHUB_PIN_TOKEN = "test-token";
// Stamps have their OWN repo and OWN token (2026-09-20). Every assertion in
// this file that used to name the pins repo now names the stamps repo, and
// test/stamp_own_repo.test.js is where "and never the pins repo" is proved.
process.env.STAMP_REPO = "test-owner/test-stamps";
process.env.STAMP_BRANCH = "main";
process.env.STAMP_TOKEN = "test-stamp-token";
process.env.STAMP_DAILY_CAP = "3";
process.env.STAMP_FREE_PER_DAY = "1000"; // this file tests the OTHER fences

const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const { MockGitHubStore, install } = require("./helpers/mock_store.js");
const { makeReq, makeRes } = require("./helpers/http_mocks.js");
const store = require("../lib/_store.js");
const stamp = require("../lib/_stamp.js");

const REPO = process.env.STAMP_REPO; // the stamps repo, not the pins repo
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const pathOf = (sha) => `stamps/${sha.slice(0, 2)}/${sha}.json`;
const today = () => `stamps/_meta/day-${new Date().toISOString().slice(0, 10)}.json`;

let gh;
let restore;
let realSleep;

beforeEach(() => {
  gh = new MockGitHubStore();
  restore = install(gh);
  stamp._resetLimiterForTests();
  realSleep = store._putRetry.sleep;
  store._putRetry.sleep = async () => {};
});

afterEach(() => {
  store._putRetry.sleep = realSleep;
  restore();
});

async function post(body, headers = { "x-forwarded-for": "203.0.113.7" }) {
  const res = makeRes();
  await stamp.handleStamp(makeReq({ method: "POST", body, headers }), res);
  return res;
}

async function get(sha) {
  const res = makeRes();
  await stamp.handleStamp(makeReq({ method: "GET", query: { sha256: sha } }), res);
  return res;
}

test("CONTRACT: a new fingerprint is stamped, 201, and the record holds a hash, a size, a time and nothing else", async () => {
  const res = await post({ sha256: SHA_A, size: 1234 });
  assert.equal(res._status, 201);
  assert.equal(res._body.existing, false);
  const rec = gh.read(REPO, pathOf(SHA_A));
  assert.deepEqual(Object.keys(rec).sort(), ["kind", "sha256", "size", "stamped_at", "v"]);
  assert.equal(rec.sha256, SHA_A);
  assert.equal(rec.size, 1234);
  assert.equal(res._body.permalink, `https://arcaeon.io/r/${SHA_A}`);
});

test("CONTRACT: every response carries the does-not-prove sentence", async () => {
  const res = await post({ sha256: SHA_A });
  assert.match(res._body.scope.does_not_prove, /Who made the file/);
  assert.match(res._body.scope.does_not_prove, /true/);
  const miss = await get(SHA_B);
  assert.equal(miss._status, 404);
  assert.match(miss._body.scope.does_not_prove, /Who made the file/);
});

test("FIRST WRITE WINS: stamping the same fingerprint again returns the ORIGINAL time and writes nothing", async () => {
  const first = await post({ sha256: SHA_A, size: 10 });
  const t0 = first._body.stamp.stamped_at;
  const writesBefore = gh.putLog.length;
  const again = await post({ sha256: SHA_A, size: 999 });
  assert.equal(again._status, 200);
  assert.equal(again._body.existing, true);
  assert.equal(again._body.stamp.stamped_at, t0);
  assert.equal(again._body.stamp.size, 10, "a later caller must not be able to change the recorded size");
  assert.equal(gh.putLog.length, writesBefore, "a repeat stamp must not write, not even the budget counter");
});

test("FIRST WRITE WINS under a race: losing a create race returns the winner's record, never overwrites it", async () => {
  // The winner's record appears between our read (miss) and our write.
  const winner = { kind: "file-stamp", v: 1, sha256: SHA_A, size: 5, stamped_at: "2026-01-01T00:00:00.000Z" };
  const realGet = store.getFile;
  let reads = 0;
  const origFetch = global.fetch;
  global.fetch = (url, opts) => {
    const isStampGet = (!opts || !opts.method || opts.method === "GET") && String(url).includes(pathOf(SHA_A));
    if (isStampGet) {
      reads += 1;
      if (reads === 1) {
        const p = origFetch(url, opts); // miss
        return p.then((r) => {
          gh.seed(REPO, pathOf(SHA_A), winner); // winner lands right after our read
          return r;
        });
      }
    }
    return origFetch(url, opts);
  };
  try {
    const res = await post({ sha256: SHA_A, size: 777 });
    assert.equal(res._status, 200);
    assert.equal(res._body.existing, true);
    assert.equal(res._body.stamp.stamped_at, winner.stamped_at);
    assert.deepEqual(gh.read(REPO, pathOf(SHA_A)), winner, "the winner's record must be untouched");
  } finally {
    global.fetch = origFetch;
    void realGet;
  }
});

test("NO OPEN MIC: a name, label or any extra field is REFUSED, not silently dropped", async () => {
  for (const extra of [{ name: "contract.pdf" }, { label: "hello" }, { note: "x" }]) {
    const res = await post({ sha256: SHA_A, ...extra });
    assert.equal(res._status, 400);
    assert.match(res._body.error, /unexpected field/);
  }
  assert.equal(gh.has(REPO, pathOf(SHA_A)), false);
});

test("VALIDATION: bad fingerprints and bad sizes are 400 and write nothing", async () => {
  const bad = [{}, { sha256: "abc" }, { sha256: "g".repeat(64) }, { sha256: SHA_A, size: -1 }, { sha256: SHA_A, size: 1.5 }, { sha256: SHA_A, size: "10" }];
  for (const body of bad) {
    const res = await post(body);
    assert.equal(res._status, 400, JSON.stringify(body));
  }
  assert.equal(gh.putLog.length, 0);
  const upper = await post({ sha256: "A".repeat(64) });
  assert.equal(upper._status, 201, "uppercase hex is normalised, not rejected");
  assert.equal(gh.has(REPO, pathOf(SHA_A)), true);
});

test("DAILY CAP: the global allowance holds across callers and refuses at the cap (cap=3 here)", async () => {
  const shas = ["1", "2", "3", "4"].map((c) => c.repeat(64));
  const codes = [];
  for (let i = 0; i < shas.length; i += 1) {
    const res = await post({ sha256: shas[i] }, { "x-forwarded-for": `198.51.100.${i + 1}` });
    codes.push(res._status);
  }
  assert.deepEqual(codes, [201, 201, 201, 429]);
  assert.equal(gh.read(REPO, today()).count, 3);
  assert.equal(gh.has(REPO, pathOf(shas[3])), false, "the refused stamp must not exist");
});

test("FAIL CLOSED: if the budget counter cannot be written, NO stamp is recorded", async () => {
  gh.forceFailure(REPO, today(), 10, 500);
  const res = await post({ sha256: SHA_A });
  assert.equal(res._status, 503);
  assert.equal(gh.has(REPO, pathOf(SHA_A)), false);
});

test("PER-IP LIMIT: the eleventh stamp from one address in a window is 429 with retry-after", async () => {
  process.env.STAMP_DAILY_CAP = "3"; // cap is read at module load; repeats of one sha cost no budget
  await post({ sha256: SHA_A });
  let last;
  for (let i = 0; i < stamp.IP_LIMIT; i += 1) last = await post({ sha256: SHA_A });
  assert.equal(last._status, 429);
  assert.equal(last._body.reason, "ip_rate_limited");
  assert.ok(Number(last._headers["retry-after"]) >= 1);
  const other = await post({ sha256: SHA_A }, { "x-forwarded-for": "203.0.113.99" });
  assert.equal(other._status, 200, "a different address is not penalised");
});

test("LOOKUP: GET finds a stamp; a store outage is a 503 'not a no', never a 404", async () => {
  await post({ sha256: SHA_A, size: 1 });
  const hit = await get(SHA_A);
  assert.equal(hit._status, 200);
  assert.equal(hit._body.stamp.sha256, SHA_A);
  // The mock store only forces failures on PUT, so a read outage is faked at
  // the fetch layer: GitHub answers 500 for this one path.
  const origFetch = global.fetch;
  global.fetch = (url, opts) =>
    String(url).includes(pathOf(SHA_B))
      ? Promise.resolve({ status: 500, ok: false, json: async () => ({}), text: async () => "boom" })
      : origFetch(url, opts);
  try {
    const outage = await get(SHA_B);
    assert.equal(outage._status, 503);
    assert.equal(outage._body.reason, "store_unreachable");
  } finally {
    global.fetch = origFetch;
  }
});

test("METHODS: OPTIONS answers the preflight; anything else is 405", async () => {
  const pre = makeRes();
  await stamp.handleStamp(makeReq({ method: "OPTIONS" }), pre);
  assert.equal(pre._status, 204);
  assert.match(String(pre._headers["access-control-allow-methods"]), /POST/);
  const del = makeRes();
  await stamp.handleStamp(makeReq({ method: "DELETE" }), del);
  assert.equal(del._status, 405);
});

test("ROUTING: /api/verify?op=stamp reaches the stamp handler, and a plain verify call is untouched", async () => {
  const verifyHandler = require("../api/verify.js");
  const res = makeRes();
  await verifyHandler(
    makeReq({ method: "POST", query: { op: "stamp" }, body: { sha256: SHA_A }, headers: { "x-forwarded-for": "203.0.113.50" } }),
    res
  );
  assert.equal(res._status, 201);
  assert.equal(gh.has(REPO, pathOf(SHA_A)), true);
  const plain = makeRes();
  await verifyHandler(makeReq({ query: { ns: "demo-neverseen", rows: "5", chain: "aaaaaaaa" } }), plain);
  assert.equal(plain._status, 200);
  assert.equal(plain._body.witnessed, null);
});
