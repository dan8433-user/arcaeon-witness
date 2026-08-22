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
  const ns = "demo-deep";
  gh.seed(PIN_REPO, `pins/${ns}/latest.json`, {
    namespace: ns, rows: 700, chain: "cafebabe", seq: 60,
    pinned_at: new Date().toISOString(),
  });
  for (let s = 59; s >= 1; s--) {
    gh.seed(PIN_REPO, `pins/${ns}/${String(s).padStart(6, "0")}.json`, {
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
});

test("CONTRACT: reaching the start of history without a match stays witnessed:false (conclusive)", async () => {
  const ns = "demo-shallow";
  gh.seed(PIN_REPO, `pins/${ns}/latest.json`, {
    namespace: ns, rows: 50, chain: "cafebabe", seq: 3,
    pinned_at: new Date().toISOString(),
  });
  // seqs 1-2 all have rows ABOVE the target (no rows<target early-exit),
  // history exhausts before the bound → conclusive not_found_in_history.
  gh.seed(PIN_REPO, `pins/${ns}/000002.json`, {
    namespace: ns, rows: 40, chain: "beef0002", seq: 2, pinned_at: new Date().toISOString(),
  });
  gh.seed(PIN_REPO, `pins/${ns}/000001.json`, {
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
