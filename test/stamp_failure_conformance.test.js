// test/stamp_failure_conformance.test.js — FAILURE conformance for the stamp CHECK
// (GET /api/stamp?sha256=..., lib/_stamp.js handleStamp).
//
// "Does the check FAIL when given a bad X?" Every case asks about a fingerprint
// that is NOT validly stamped (or a malformed request, or a corrupt store) and
// asserts the answer is not a positive "stamped" (200 + ok:true + stamp).
// The break arm runs every case against a handler that always answers stamped,
// and asserts each case goes red. Known accept-bad-input findings stay `todo`.
"use strict";

process.env.GITHUB_PIN_REPO = "test-owner/test-pins";
process.env.GITHUB_PIN_BRANCH = "main";
process.env.GITHUB_PIN_TOKEN = "test-token";
process.env.STAMP_REPO = "test-owner/test-stamps";
process.env.STAMP_BRANCH = "main";
process.env.STAMP_TOKEN = "test-stamp-token";
process.env.STAMP_DAILY_CAP = "3";
process.env.STAMP_FREE_PER_DAY = "1000";

const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const { MockGitHubStore, install } = require("./helpers/mock_store.js");
const { makeReq, makeRes } = require("./helpers/http_mocks.js");
const stamp = require("../lib/_stamp.js");

const REPO = process.env.STAMP_REPO;
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const pathOf = (sha) => `stamps/${sha.slice(0, 2)}/${sha}.json`;
const record = (sha, extra = {}) => ({ sha256: sha, size: 1234, stamped_at: "2026-09-20T00:00:00.000Z", ...extra });

let gh;
let restore;

beforeEach(() => {
  gh = new MockGitHubStore();
  restore = install(gh);
  stamp._resetLimiterForTests();
});

afterEach(() => {
  restore();
});

async function getWith(handler, query) {
  const res = makeRes();
  await handler(makeReq({ method: "GET", query }), res);
  return res;
}

// Positive answer = 200 + ok:true + a stamp object. Anything else is not "stamped".
function assertNotStamped(res, label) {
  const b = res._body || {};
  const positive = res._status === 200 && b.ok === true && !!b.stamp;
  assert.equal(positive, false, `${label}: check said STAMPED on bad input (status ${res._status}, ${JSON.stringify(b).slice(0, 300)})`);
}

test("PRECONDITION: a genuine stamp IS reported stamped (so every red below is the check's doing)", async () => {
  gh.seed(REPO, pathOf(SHA_A), record(SHA_A));
  const res = await getWith(stamp.handleStamp, { sha256: SHA_A });
  assert.equal(res._status, 200);
  assert.equal(res._body.ok, true);
  assert.equal(res._body.stamp.sha256, SHA_A);
});

const CASES = [
  ["fingerprint never stamped", (h) => getWith(h, { sha256: SHA_B })],
  ["a DIFFERENT fingerprint is stamped, not this one", (h) => { gh.seed(REPO, pathOf(SHA_A), record(SHA_A)); return getWith(h, { sha256: SHA_B }); }],
  ["one hex digit off a stamped fingerprint", (h) => { gh.seed(REPO, pathOf(SHA_A), record(SHA_A)); return getWith(h, { sha256: SHA_A.slice(0, -1) + "b" }); }],
  ["prefix of a stamped fingerprint (63 chars)", (h) => { gh.seed(REPO, pathOf(SHA_A), record(SHA_A)); return getWith(h, { sha256: SHA_A.slice(0, 63) }); }],
  ["stamped fingerprint plus one char (65 chars)", (h) => { gh.seed(REPO, pathOf(SHA_A), record(SHA_A)); return getWith(h, { sha256: SHA_A + "a" }); }],
  ["non-hex characters", (h) => getWith(h, { sha256: "g".repeat(64) })],
  ["missing sha256 param", (h) => getWith(h, {})],
  ["empty sha256", (h) => getWith(h, { sha256: "" })],
  ["array-valued sha256", (h) => { gh.seed(REPO, pathOf(SHA_A), record(SHA_A)); return getWith(h, { sha256: [SHA_A, SHA_A] }); }],
  ["path traversal in sha256", (h) => getWith(h, { sha256: "../" + SHA_A.slice(3) })],
  ["sha-prefixed label instead of bare hex", (h) => { gh.seed(REPO, pathOf(SHA_A), record(SHA_A)); return getWith(h, { sha256: "sha256:" + SHA_A }); }],
  ["store unreachable is never a yes", async (h) => {
    const orig = global.fetch;
    global.fetch = async () => { throw new Error("network down"); };
    try { return await getWith(h, { sha256: SHA_A }); } finally { global.fetch = orig; }
  }],
  ["store returns a 500", async (h) => {
    const orig = global.fetch;
    global.fetch = async () => ({ status: 500, ok: false, json: async () => ({ message: "boom" }), text: async () => "boom" });
    try { return await getWith(h, { sha256: SHA_A }); } finally { global.fetch = orig; }
  }],
];

for (const [name, run] of CASES) {
  test(`FAILS on bad input: ${name}`, async () => {
    assertNotStamped(await run(stamp.handleStamp), name);
  });
}

// ---------------------------------------------------------------------------
// FORMER ACCEPT-BAD-INPUT FINDINGS (fixed 2026-09-22: record/path cross-check).
// ---------------------------------------------------------------------------

// FINDING S-1: the GET check never cross-checks the stored record's own sha256
// against the fingerprint asked about. Whatever JSON sits at
// stamps/<aa>/<A>.json is returned as ok:true / stamped for A, even when the
// record says it is the stamp for B. r.html (the /r/<sha> page) then prints
// "Stamped. A file with this exact fingerprint is on the public record." and
// shows B's fingerprint. Exactly cosign GHSA-whqx-f9j3-ch6m's class: the entry
// is not cross-referenced against the artifact. Requires write to the stamps
// repo (operator, token leak, or store corruption), not a stranger path.
test("FAILS when the record at A's path is actually the stamp for B",
  async () => {
    gh.seed(REPO, pathOf(SHA_A), record(SHA_B));
    assertNotStamped(await getWith(stamp.handleStamp, { sha256: SHA_A }), "record/path mismatch");
  });

test("FAILS when the record at A's path carries no sha256 at all",
  async () => {
    gh.seed(REPO, pathOf(SHA_A), { size: 1, stamped_at: "2026-09-20T00:00:00.000Z" });
    assertNotStamped(await getWith(stamp.handleStamp, { sha256: SHA_A }), "record without sha256");
  });

test("FAILS when the record at A's path is not a stamp object (array / string)",
  async () => {
    gh.seed(REPO, pathOf(SHA_A), ["not", "a", "stamp"]);
    assertNotStamped(await getWith(stamp.handleStamp, { sha256: SHA_A }), "array record");
  });

// ---------------------------------------------------------------------------
// BREAK ARM
// ---------------------------------------------------------------------------
test("BREAK ARM: every failure case goes RED against a check that always says stamped", async () => {
  const liar = async (req, res) => res.status(200).json({ ok: true, existing: true, stamp: record(SHA_A) });
  const survivors = [];
  for (const [name, run] of CASES) {
    let caught = false;
    try {
      assertNotStamped(await run(liar), name);
    } catch (e) {
      caught = e instanceof assert.AssertionError;
    }
    if (!caught) survivors.push(name);
    restore(); gh = new MockGitHubStore(); restore = install(gh);
  }
  assert.deepEqual(survivors, [], "these cases did NOT catch a lying stamp check");
});
