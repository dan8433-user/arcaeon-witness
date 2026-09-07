// test/free_endpoints_ratelimit.test.js — api/latest.js, api/health.js,
// api/status.js, api/badge.js: the per-IP rate limit added 2026-09-05.
//
// WHY THIS EXISTS. A pre-invite audit found four unauthenticated, unlimited
// read endpoints — api/latest.js, api/health.js, api/status.js (and its
// /api/status.json twin), api/badge.js — sharing GITHUB_PIN_TOKEN with every
// paying customer's /api/pin write. GitHub's contents API rate limit
// (~5000 authed requests/hour, per README) is a budget the WHOLE service
// draws from, not a per-endpoint one, and api/status.js alone fans out into
// several GitHub reads per hit (a directory listing per namespace, a full
// recursive tree, an anchors/ listing). A stranger hammering any of these
// four could exhaust that shared budget and start 502ing the money path
// without ever touching a key. api/verify.js already had this protection
// (test/verify_read_surface.test.js); this file proves the same fix landed
// on its siblings, using the identical pattern.
"use strict";

process.env.GITHUB_PIN_REPO = "test-owner/test-pins";
process.env.GITHUB_PIN_BRANCH = "main";
process.env.GITHUB_PIN_TOKEN = "test-token";

const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const { MockGitHubStore, install } = require("./helpers/mock_store.js");
const { makeReq, makeRes } = require("./helpers/http_mocks.js");
const ratelimit = require("../lib/_ratelimit.js");
const latestHandler = require("../api/latest.js");
const healthHandler = require("../api/health.js");
const statusHandler = require("../api/status.js");
const badgeHandler = require("../api/badge.js");

const PIN_REPO = process.env.GITHUB_PIN_REPO;

let gh;
let restore;
let ipCounter = 70000; // high range, disjoint from other files' fixture IPs

beforeEach(() => {
  gh = new MockGitHubStore();
  restore = install(gh);
});

afterEach(() => {
  restore();
});

function freshIp() {
  ipCounter += 1;
  return `203.0.113.${ipCounter % 254 || 1}`;
}

// Drives `handler` LIMIT times from one IP (expecting each to succeed) then
// once more (expecting 429), then confirms a different IP is unaffected.
async function assertRateLimited(handler, { query = {}, seed } = {}) {
  if (seed) seed();
  const hotIp = freshIp();

  for (let i = 0; i < ratelimit.LIMIT; i++) {
    const res = makeRes();
    await handler(makeReq({ headers: { "x-forwarded-for": hotIp }, query }), res);
    assert.notEqual(res._status, 429, `call ${i + 1} of ${ratelimit.LIMIT} must not be rate limited yet`);
  }

  const blockedRes = makeRes();
  await handler(makeReq({ headers: { "x-forwarded-for": hotIp }, query }), blockedRes);
  assert.equal(blockedRes._status, 429, "the (LIMIT+1)th call from one IP must be rejected");
  assert.ok(Number(blockedRes._headers["retry-after"]) > 0, "Retry-After header must be a positive number of seconds");

  const otherIp = freshIp();
  const okRes = makeRes();
  await handler(makeReq({ headers: { "x-forwarded-for": otherIp }, query }), okRes);
  assert.notEqual(okRes._status, 429, "a different IP's own budget must be untouched by the hot IP's usage");
}

test("REGRESSION (2026-09-05): GET /api/latest is rate limited per IP (was unlimited)", async () => {
  await assertRateLimited(latestHandler, {
    query: { ns: "demo-rl-latest" },
    seed: () => gh.seed(PIN_REPO, "pins/demo-rl-latest/latest.json", {
      namespace: "demo-rl-latest", rows: 1, chain: "aaaaaaaa", seq: 1, pinned_at: new Date().toISOString(),
    }),
  });
});

test("REGRESSION (2026-09-05): GET /api/health is rate limited per IP (was unlimited)", async () => {
  await assertRateLimited(healthHandler);
});

test("REGRESSION (2026-09-05): GET /status is rate limited per IP (was unlimited) — covers /api/status.json too, same handler", async () => {
  await assertRateLimited(statusHandler);
});

test("REGRESSION (2026-09-05): the rate limit on /status ALSO gates the ?format=json rewrite target, not just the HTML page", async () => {
  const hotIp = freshIp();
  for (let i = 0; i < ratelimit.LIMIT; i++) {
    await statusHandler(makeReq({ headers: { "x-forwarded-for": hotIp } }), makeRes());
  }
  const res = makeRes();
  await statusHandler(makeReq({ headers: { "x-forwarded-for": hotIp }, query: { format: "json" } }), res);
  assert.equal(res._status, 429, "the same IP budget must be shared between /status and its ?format=json twin");
});

test("REGRESSION (2026-09-05): GET /api/badge is rate limited per IP (was unlimited), and answers in shields.io shape even when limited", async () => {
  await assertRateLimited(badgeHandler);

  const hotIp = freshIp();
  for (let i = 0; i <= ratelimit.LIMIT; i++) {
    var last = makeRes();
    await badgeHandler(makeReq({ headers: { "x-forwarded-for": hotIp } }), last);
  }
  assert.equal(last._status, 429);
  // A shields.io endpoint badge consumer expects this shape unconditionally —
  // an ad-hoc error body would render as a broken badge image, not a message.
  assert.equal(last._body.schemaVersion, 1);
  assert.equal(typeof last._body.message, "string");
  assert.equal(typeof last._body.color, "string");
});
