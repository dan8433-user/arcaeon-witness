// test/stamp_free_cannot_starve_paid.test.js — free stamps cannot spend the
// whole day's budget out from under a PAYING customer.
//
// SECOND-LINEAGE FINDING (2026-09-20, product_attack_20260920T134017Z.md,
// objection 1), confirmed against the code and fixed here.
//
// lib/_stamp.js's own header names four fences and says of the free-per-day
// allowance: "So this does NOT stop a determined free-rider... The fence that
// holds under attack is the global daily cap below it (store-backed,
// cross-instance, fail-closed)."
//
// The daily cap IS store-backed and cross-instance, and it does hold. The
// problem is what it holds against: takeDailyBudget() was called with one
// ceiling for everybody, and a FREE stamp spent a unit of the same budget a
// PAID stamp needs. So the fence that was supposed to hold under attack was
// itself the thing being exhausted, and the exhaustion refused the paying
// customer — which contradicts the endpoint's own promise, written into its
// 429 body: "a paid stamp is never silently dropped, it is refused here
// before any charge."
//
// The reviewer reached this through x-forwarded-for spoofing. It does not
// need spoofing. freeDays is a module-scope Map on ONE warm serverless
// instance, so the allowance resets on every cold start and is granted
// independently by every concurrent instance — the file's own comment says
// the real ceiling is "(instances x 3), not 3". One address with no key and
// no spoofing can therefore take far more than three, and a small pool of
// addresses can take the day.
//
// THE FIX, and the narrowest one that makes the code do what it already
// says: the free tier is refused at a LOWER ceiling than the paid tier.
// Nothing else moves — no new storage, no change to the paid ceiling, no
// change to what a stamp costs.
//
// This file's cap is deliberately tiny (10, with a 50% free share = 5) so
// the boundary is reachable in a test. DAILY_CAP is read at module load, so
// it is set here before the require, as the other stamp suites do.

"use strict";

process.env.GITHUB_PIN_REPO = "test-owner/test-pins";
process.env.GITHUB_PIN_BRANCH = "main";
process.env.GITHUB_PIN_TOKEN = "test-pin-token";
process.env.GITHUB_USAGE_REPO = "test-owner/test-usage";
process.env.STAMP_REPO = "test-owner/test-stamps";
process.env.STAMP_BRANCH = "main";
process.env.STAMP_TOKEN = "test-stamp-token";
process.env.STAMP_DAILY_CAP = "10";
process.env.STAMP_FREE_PER_DAY = "1000"; // the per-IP allowance is NOT what this file tests
process.env.WITNESS_KEYS = "paidkey:acme-";

const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const { MockGitHubStore, install } = require("./helpers/mock_store.js");
const { makeReq, makeRes } = require("./helpers/http_mocks.js");
const store = require("../lib/_store.js");
const balance = require("../lib/_balance.js");
const stamp = require("../lib/_stamp.js");

const STAMPS_REPO = process.env.STAMP_REPO;
const KEY = "paidkey";
const KEY_HASH = balance.keyHash(KEY);
const crypto = require("crypto");
const shaOf = (l) => crypto.createHash("sha256").update(String(l)).digest("hex");
const pathOf = (s) => `stamps/${s.slice(0, 2)}/${s}.json`;
const dayPath = () => `stamps/_meta/day-${new Date().toISOString().slice(0, 10)}.json`;

let gh;
let restore;
let realSleep;

beforeEach(() => {
  gh = new MockGitHubStore();
  restore = install(gh);
  stamp._resetLimiterForTests();
  realSleep = store._putRetry.sleep;
  store._putRetry.sleep = async () => {};
  process.env.STAMP_FREE_PER_DAY = "1000";
  delete process.env.STAMP_FREE_SHARE_OF_CAP;
});

afterEach(() => {
  store._putRetry.sleep = realSleep;
  restore();
  delete process.env.STAMP_FREE_SHARE_OF_CAP;
});

// A free stamp: no Authorization header. Each call uses a fresh address so
// the per-IP BURST limiter (10 per 10 min) never becomes the thing under
// test — this file is about the global budget, not the burst fence.
let ipN = 0;
async function freeStamp(label) {
  ipN += 1;
  const res = makeRes();
  await stamp.handleStamp(
    makeReq({ method: "POST", headers: { "x-forwarded-for": `198.18.0.${(ipN % 250) + 1}` }, body: { sha256: shaOf(label) } }),
    res
  );
  return res;
}

async function paidStamp(label) {
  ipN += 1;
  const res = makeRes();
  await stamp.handleStamp(
    makeReq({
      method: "POST",
      headers: { "x-forwarded-for": `198.19.0.${(ipN % 250) + 1}`, authorization: `Bearer ${KEY}` },
      body: { sha256: shaOf(label) },
    }),
    res
  );
  return res;
}

function fundKey(credits) {
  gh.seed("test-owner/test-usage", `balance/${KEY_HASH}.json`, {
    key_id: KEY_HASH.slice(0, 12), key_hash: KEY_HASH, balance: credits, seq: 1,
    updated_at: new Date().toISOString(), applied_events: [],
  });
}

function budgetUsed() {
  const rec = gh.read(STAMPS_REPO, dayPath());
  return rec ? rec.count : 0;
}

// ---------------------------------------------------------------------

test("FREE CANNOT STARVE PAID: free stamps are refused at their own ceiling, and a paying customer still gets served", async () => {
  fundKey(100);
  const cap = stamp.DAILY_CAP;
  const freeCeiling = stamp.freeCeiling();
  assert.equal(cap, 10, "this file's fixture cap moved");
  assert.ok(freeCeiling > 0 && freeCeiling < cap,
    `the free ceiling (${freeCeiling}) must sit strictly below the daily cap (${cap}), or free traffic can still take the whole day`);

  // Fill the free tier exactly to its ceiling.
  for (let i = 0; i < freeCeiling; i += 1) {
    const res = await freeStamp(`free-${i}`);
    assert.equal(res._status, 201, `free stamp ${i} should be inside the free ceiling: ${JSON.stringify(res._body)}`);
    assert.equal(res._body.billing.paid, false);
  }
  assert.equal(budgetUsed(), freeCeiling);

  // The next KEYLESS stamp is refused — and refused honestly, naming the
  // free tier rather than reporting the whole service as out of budget, and
  // pointing at the path that still works.
  const overFree = await freeStamp("free-over");
  assert.equal(overFree._status, 401);
  assert.equal(overFree._body.reason, "free_daily_cap_reached");
  assert.match(overFree._body.error, /witness key can still be recorded right now/);
  assert.equal(gh.has(STAMPS_REPO, pathOf(shaOf("free-over"))), false, "a refused free stamp must write nothing");
  assert.equal(budgetUsed(), freeCeiling, "a refused free stamp must not spend a budget unit");

  // THE POINT OF THE WHOLE FILE. The paying customer is still served.
  const paid = await paidStamp("paid-1");
  assert.equal(paid._status, 201, `the paying customer was starved by free traffic: ${JSON.stringify(paid._body)}`);
  assert.equal(paid._body.billing.paid, true);
  assert.equal(paid._body.billing.credits_charged, stamp.STAMP_PRICE_CREDITS);
  assert.equal(gh.has(STAMPS_REPO, pathOf(shaOf("paid-1"))), true);

  // And the paid tier still stops at the REAL cap, so the reserve is a
  // floor under paid traffic, not a licence to exceed the day's budget.
  for (let i = budgetUsed(); i < cap; i += 1) {
    const res = await paidStamp(`paid-fill-${i}`);
    assert.equal(res._status, 201, `paid stamp ${i} should be inside the daily cap`);
  }
  assert.equal(budgetUsed(), cap);
  const overPaid = await paidStamp("paid-over");
  assert.equal(overPaid._status, 429);
  assert.equal(overPaid._body.reason, "daily_cap_reached");
  assert.equal(overPaid._body.cap, cap);

  // A refused paid stamp charges nothing — the cap is checked before the
  // debit, which is the promise the 429 body makes.
  const bal = gh.read("test-owner/test-usage", `balance/${KEY_HASH}.json`);
  const paidWrites = gh.putLog.filter((p) => p.repo === STAMPS_REPO && p.path.startsWith("stamps/") && !p.path.startsWith("stamps/_meta/")).length;
  assert.equal(bal.balance, 100 - stamp.STAMP_PRICE_CREDITS * (paidWrites - freeCeiling),
    "a refused paid stamp was charged, or a free stamp was");
});

test("MUST-FAIL ARM: with the free share set to the whole cap, free traffic DOES starve the paying customer", async () => {
  // This is the pre-fix behaviour, reachable through the operator lever.
  // It exists so the test above cannot pass against a build where the free
  // and paid ceilings are the same number.
  process.env.STAMP_FREE_SHARE_OF_CAP = "1";
  fundKey(100);
  const cap = stamp.DAILY_CAP;
  assert.equal(stamp.freeCeiling(), cap, "the lever did not move the free ceiling");

  for (let i = 0; i < cap; i += 1) {
    const res = await freeStamp(`starve-${i}`);
    assert.equal(res._status, 201, `free stamp ${i} should be allowed when the free share is the whole cap`);
  }
  assert.equal(budgetUsed(), cap);

  const paid = await paidStamp("starved");
  assert.equal(paid._status, 429,
    "free traffic did NOT starve the paid customer here, so the main test is not measuring the reserve");
  assert.equal(paid._body.reason, "daily_cap_reached");
  assert.equal(gh.has(STAMPS_REPO, pathOf(shaOf("starved"))), false);

  // Nothing was charged for the refusal.
  const bal = gh.read("test-owner/test-usage", `balance/${KEY_HASH}.json`);
  assert.equal(bal.balance, 100, "a customer was charged for a stamp the cap refused");
});

test("THE LEVER IS BOUNDED: a nonsense free share falls back to the default, never above the cap and never negative", () => {
  const cap = stamp.DAILY_CAP;
  for (const v of ["", "abc", "-1", "5", "1.7", "NaN", undefined]) {
    if (v === undefined) delete process.env.STAMP_FREE_SHARE_OF_CAP;
    else process.env.STAMP_FREE_SHARE_OF_CAP = v;
    const c = stamp.freeCeiling();
    assert.ok(Number.isInteger(c), `free ceiling is not an integer for ${JSON.stringify(v)}: ${c}`);
    assert.ok(c >= 0 && c <= cap, `free ceiling ${c} out of range for ${JSON.stringify(v)}`);
  }
  // 0 is a legitimate setting: it makes every stamp paid via the budget
  // rather than via the allowance.
  process.env.STAMP_FREE_SHARE_OF_CAP = "0";
  assert.equal(stamp.freeCeiling(), 0);
});
