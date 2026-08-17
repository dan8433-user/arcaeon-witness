// test/verify_read_surface.test.js — api/verify.js: the read-surface
// additions (GET-only CORS + per-IP rate limit) layered onto the existing
// contract in test/verify.test.js. Kept in its own file rather than added to
// verify.test.js so the two can be worked on independently without either
// touching the other's edits.
"use strict";

process.env.GITHUB_PIN_REPO = "test-owner/test-pins";
process.env.GITHUB_PIN_BRANCH = "main";
process.env.GITHUB_PIN_TOKEN = "test-token";

const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const { MockGitHubStore, install } = require("./helpers/mock_store.js");
const { makeReq, makeRes } = require("./helpers/http_mocks.js");
const ratelimit = require("../lib/_ratelimit.js");
const verifyHandler = require("../api/verify.js");

const PIN_REPO = process.env.GITHUB_PIN_REPO;

let gh;
let restore;
let ipCounter = 90000; // high range, disjoint from other files' fixture IPs

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

test("CONTRACT: OPTIONS preflight answers 204 with CORS headers and never touches the store", async () => {
  const req = makeReq({ method: "OPTIONS", headers: { "x-forwarded-for": freshIp() } });
  const res = makeRes();
  await verifyHandler(req, res);
  assert.equal(res._status, 204);
  assert.equal(res._headers["access-control-allow-origin"], "*");
  assert.equal(res._headers["access-control-allow-methods"], "GET, HEAD, OPTIONS");
  assert.equal(res._ended, true);
  assert.equal(res._sent === true || res._body === undefined, true, "OPTIONS must not carry a JSON body");
});

test("CONTRACT: a normal GET carries Access-Control-Allow-Origin:* on top of its existing contract", async () => {
  gh.seed(PIN_REPO, "pins/demo-cors/latest.json", {
    namespace: "demo-cors", rows: 3, chain: "aaaaaaaa", seq: 1, pinned_at: new Date().toISOString(),
  });
  const req = makeReq({ method: "GET", headers: { "x-forwarded-for": freshIp() }, query: { ns: "demo-cors", rows: "3", chain: "aaaaaaaa" } });
  const res = makeRes();
  await verifyHandler(req, res);
  assert.equal(res._status, 200);
  assert.equal(res._body.witnessed, true);
  assert.equal(res._headers["access-control-allow-origin"], "*");
});

test("CONTRACT: a 405 (unsupported method) still carries the ACAO header, and lists OPTIONS in Allow", async () => {
  const req = makeReq({ method: "DELETE", headers: { "x-forwarded-for": freshIp() }, query: { ns: "x", rows: "1", chain: "aaaaaaaa" } });
  const res = makeRes();
  await verifyHandler(req, res);
  assert.equal(res._status, 405);
  assert.equal(res._headers["allow"], "GET, HEAD, OPTIONS");
  assert.equal(res._headers["access-control-allow-origin"], "*");
});

test("REGRESSION: the (LIMIT+1)th GET from one IP is rejected 429 with an honest body and Retry-After, while a different IP is unaffected", async () => {
  gh.seed(PIN_REPO, "pins/demo-rl/latest.json", {
    namespace: "demo-rl", rows: 1, chain: "aaaaaaaa", seq: 1, pinned_at: new Date().toISOString(),
  });
  const hotIp = freshIp();
  const q = { ns: "demo-rl", rows: "1", chain: "aaaaaaaa" };

  let last;
  for (let i = 0; i < ratelimit.LIMIT; i++) {
    const res = makeRes();
    await verifyHandler(makeReq({ headers: { "x-forwarded-for": hotIp }, query: q }), res);
    assert.equal(res._status, 200, `call ${i + 1} of ${ratelimit.LIMIT} should still succeed`);
    last = res;
  }

  const blockedRes = makeRes();
  await verifyHandler(makeReq({ headers: { "x-forwarded-for": hotIp }, query: q }), blockedRes);
  assert.equal(blockedRes._status, 429);
  assert.equal(blockedRes._body.ok, false);
  assert.match(blockedRes._body.note, /per-instance/i);
  assert.ok(Number(blockedRes._headers["retry-after"]) > 0, "Retry-After header must be a positive number of seconds");

  const otherIp = freshIp();
  const okRes = makeRes();
  await verifyHandler(makeReq({ headers: { "x-forwarded-for": otherIp }, query: q }), okRes);
  assert.equal(okRes._status, 200, "a different IP's own budget must be untouched by the hot IP's usage");
});
