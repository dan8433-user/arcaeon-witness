// test/verify.test.js — api/verify.js: GET /api/verify (public, unauthenticated).
"use strict";

process.env.GITHUB_PIN_REPO = "test-owner/test-pins";
process.env.GITHUB_PIN_BRANCH = "main";
process.env.GITHUB_PIN_TOKEN = "test-token";

const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const { MockGitHubStore, install } = require("./helpers/mock_store.js");
const { makeReq, makeRes } = require("./helpers/http_mocks.js");
const verifyHandler = require("../api/verify.js");

const PIN_REPO = process.env.GITHUB_PIN_REPO;

let gh;
let restore;

beforeEach(() => {
  gh = new MockGitHubStore();
  restore = install(gh);
});

afterEach(() => {
  restore();
});

test("CONTRACT: an unwitnessed namespace reports witnessed:null (not false) — nothing to decide against", async () => {
  const req = makeReq({ query: { ns: "demo-neverseen", rows: "5", chain: "aaaaaaaa" } });
  const res = makeRes();
  await verifyHandler(req, res);
  assert.equal(res._status, 200);
  assert.equal(res._body.witnessed, null);
  assert.equal(res._body.reason, "no_pin_recorded_for_namespace");
});

test("CONTRACT: matching the current head reports witnessed:true, is_current_head:true", async () => {
  gh.seed(PIN_REPO, "pins/demo-current/latest.json", {
    namespace: "demo-current",
    rows: 42,
    chain: "cafebabe",
    seq: 1,
    pinned_at: new Date().toISOString(),
  });
  const req = makeReq({ query: { ns: "demo-current", rows: "42", chain: "cafebabe" } });
  const res = makeRes();
  await verifyHandler(req, res);
  assert.equal(res._status, 200);
  assert.equal(res._body.witnessed, true);
  assert.equal(res._body.is_current_head, true);
});

test("CONTRACT: rows exceeding the current head is witnessed:null (not-yet, not a refutation) with accepted_head in-band", async () => {
  gh.seed(PIN_REPO, "pins/demo-ahead/latest.json", {
    namespace: "demo-ahead",
    rows: 10,
    chain: "cafebabe",
    seq: 1,
    pinned_at: new Date().toISOString(),
  });
  const req = makeReq({ query: { ns: "demo-ahead", rows: "999", chain: "cafebabe" } });
  const res = makeRes();
  await verifyHandler(req, res);
  assert.equal(res._status, 200);
  assert.equal(res._body.witnessed, null);
  assert.equal(res._body.reason, "exceeds_current_head");
  assert.equal(res._body.accepted_head.rows, 10);
});

test("CONTRACT: a capped history scan is witnessed:null (scan_bound_reached — incomplete check may not assert a negative)", async () => {
  // Head at seq 60; target rows sits deeper than the 50-record scan bound.
  // Every historical record has rows ABOVE the target so the scan never hits
  // the conclusive rows<target early-exit — it must run into the cap.
  // seq padding MUST match api/verify.js seqName() (8 digits). It was 6 here until
  // 2026-08-22, which meant every historical GET missed and this test hit the cap by
  // walking 50 NONEXISTENT files -- scanned===50 was satisfied by a walk over nothing.
  // The reader-side assertion below is what exposed it; no assertion on a
  // handler-authored field could have.
  const ns = "demo-deep";
  gh.seed(PIN_REPO, `pins/${ns}/latest.json`, {
    namespace: ns, rows: 700, chain: "cafebabe", seq: 60,
    pinned_at: new Date().toISOString(),
  });
  for (let s = 59; s >= 1; s--) {
    gh.seed(PIN_REPO, `pins/${ns}/${String(s).padStart(8, "0")}.json`, {
      namespace: ns, rows: 100 + s * 10, chain: "beef" + String(s).padStart(4, "0"), seq: s,
      pinned_at: new Date().toISOString(),
    });
  }
  const req = makeReq({ query: { ns, rows: "105", chain: "aaaaaaaa" } });
  const res = makeRes();
  await verifyHandler(req, res);
  assert.equal(res._status, 200);
  assert.equal(res._body.witnessed, null);
  assert.equal(res._body.reason, "scan_bound_reached");
  // Assert the CAUSE, not just the label. Without this the test only proves the
  // handler emitted the right string -- it could emit it for the wrong reason and
  // still pass. ColonistOne found exactly this in their own suite on 2026-08-22: a
  // row labelled scan_bound_reached that actually tripped exceeds_current_head and
  // had never once exercised the class it was named for. scanned === MAX_HISTORY_SCAN
  // is the evidence that the bound is what stopped the walk.
  assert.equal(res._body.scanned, 50);

  // READER-SIDE BOUND (ColonistOne + Rowan Adeyemi, 2026-08-22). Everything above
  // asserts on fields the HANDLER authors. A handler that halts for an unrelated
  // reason and prints scanned:50 passes all of them, and nothing in the suite
  // dissents. So assert on WHICH records the walk actually touched, recorded by the
  // fixture's own store rather than reported by the code under test.
  //
  // The expected set is computed from the fixture's construction, not from the
  // response: the walk starts at seq-1 (59) and steps down 50 records, so it must
  // ask for 59..10 and must NOT reach 9.
  const asked = gh.getLog.filter((p) => p.startsWith(`pins/${ns}/`) && !p.endsWith("latest.json"));
  const expected = [];
  for (let s = 59; s >= 10; s--) expected.push(`pins/${ns}/${String(s).padStart(8, "0")}.json`);
  assert.deepEqual(asked, expected,
    "the walk must touch exactly seqs 59..10, in order — a handler that stopped for " +
    "another reason cannot produce this sequence whatever count it prints");
  assert.ok(!asked.includes(`pins/${ns}/${String(9).padStart(8, "0")}.json`),
    "seq 9 is past the bound and must never be fetched");

  // PRE-COMMITMENT DIGEST (Rowan Adeyemi's rung, adopted 2026-08-23; boarded as
  // unclaimed on 2026-08-22 rather than quietly absorbed). The assertion above binds
  // to the fixture's store log — test-authored, but still private to this test. This
  // one binds to a digest FIXED IN SOURCE, committed to git before any run: a third
  // party who has never seen this fixture recomputes the expected set from the stated
  // construction rule alone and checks the constant.
  //
  //   rule: for s in 59..10 (descending): `pins/demo-deep/${String(s).padStart(8,"0")}.json`
  //   digest: sha256 over the rule's lines joined with "\n"
  //
  // If the fixture, the handler's walk order, or the padding ever drift, this fails
  // against a number neither the handler nor this test's runtime can retroactively
  // author. (The 6-vs-8 padding defect this suite shipped with would have been caught
  // at commit time by exactly this: the recomputed digest would not have matched the
  // walk the store recorded.)
  const EXPECTED_WALK_SHA256 =
    "8164961645a8ca0a7ee067dfc6dfe6cff613cc635f29975961dc974ff3e0dae7";
  const walkDigest = require("node:crypto")
    .createHash("sha256").update(asked.join("\n"), "utf8").digest("hex");
  assert.equal(walkDigest, EXPECTED_WALK_SHA256,
    "the recorded walk must hash to the digest committed in source before the run");
});

test("CONTRACT: reaching the start of history without a match stays witnessed:false (conclusive)", async () => {
  const ns = "demo-shallow";
  gh.seed(PIN_REPO, `pins/${ns}/latest.json`, {
    namespace: ns, rows: 50, chain: "cafebabe", seq: 3,
    pinned_at: new Date().toISOString(),
  });
  // seqs 1-2 all have rows ABOVE the target (no rows<target early-exit),
  // history exhausts before the bound → conclusive not_found_in_history.
  gh.seed(PIN_REPO, `pins/${ns}/${String(2).padStart(8, "0")}.json`, {
    namespace: ns, rows: 40, chain: "beef0002", seq: 2, pinned_at: new Date().toISOString(),
  });
  gh.seed(PIN_REPO, `pins/${ns}/${String(1).padStart(8, "0")}.json`, {
    namespace: ns, rows: 30, chain: "beef0001", seq: 1, pinned_at: new Date().toISOString(),
  });
  const req = makeReq({ query: { ns, rows: "20", chain: "aaaaaaaa" } });
  const res = makeRes();
  await verifyHandler(req, res);
  assert.equal(res._status, 200);
  assert.equal(res._body.witnessed, false);
  assert.equal(res._body.reason, "not_found_in_history");
});

test("CONTRACT: matching rows but a different chain is a chain-mismatch, not witnessed", async () => {
  gh.seed(PIN_REPO, "pins/demo-mismatch/latest.json", {
    namespace: "demo-mismatch",
    rows: 10,
    chain: "cafebabe",
    seq: 1,
    pinned_at: new Date().toISOString(),
  });
  const req = makeReq({ query: { ns: "demo-mismatch", rows: "10", chain: "deadbeef" } });
  const res = makeRes();
  await verifyHandler(req, res);
  assert.equal(res._status, 200);
  assert.equal(res._body.witnessed, false);
  assert.equal(res._body.reason, "rows_match_chain_mismatch");
});
