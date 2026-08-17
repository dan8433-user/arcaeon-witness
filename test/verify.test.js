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

test("CONTRACT: an unwitnessed namespace reports witnessed:false, reason no_pin_recorded_for_namespace", async () => {
  const req = makeReq({ query: { ns: "demo-neverseen", rows: "5", chain: "aaaaaaaa" } });
  const res = makeRes();
  await verifyHandler(req, res);
  assert.equal(res._status, 200);
  assert.equal(res._body.witnessed, false);
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

test("CONTRACT: rows exceeding the current head cannot have been witnessed yet", async () => {
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
  assert.equal(res._body.witnessed, false);
  assert.equal(res._body.reason, "exceeds_current_head");
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
