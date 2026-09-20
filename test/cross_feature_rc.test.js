// test/cross_feature_rc.test.js — the tests no SINGLE branch could have run.
//
// The release candidate for 2026-09-20 merges four independently-green
// branches (`bulk-ratelimit`, `reserve-brand-stems`, `stamp-own-repo`, and
// main's own 10 unshipped commits) into one deployment. Each branch tested
// its own feature against its own base. Nothing tested the SEAMS:
//
//   (a) two rate-limited modes now ride on ONE endpoint (api/verify.js
//       dispatches ?op=stamp AND ?op=bulk). Which budget does each spend?
//       Does either one get dispatched ahead of its own limiter?
//   (b) the stamp mode is new env. What does a deployment that has NOT set
//       STAMP_* do — and does the absence change anything else?
//   (c) two repos and two tokens now exist in one process. Can a stamp
//       reach the pins repo or the pin token when BOTH are configured?
//   (d) the stamps log's genesis record is written into the PINS repo by
//       tools/stamp_genesis.js, and lib/_status_data.js counts files in
//       that repo as conflict observations. Do they collide?
//   (e) the stamp rewrite consumed the last slot of Vercel Hobby's
//       12-function cap. A 13th file is a REFUSED DEPLOY, not a warning.
//
// EVERY CLAIM HERE CARRIES A MUST-FAIL ARM. A green assertion that would
// stay green with the mechanism removed proves nothing, so each block
// either sabotages the guard in place and asserts the opposite outcome, or
// re-runs its own measuring instrument against a deliberately-broken
// stand-in to prove the instrument discriminates.

"use strict";

process.env.GITHUB_PIN_REPO = "test-owner/test-pins";
process.env.GITHUB_PIN_BRANCH = "main";
process.env.GITHUB_PIN_TOKEN = "test-pin-token";
process.env.GITHUB_USAGE_REPO = "test-owner/test-usage";
process.env.GITHUB_USAGE_BRANCH = "main";
process.env.STAMP_REPO = "test-owner/test-stamps";
process.env.STAMP_BRANCH = "main";
process.env.STAMP_TOKEN = "test-stamp-token";
process.env.STAMP_DAILY_CAP = "500";
process.env.WITNESS_KEYS = "xfkey:demo-";
delete process.env.WITNESS_PLANS;
delete process.env.WITNESS_CADENCE;

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const { MockGitHubStore, install } = require("./helpers/mock_store.js");
const { makeReq, makeRes } = require("./helpers/http_mocks.js");

const store = require("../lib/_store.js");
const ratelimit = require("../lib/_ratelimit.js");
const stamp = require("../lib/_stamp.js");
const stampStore = require("../lib/_stamp_store.js");
const genesisTool = require("../tools/stamp_genesis.js");

const verifyHandler = require("../api/verify.js");
const pinHandler = require("../api/pin.js");
const statusHandler = require("../api/status.js");
const healthHandler = require("../api/health.js");

const PINS_REPO = "test-owner/test-pins";
const STAMPS_REPO = "test-owner/test-stamps";
const PIN_TOKEN = "test-pin-token";
const STAMP_TOKEN = "test-stamp-token";

const shaOf = (label) => crypto.createHash("sha256").update(String(label)).digest("hex");
const stampPathOf = (s) => `stamps/${s.slice(0, 2)}/${s}.json`;

let gh;
let restore;
let realPutSleep;
// Every fetch this file's handlers make, with the Authorization header the
// store actually attached. Authored by the fixture, not by the code under
// test — the whole point of (c).
let wire;

// IP pool disjoint from every other test file's fixture addresses. The
// limiters live in module scope and node:test gives this file its own
// process, but two tests in THIS file must still not share a bucket.
let ipCounter = 0;
function freshIp() {
  ipCounter += 1;
  return `203.0.113.${(ipCounter % 250) + 1}`;
}

beforeEach(() => {
  gh = new MockGitHubStore();
  const undo = install(gh);
  wire = [];
  const mocked = global.fetch;
  global.fetch = (url, opts) => {
    const headers = (opts && opts.headers) || {};
    wire.push({
      url: String(url),
      method: (opts && opts.method) || "GET",
      authorization: headers.authorization || headers.Authorization || null,
      ua: headers["user-agent"] || null,
    });
    // The recursive-tree call the status page makes. The shared mock only
    // speaks the contents API, so it is served here, from the same repo map,
    // rather than by editing a helper five other files depend on.
    const m = String(url).match(/^https?:\/\/[^/]+\/repos\/([^/]+\/[^/]+)\/git\/trees\//);
    if (m) {
      const map = gh.repos.get(m[1]) || new Map();
      const tree = [...map.keys()].map((p) => ({ path: p, type: "blob" }));
      return Promise.resolve({
        status: 200,
        ok: true,
        json: async () => ({ tree }),
        text: async () => JSON.stringify({ tree }),
      });
    }
    return mocked(url, opts);
  };
  restore = () => {
    global.fetch = mocked;
    undo();
  };

  realPutSleep = store._putRetry.sleep;
  store._putRetry.sleep = async () => {};
  stamp._resetLimiterForTests();

  process.env.STAMP_REPO = STAMPS_REPO;
  process.env.STAMP_BRANCH = "main";
  process.env.STAMP_TOKEN = STAMP_TOKEN;
  process.env.STAMP_FREE_PER_DAY = "3";
  process.env.STAMP_DAILY_CAP = "500";
});

afterEach(() => {
  store._putRetry.sleep = realPutSleep;
  restore();
  process.env.STAMP_REPO = STAMPS_REPO;
  process.env.STAMP_TOKEN = STAMP_TOKEN;
});

// ---- request shapes ---------------------------------------------------
function stampReq(label, ip, extra = {}) {
  return makeReq({
    method: "POST",
    headers: { "x-forwarded-for": ip, ...(extra.headers || {}) },
    query: { op: "stamp" },
    body: { sha256: shaOf(label) },
  });
}
function bulkReq(n, ip) {
  const items = [];
  for (let i = 0; i < n; i += 1) items.push({ ns: `demo-${i}`, rows: 1, chain: "cafebabe" });
  return makeReq({ method: "POST", headers: { "x-forwarded-for": ip }, query: { op: "bulk" }, body: { items } });
}
function singleVerifyReq(ip) {
  return makeReq({ method: "GET", headers: { "x-forwarded-for": ip }, query: { ns: "demo-x", rows: "1", chain: "cafebabe" } });
}
async function call(handler, req) {
  const res = makeRes();
  await handler(req, res);
  return res;
}

// How many more single verifies this IP can make before the SHARED
// lib/_ratelimit.js bucket refuses it. Spends the budget it measures, so it
// is always the last thing a test does with that address.
async function sharedBudgetRemaining(ip) {
  let n = 0;
  for (let i = 0; i < ratelimit.LIMIT + 5; i += 1) {
    const res = await call(verifyHandler, singleVerifyReq(ip));
    if (res._status === 429) return n;
    n += 1;
  }
  throw new Error("the shared per-IP budget never refused; the limiter is not engaged at all");
}

// =====================================================================
// (a) TWO MODES, ONE ENDPOINT: which budget does each spend, and does
//     either get dispatched ahead of its own limiter?
// =====================================================================

test("CROSS (a1): a stamp and a bulk verify from ONE IP spend the budgets their designs name — the stamp's own bucket, not the shared read budget", async () => {
  const ip = freshIp();

  // Three stamps: inside the stamp mode's own per-IP burst limiter (10) and
  // inside the free allowance (3), so all three are real, completed work.
  for (const label of ["a1-one", "a1-two", "a1-three"]) {
    const res = await call(verifyHandler, stampReq(label, ip));
    assert.equal(res._status, 201, `stamp ${label} should have been written: ${JSON.stringify(res._body)}`);
  }
  // Stamp RECORDS only — each stamp also bumps stamps/_meta/day-*.json, the
  // global daily budget counter, which is a different write.
  const records = gh.putLog.filter((p) => p.repo === STAMPS_REPO && p.path.startsWith("stamps/") && !p.path.startsWith("stamps/_meta/"));
  assert.equal(records.length, 3);

  // One bulk verify of 5 items: by design this spends FIVE units of the
  // shared read budget (lib/_ratelimit.js's `cost`).
  const bulk = await call(verifyHandler, bulkReq(5, ip));
  assert.equal(bulk._status, 200);

  // The shared budget should now be down exactly 5 — the three stamps drew
  // on lib/_stamp.js's separate bucket, not this one.
  const remaining = await sharedBudgetRemaining(ip);
  assert.equal(
    remaining,
    ratelimit.LIMIT - 5,
    `shared budget should be down by the bulk weight (5) alone; 3 stamps must not have touched it. ` +
      `LIMIT=${ratelimit.LIMIT}, remaining=${remaining}`
  );

  // MUST-FAIL ARM. The measurement above is only meaningful if it would
  // have detected the opposite. Re-run it on a fresh address where the
  // three stamps DO spend the shared budget (simulated by charging it
  // directly, which is exactly what a shared-bucket implementation would
  // do), and prove the same assertion fails.
  const ip2 = freshIp();
  const shim = makeReq({ method: "POST", headers: { "x-forwarded-for": ip2 } });
  for (let i = 0; i < 3; i += 1) ratelimit.check(shim, 1); // the bug shape
  await call(verifyHandler, bulkReq(5, ip2));
  const remainingIfShared = await sharedBudgetRemaining(ip2);
  assert.equal(remainingIfShared, ratelimit.LIMIT - 8,
    "the must-fail arm did not reproduce the shared-bucket shape; the measurement proves nothing");
  assert.notEqual(remainingIfShared, ratelimit.LIMIT - 5,
    "the a1 assertion would pass against a shared-bucket implementation too — it does not discriminate");
});

test("CROSS (a2): NEITHER mode is dispatched ahead of its own limiter — the stamp burst cap and the weighted read budget both refuse, from the same address", async () => {
  const ip = freshIp();
  process.env.STAMP_FREE_PER_DAY = "50"; // isolate the BURST limiter from the free allowance

  // The stamp mode's own limiter: IP_LIMIT per window, then 429.
  let lastStamp;
  for (let i = 1; i <= stamp.IP_LIMIT; i += 1) {
    lastStamp = await call(verifyHandler, stampReq(`a2-${i}`, ip));
    assert.equal(lastStamp._status, 201, `stamp ${i} of ${stamp.IP_LIMIT} should be inside the burst cap`);
  }
  const writesBefore = gh.putLog.length;
  const overStamp = await call(verifyHandler, stampReq(`a2-over`, ip));
  assert.equal(overStamp._status, 429, "the stamp past IP_LIMIT must be refused, not dispatched");
  assert.equal(overStamp._body.reason, "ip_rate_limited");
  assert.equal(gh.putLog.length, writesBefore, "a rate-limited stamp must write nothing");

  // The SAME address, on the shared read budget, is refused by the other
  // limiter — bulk mode is not a way around it.
  await call(verifyHandler, bulkReq(20, ip));
  await call(verifyHandler, bulkReq(20, ip)); // 40 > LIMIT(30)
  const getsBefore = gh.getLog.length;
  const overBulk = await call(verifyHandler, bulkReq(20, ip));
  assert.equal(overBulk._status, 429, "bulk past the shared budget must be refused");
  assert.equal(gh.getLog.length, getsBefore, "a rate-limited bulk call must make zero store reads");

  // MUST-FAIL ARM: a limiter that does not accumulate is the bug shape both
  // of these guards exist to prevent. Reset the stamp buckets between every
  // call — the exact behaviour of "no limiter at all" — and prove the
  // IP_LIMIT assertion above goes green-to-red.
  const ip3 = freshIp();
  let sawRefusal = false;
  for (let i = 1; i <= stamp.IP_LIMIT + 3; i += 1) {
    stamp._resetLimiterForTests(); // sabotage: the guard never accumulates
    const res = await call(verifyHandler, stampReq(`a2-nolimit-${i}`, ip3));
    if (res._status === 429) sawRefusal = true;
  }
  assert.equal(sawRefusal, false,
    "the must-fail arm still refused, so the a2 assertion is not actually measuring accumulation");

  process.env.STAMP_FREE_PER_DAY = "3";
});

// =====================================================================
// (b) A DEPLOYMENT THAT HAS NOT SET STAMP_*
// =====================================================================

test("CROSS (b): with STAMP_* unset the stamp mode is 503 and writes nothing anywhere; pin, verify, bulk, status and health are untouched", async () => {
  delete process.env.STAMP_REPO;
  delete process.env.STAMP_TOKEN;

  // --- the stamp mode, both methods ---
  const post = await call(verifyHandler, stampReq("b-unset", freshIp()));
  assert.equal(post._status, 503);
  assert.equal(post._body.reason, "stamp_store_not_configured");
  assert.deepEqual(post._body.missing_config, ["STAMP_REPO", "STAMP_TOKEN"]);
  assert.match(post._body.error, /never written into the witness pins repository/);

  const get = await call(
    verifyHandler,
    makeReq({ method: "GET", headers: { "x-forwarded-for": freshIp() }, query: { op: "stamp", sha256: shaOf("b-unset") } })
  );
  assert.equal(get._status, 503);

  // Nothing was written, and nothing was even ASKED for — the gate sits
  // ahead of every store touch, so no request was ever in flight to be
  // misrouted.
  assert.equal(gh.putLog.length, 0, "an unconfigured stamp endpoint must write nothing");
  assert.equal(wire.length, 0, "an unconfigured stamp endpoint must not reach the network at all");

  // --- everything else, in the same unset state ---
  const pinRes = await call(
    pinHandler,
    makeReq({ method: "POST", headers: { authorization: "Bearer xfkey" }, body: { namespace: "demo-b", rows: 7, chain: "cafebabe" } })
  );
  assert.equal(pinRes._status, 201, `pin must be unaffected by missing STAMP_*: ${JSON.stringify(pinRes._body)}`);
  assert.ok(gh.has(PINS_REPO, "pins/demo-b/latest.json"));
  assert.equal(gh.putLog.filter((p) => p.repo === STAMPS_REPO).length, 0);

  gh.seed(PINS_REPO, "pins/demo-v/latest.json", {
    namespace: "demo-v", rows: 3, chain: "cafebabe", seq: 1,
    pinned_at: new Date().toISOString(), cadence_hours: 24,
    next_pin_due_by: new Date(Date.now() + 3600e3).toISOString(),
  });
  const v = await call(verifyHandler, makeReq({ method: "GET", headers: { "x-forwarded-for": freshIp() }, query: { ns: "demo-v", rows: "3", chain: "cafebabe" } }));
  assert.equal(v._status, 200);
  assert.equal(v._body.witnessed, true, `single verify changed shape: ${JSON.stringify(v._body)}`);

  const b = await call(verifyHandler, makeReq({ method: "POST", headers: { "x-forwarded-for": freshIp() }, query: { op: "bulk" }, body: { items: [{ ns: "demo-v", rows: 3, chain: "cafebabe" }] } }));
  assert.equal(b._status, 200);
  assert.equal(b._body.count, 1);

  const s = await call(statusHandler, makeReq({ method: "GET", query: {} }));
  assert.equal(s._status, 200);

  const h = await call(healthHandler, makeReq({ method: "GET", query: {} }));
  assert.ok(h._status === 200 || h._status === 503, `health answered ${h._status}`);

  // MUST-FAIL ARM: restore the env and prove the SAME stamp request is no
  // longer 503. Without this, "503" could be coming from a broken fixture
  // rather than from the configuration gate.
  process.env.STAMP_REPO = STAMPS_REPO;
  process.env.STAMP_TOKEN = STAMP_TOKEN;
  const after = await call(verifyHandler, stampReq("b-unset", freshIp()));
  assert.equal(after._status, 201, "with STAMP_* set the same request must succeed; the 503 above was the gate, not the harness");
});

// =====================================================================
// (c) TWO REPOS, TWO TOKENS, ONE PROCESS
// =====================================================================

test("CROSS (c): with BOTH the pin and stamp credentials present, a stamp reaches only the stamps repo and only with the stamp token", async () => {
  const ip = freshIp();
  assert.equal(process.env.GITHUB_PIN_TOKEN, PIN_TOKEN);
  assert.equal(process.env.STAMP_TOKEN, STAMP_TOKEN);
  assert.notEqual(PIN_TOKEN, STAMP_TOKEN);

  const res = await call(verifyHandler, stampReq("c-both", ip));
  assert.equal(res._status, 201, JSON.stringify(res._body));

  // Every write landed in the stamps repo.
  assert.ok(gh.putLog.length > 0);
  for (const w of gh.putLog) {
    assert.equal(w.repo, STAMPS_REPO, `a stamp wrote to ${w.repo}/${w.path}`);
  }
  assert.equal(gh.has(STAMPS_REPO, stampPathOf(shaOf("c-both"))), true);
  assert.equal(gh.has(PINS_REPO, stampPathOf(shaOf("c-both"))), false);

  // And every request the stamp made carried the STAMP token. The pin token
  // is in the process environment the whole time; it must never appear on
  // this traffic.
  assert.ok(wire.length > 0);
  for (const w of wire) {
    assert.ok(w.url.includes(STAMPS_REPO), `stamp traffic reached ${w.url}`);
    assert.equal(w.authorization, `Bearer ${STAMP_TOKEN}`, `stamp request carried ${w.authorization}`);
    assert.notEqual(w.authorization, `Bearer ${PIN_TOKEN}`);
  }

  // MUST-FAIL ARM 1: the detector above must actually fire on the thing it
  // claims to detect. Point the store primitives at a target that names the
  // PIN token and the PINS repo — the misrouting this whole design exists
  // to prevent — and prove the same two checks go red.
  const bad = store.forTarget({ repo: PINS_REPO, branch: "main", tokenEnv: "GITHUB_PIN_TOKEN", ua: "x" });
  const wireBefore = wire.length;
  await bad.putFile("stamps/ff/deadbeef.json", { k: 1 }, "misrouted", undefined, {});
  const misrouted = wire.slice(wireBefore);
  assert.ok(misrouted.some((w) => w.url.includes(PINS_REPO)), "must-fail arm did not reach the pins repo");
  assert.ok(
    misrouted.some((w) => w.authorization === `Bearer ${PIN_TOKEN}`),
    "must-fail arm did not carry the pin token; the (c) assertions do not discriminate"
  );
  assert.equal(gh.has(PINS_REPO, "stamps/ff/deadbeef.json"), true,
    "must-fail arm did not land in the pins repo, so the repo check proves nothing");
});

test("CROSS (c2): STAMP_REPO set BY HAND to the pins repo is refused — the endpoint 503s and the pins repo is never touched", async () => {
  process.env.STAMP_REPO = PINS_REPO; // the one-typo scenario
  const cfg = stampStore.status();
  assert.equal(cfg.configured, false);
  assert.equal(cfg.reason, "stamp_repo_is_pins_repo");

  const res = await call(verifyHandler, stampReq("c2", freshIp()));
  assert.equal(res._status, 503);
  assert.equal(res._body.reason, "stamp_repo_is_pins_repo");
  assert.equal(gh.putLog.length, 0);
  assert.equal(wire.length, 0);

  // MUST-FAIL ARM: a DIFFERENT repo with the same everything else is
  // accepted, so the refusal above is the pins-repo check and not a blanket
  // failure of the fixture.
  process.env.STAMP_REPO = STAMPS_REPO;
  const ok = await call(verifyHandler, stampReq("c2", freshIp()));
  assert.equal(ok._status, 201);
});

test("CROSS (c3): no store target can borrow the pin token by omission", async () => {
  // The 2026-09-20 hardening: a non-pins target with no tokenEnv used to
  // fall back to GITHUB_PIN_TOKEN. It now refuses, and nothing goes out.
  const halfBuilt = store.forTarget({ repo: STAMPS_REPO, branch: "main", ua: "x" });
  const before = wire.length;
  await assert.rejects(
    () => halfBuilt.getFile("stamps/aa/x.json"),
    /refusing to fall back to the pin token/
  );
  assert.equal(wire.length, before, "a refused target must not put a request on the wire");

  // MUST-FAIL ARM: the same target WITH a tokenEnv does reach the wire, so
  // the refusal above is the guard and not a malformed target object.
  const complete = store.forTarget({ repo: STAMPS_REPO, branch: "main", tokenEnv: "STAMP_TOKEN", ua: "x" });
  await complete.getFile("stamps/aa/x.json");
  assert.equal(wire.length, before + 1, "a complete target must reach the wire; the c3 assertion does not discriminate");
  assert.equal(wire[wire.length - 1].authorization, `Bearer ${STAMP_TOKEN}`);
});

// =====================================================================
// (d) THE GENESIS RECORD AND THE CONFLICT COUNTER SHARE A REPOSITORY
// =====================================================================

test("CROSS (d): the status page never counts a genesis/ record as a conflict observation", async () => {
  gh.seed(PINS_REPO, "pins/demo-d/latest.json", {
    namespace: "demo-d", rows: 5, chain: "cafebabe", seq: 1,
    pinned_at: new Date().toISOString(), cadence_hours: 24,
    next_pin_due_by: new Date(Date.now() + 3600e3).toISOString(),
  });
  gh.seed(PINS_REPO, "observations/2026-01-01T00-00-00Z.json", { kind: "conflict", ns: "demo-d" });

  // The genesis record, at the path the tool actually writes to.
  const g = genesisTool.genesisPath("a".repeat(40));
  gh.seed(PINS_REPO, g, { kind: "sibling-log-genesis" });

  const conflictCount = async () => {
    const res = await call(statusHandler, makeReq({ method: "GET", query: { format: "json" } }));
    assert.equal(res._status, 200);
    const data = typeof res._body === "string" ? JSON.parse(res._body) : res._body;
    assert.equal(data.summary.conflicts_observed, data.conflict_observations.count,
      "the summary count and the detail count disagree");
    return data.conflict_observations.count;
  };

  const count = await conflictCount();
  assert.equal(count, 1, `the genesis record was counted as a conflict (count=${count}, genesis at ${g})`);

  // The binding fact, asserted directly rather than inferred: the tool's
  // own directory constant is outside the folder the status page counts.
  assert.ok(!genesisTool.GENESIS_DIR.startsWith("observations/"),
    `tools/stamp_genesis.js writes to ${genesisTool.GENESIS_DIR}, which the status page counts as conflicts`);
  assert.ok(!g.startsWith("observations/"));

  // MUST-FAIL ARM: put a genesis-shaped record INSIDE observations/ and
  // prove the counter does rise to 2 — so the "1" above is the directory
  // separation doing the work, not a counter that is stuck.
  gh.seed(PINS_REPO, "observations/genesis-lookalike.json", { kind: "sibling-log-genesis" });
  const count2 = await conflictCount();
  assert.equal(count2, 2, "the conflict counter did not respond to a file added under observations/; it is not measuring what (d) claims");
});

// =====================================================================
// (e) THE FUNCTION CAP IS A DEPLOY GATE, NOT A WARNING
// =====================================================================

// Counting factored out so the must-fail arm can run it against a synthetic
// listing. Vercel routes every .js file directly under api/ as a function;
// an underscore-prefixed file elsewhere in the tree is a library, not a
// route, which is why lib/_stamp.js exists at all.
function countFunctions(files) {
  return files.filter((f) => f.endsWith(".js")).length;
}

test("CROSS (e): api/ still holds at most 12 serverless functions, and /api/stamp is a rewrite rather than a 13th file", () => {
  const apiDir = path.join(__dirname, "..", "api");
  const files = fs.readdirSync(apiDir);
  const n = countFunctions(files);
  assert.ok(n <= 12,
    `api/ holds ${n} serverless functions (${files.join(", ")}); Vercel Hobby hard-caps this plan at 12 and a 13th is a REFUSED DEPLOY, not a warning`);

  // The stamp endpoint exists only because it is a rewrite onto verify.
  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "vercel.json"), "utf-8"));
  const rule = (cfg.rewrites || []).find((r) => r.source === "/api/stamp");
  assert.ok(rule, "vercel.json must carry the /api/stamp rewrite; without it the endpoint 404s in production");
  assert.equal(rule.destination, "/api/verify?op=stamp");
  assert.equal(fs.existsSync(path.join(apiDir, "stamp.js")), false,
    "api/stamp.js exists — that is the 13th function and a refused deploy");

  // And the other co-hosted route is still a rewrite too, so this merge did
  // not quietly turn one of them back into a file.
  const pa = (cfg.rewrites || []).find((r) => r.source === "/api/prefix-available");
  assert.ok(pa && pa.destination === "/api/fulfill?op=prefix-available");

  // MUST-FAIL ARM: the counter must report 13 for a listing with one more
  // file, so `n <= 12` is a real gate and not an assertion that can never
  // fail.
  assert.equal(countFunctions([...files, "stamp.js"]), n + 1);
  assert.equal(countFunctions([...files, "stamp.js"]) <= 12, false,
    "the function counter does not refuse a 13th file; assertion (e) proves nothing");
});
