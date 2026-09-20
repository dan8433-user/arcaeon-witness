// test/verify_bulk_ratelimit.test.js — the 2026-09-20 fix: api/verify.js's
// ?op=bulk mode is dispatched BEFORE the single-item path's per-IP
// ratelimit.check() and never called it itself, so one unauthenticated POST
// could walk up to MAX_BULK_ITEMS (20) x MAX_HISTORY_SCAN (50) GitHub reads
// against the same token the paid /api/pin write path depends on, with zero
// rate limiting. See WITNESS_UNSHIPPED_COMMITS_AUDIT_2026-09-20.md, Unit B.
//
// The fix: handleBulk now runs its OWN weighted ratelimit.check(req,
// items.length) against the SAME per-IP bucket the single-item path uses
// (lib/_ratelimit.js's new `cost` param), after the cheap shape/cap
// validation and before any store read. This file proves the weighting,
// the zero-store-read guarantee on the blocked call, the shared-bucket
// exactness across single+bulk traffic, and includes a must-fail arm that
// re-creates the pre-fix dispatch order to prove these assertions would
// have caught the original bug.
"use strict";

process.env.GITHUB_PIN_REPO = "test-owner/test-pins";
process.env.GITHUB_PIN_BRANCH = "main";
process.env.GITHUB_PIN_TOKEN = "test-token";

const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const { MockGitHubStore, install } = require("./helpers/mock_store.js");
const { makeReq, makeRes } = require("./helpers/http_mocks.js");
const ratelimit = require("../lib/_ratelimit.js");
const store = require("../lib/_store.js");
const verifyHandler = require("../api/verify.js");

const PIN_REPO = process.env.GITHUB_PIN_REPO;

let gh;
let restore;
let ipCounter = 110000; // high range, disjoint from other files' fixture IPs

beforeEach(() => {
  gh = new MockGitHubStore();
  restore = install(gh);
});

afterEach(() => {
  restore();
});

function freshIp() {
  ipCounter += 1;
  return `198.51.100.${ipCounter % 254 || 1}`;
}

function bulkReq(items, ip) {
  return makeReq({ method: "POST", headers: { "x-forwarded-for": ip }, query: { op: "bulk" }, body: { items } });
}

function singleReq(ip, q) {
  return makeReq({ method: "GET", headers: { "x-forwarded-for": ip }, query: q });
}

function seedCurrent(ns, rows) {
  gh.seed(PIN_REPO, `pins/${ns}/latest.json`, {
    namespace: ns, rows, chain: "aaaaaaaa", seq: 1, pinned_at: new Date().toISOString(),
  });
}

test("CONTRACT: a bulk call whose weight (items.length) crosses the per-IP limit is 429 and makes ZERO store reads", async () => {
  seedCurrent("demo-a", 1);
  const ip = freshIp();

  // Spend the entire LIMIT (30) one unit at a time via single verifies, all
  // must succeed.
  for (let i = 0; i < ratelimit.LIMIT; i++) {
    const res = makeRes();
    await verifyHandler(singleReq(ip, { ns: "demo-a", rows: "1", chain: "aaaaaaaa" }), res);
    assert.notEqual(res._status, 429, `single call ${i + 1} of ${ratelimit.LIMIT} must not be limited yet`);
  }
  const readsBeforeBulk = gh.getLog.length;

  // Budget is fully spent. Any bulk call, even a valid one, must be 429 —
  // and critically, must not touch the store for even one item.
  const items = [{ ns: "demo-a", rows: 1, chain: "aaaaaaaa" }, { ns: "demo-a", rows: 1, chain: "aaaaaaaa" }];
  const res = makeRes();
  await verifyHandler(bulkReq(items, ip), res);

  assert.equal(res._status, 429, "a bulk call after the budget is exhausted must be rejected");
  assert.equal(res._body.ok, false);
  assert.match(res._body.note, /per-instance/i);
  assert.ok(Number(res._headers["retry-after"]) > 0, "Retry-After header must be a positive number of seconds");
  assert.equal(gh.getLog.length, readsBeforeBulk, "a rate-limited bulk call must make ZERO store reads");
});

test("CONTRACT: a different IP's budget is untouched by a hot IP's bulk usage", async () => {
  const hotIp = freshIp();
  const otherIp = freshIp();

  // One 20-item bulk call, twice, from the hot IP: 20 + 20 = 40 > LIMIT(30),
  // so the second call must be blocked.
  const items = [];
  for (let i = 0; i < 20; i++) items.push({ ns: "demo-a", rows: 1, chain: "aaaaaaaa" });
  seedCurrent("demo-a", 1);

  const first = makeRes();
  await verifyHandler(bulkReq(items, hotIp), first);
  assert.notEqual(first._status, 429, "the first 20-item bulk call must be allowed (20 <= LIMIT 30)");

  const second = makeRes();
  await verifyHandler(bulkReq(items, hotIp), second);
  assert.equal(second._status, 429, "the second 20-item bulk call must be blocked (40 > LIMIT 30)");

  const otherRes = makeRes();
  await verifyHandler(bulkReq(items, otherIp), otherRes);
  assert.notEqual(otherRes._status, 429, "a different IP's own budget must be untouched by the hot IP's bulk usage");
});

test("CONTRACT: single verifies and one bulk call share ONE budget, and cross the limit exactly where the weights say — not rounded, not batched", async () => {
  seedCurrent("demo-a", 1);
  const q = { ns: "demo-a", rows: "1", chain: "aaaaaaaa" };
  const items5 = [];
  for (let i = 0; i < 5; i++) items5.push({ ns: "demo-a", rows: 1, chain: "aaaaaaaa" });

  // 25 singles (cost 1 each = 25) + one 5-item bulk (cost 5) = exactly 30 —
  // must land AT the limit, not over it: both must succeed.
  {
    const ip = freshIp();
    for (let i = 0; i < 25; i++) {
      const res = makeRes();
      await verifyHandler(singleReq(ip, q), res);
      assert.notEqual(res._status, 429, `single ${i + 1}/25 must succeed`);
    }
    const bulkRes = makeRes();
    await verifyHandler(bulkReq(items5, ip), bulkRes);
    assert.notEqual(bulkRes._status, 429, "25 singles + a 5-item bulk = exactly 30 (the limit) must still be allowed");

    // The very next single call (the 31st unit) must now be blocked.
    const overRes = makeRes();
    await verifyHandler(singleReq(ip, q), overRes);
    assert.equal(overRes._status, 429, "the 31st unit, one past the shared limit, must be blocked");
  }

  // 25 singles (25) + one 10-item bulk (10) = 35 > 30 — the bulk call
  // ITSELF must be the one that gets blocked, mid-batch-cost, before any
  // store read for that call.
  {
    const ip = freshIp();
    for (let i = 0; i < 25; i++) {
      const res = makeRes();
      await verifyHandler(singleReq(ip, q), res);
      assert.notEqual(res._status, 429, `single ${i + 1}/25 must succeed`);
    }
    const readsBefore = gh.getLog.length;
    const items10 = [];
    for (let i = 0; i < 10; i++) items10.push({ ns: "demo-a", rows: 1, chain: "aaaaaaaa" });
    const bulkRes = makeRes();
    await verifyHandler(bulkReq(items10, ip), bulkRes);
    assert.equal(bulkRes._status, 429, "25 singles + a 10-item bulk = 35 > 30 — the bulk call itself must be blocked");
    assert.equal(gh.getLog.length, readsBefore, "the blocked bulk call must not have read the store");
  }
});

// Worst-case bound (task requirement 4): a 20-item bulk call where EVERY
// item forces a full history scan must perform no more than the documented
// maximum store reads. Per item: 1 read for pins/<ns>/latest.json, plus up
// to MAX_HISTORY_SCAN (50) reads walking backward through history without a
// conclusive match — 51 per item, not 50 (BULK_VERIFY_DESIGN.md previously
// undercounted the latest.json read; corrected here with the measured
// number). 20 items x 51 = 1020.
test("BOUND: a 20-item bulk call where every item forces a full history scan performs at most the documented maximum store reads (1020)", async () => {
  const ns = "demo-worst-case";
  // Current head far ahead of the requested rows, and a 950..999 run of
  // history sitting between them, each with rows > the requested target
  // (1) so the scan never finds a match and never drops below target early
  // — it must walk the full MAX_HISTORY_SCAN (50) before giving up.
  gh.seed(PIN_REPO, `pins/${ns}/latest.json`, {
    namespace: ns, rows: 1000, chain: "aaaaaaaa", seq: 1000, pinned_at: new Date().toISOString(),
  });
  for (let seq = 950; seq <= 999; seq++) {
    gh.seed(PIN_REPO, `pins/${ns}/${String(seq).padStart(8, "0")}.json`, {
      namespace: ns, rows: seq, chain: "bbbbbbbb", seq, pinned_at: new Date().toISOString(),
    });
  }

  const items = [];
  for (let i = 0; i < 20; i++) items.push({ ns, rows: 1, chain: "cccccccc" });

  const ip = freshIp();
  const readsBefore = gh.getLog.length;
  const res = makeRes();
  await verifyHandler(bulkReq(items, ip), res);

  assert.equal(res._status, 200, "a fresh IP with a fresh budget must not be rate limited for one 20-item bulk call");
  assert.ok(res._body.results.every((r) => r.reason === "scan_bound_reached"), "every item must have exhausted the full history scan without a conclusive answer");

  const actualReads = gh.getLog.length - readsBefore;
  const DOCUMENTED_MAX = 20 * 51; // 20 items x (1 latest.json + 50 history scan)
  assert.equal(actualReads, DOCUMENTED_MAX, `measured store reads (${actualReads}) must match the documented worst case (${DOCUMENTED_MAX})`);
  assert.ok(actualReads <= DOCUMENTED_MAX, "the measured worst case must never exceed the documented cap");
});

// Design decision, tested: a malformed or over-cap batch is refused by the
// cheap shape/cap validation, which runs BEFORE ratelimit.check() is ever
// called — so it consumes ZERO rate-limit units. This is deliberate: those
// refusals already cost the caller nothing in store reads (they're checked
// first specifically so garbage is free to reject), and charging a
// rate-limit unit for a request that was never going to touch the store
// would let an attacker grief a legitimate caller's shared budget with
// cheap junk cheaper than the caller could spend it on real traffic. The
// trade-off accepted: an attacker CAN send unlimited malformed batches
// without ever being rate limited for them — but each one costs this
// instance only a Map lookup plus a JSON parse, never a GitHub read, so the
// resource this limiter exists to protect (the shared GitHub API budget) is
// unaffected either way.
test("DESIGN: malformed/over-cap bulk requests consume ZERO rate-limit units — they never reach ratelimit.check()", async () => {
  const ip = freshIp();
  const overCapItems = [];
  for (let i = 0; i < 21; i++) overCapItems.push({ ns: "demo-a", rows: i + 1, chain: "aaaaaaaa" });

  // Send more malformed/over-cap batches than the entire LIMIT — if these
  // consumed units, the budget would already be exhausted.
  for (let i = 0; i < ratelimit.LIMIT + 10; i++) {
    const res = makeRes();
    await verifyHandler(bulkReq(overCapItems, ip), res);
    assert.equal(res._status, 400, `over-cap batch ${i + 1} must be refused, not rate limited`);
  }

  // A genuine, in-cap bulk call from the SAME IP right after must still
  // succeed — proving none of the above spent any budget.
  seedCurrent("demo-a", 1);
  const validRes = makeRes();
  await verifyHandler(bulkReq([{ ns: "demo-a", rows: 1, chain: "aaaaaaaa" }], ip), validRes);
  assert.notEqual(validRes._status, 429, "a valid bulk call after many over-cap refusals must not be rate limited — the refusals must have cost nothing");
});

// MUST-FAIL ARM (task requirement 3): re-create the PRE-FIX dispatch order
// — op=bulk routed straight to store reads, with ratelimit.check() never
// called anywhere in the path — and prove the exact assertion above (bulk
// is weight rate limited) fails against it. This is the receipt that the
// new tests would have caught the original bug, not just that they pass
// against the fixed code.
test("MUST-FAIL ARM: re-creating the pre-fix dispatch (bulk never calls ratelimit.check) fails the weighted-limit assertion", async () => {
  seedCurrent("demo-a", 1);

  // A faithful stand-in for api/verify.js's PRE-FIX module.exports: op=bulk
  // is recognized and its items are looked up against the real store — but
  // nothing anywhere in this path ever calls ratelimit.check(). This is
  // exactly the bug: handleBulk existed, cap-checked, read the store, and
  // returned — with no rate limiter in its call graph at all.
  async function preFixDispatch(req, res) {
    const items = (req.body && req.body.items) || [];
    for (const item of items) {
      await store.getFile(`pins/${item.ns}/latest.json`);
    }
    return res.status(200).json({ ok: true, count: items.length, results: [] });
  }

  // The reusable assertion: two 20-item bulk calls from one IP (40 total
  // units) must have the second one blocked, once weighted rate limiting is
  // wired up correctly.
  async function assertSecondTwentyItemBulkIsBlocked(handler) {
    const ip = freshIp();
    const items = [];
    for (let i = 0; i < 20; i++) items.push({ ns: "demo-a", rows: 1, chain: "aaaaaaaa" });
    await handler(bulkReq(items, ip), makeRes());
    const second = makeRes();
    await handler(bulkReq(items, ip), second);
    assert.equal(second._status, 429, "the second 20-item bulk call (40 total units, over LIMIT 30) must be rate limited");
  }

  // Against the FIXED handler, the assertion holds.
  await assertSecondTwentyItemBulkIsBlocked(verifyHandler);

  // Against the PRE-FIX stand-in, the identical assertion must FAIL — proving
  // this test suite is the kind that would have caught the original bug,
  // not one that merely happens to pass against the code as it stands today.
  await assert.rejects(
    () => assertSecondTwentyItemBulkIsBlocked(preFixDispatch),
    /must be rate limited/,
    "the pre-fix dispatch order (no ratelimit.check anywhere in bulk's path) must fail this assertion — unlimited bulk calls, no matter how many, never get blocked"
  );
});
