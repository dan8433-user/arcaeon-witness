// test/ratelimit_buckets.test.js — lib/_ratelimit.js named buckets
// (2026-09-27, registration release gate item 3): register-status draws from
// "status" (30 per 10 min), register from "register", confirm from "confirm",
// and verify/status/health/badge/latest keep the shared "read" bucket. An
// agent polling status from one address cannot lock its human out of confirm.
"use strict";

process.env.GITHUB_USAGE_REPO = "test-owner/test-usage";
process.env.GITHUB_PIN_REPO = "test-owner/test-pins";
process.env.GITHUB_PIN_BRANCH = "main";
process.env.GITHUB_PIN_TOKEN = "test-token";
process.env.REGISTER_IP_SALT = "test-salt-not-a-secret";
delete process.env.RESEND_API_KEY;
delete process.env.RESEND_FROM;
delete process.env.WITNESS_KEYS;
delete process.env.WITNESS_PLANS;

const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const { MockGitHubStore, install } = require("./helpers/mock_store.js");
const { makeReq, makeRes } = require("./helpers/http_mocks.js");
const ratelimit = require("../lib/_ratelimit.js");
const store = require("../lib/_store.js");
const register = require("../lib/_register.js");
const fulfill = require("../api/fulfill.js");

let gh, restore, sent;
const realPutSleep = store._putRetry.sleep;
const realRetrySleep = register._timing.retrySleep;
const realFloorSleep = register._timing.floorSleep;

beforeEach(() => {
  gh = new MockGitHubStore();
  restore = install(gh);
  sent = [];
  store._putRetry.sleep = async () => {};
  register._timing.retrySleep = async () => {};
  register._timing.floorSleep = async () => {};
  register._timing.reset();
  register.setSender({ send: async (m) => { sent.push(m); return { ok: true }; }, probe: async () => ({ ok: true }) });
});

afterEach(() => {
  restore();
  store._putRetry.sleep = realPutSleep;
  register._timing.retrySleep = realRetrySleep;
  register._timing.floorSleep = realFloorSleep;
  register.setSender(null);
});

const ipReq = (ip) => ({ headers: { "x-forwarded-for": ip } });

async function call(req) {
  const res = makeRes();
  await fulfill(req, res);
  return res;
}

test("buckets: the default is \"read\" and a named bucket is an independent budget", () => {
  assert.equal(ratelimit.DEFAULT_BUCKET, "read");
  assert.equal(ratelimit.BUCKET_LIMITS.status, 30);
  const ip = "203.0.113.201";
  for (let i = 0; i < ratelimit.LIMIT; i++) assert.equal(ratelimit.check(ipReq(ip)).limited, false);
  assert.equal(ratelimit.check(ipReq(ip)).limited, true, "read is spent");
  assert.equal(ratelimit.check(ipReq(ip), 1, "read").limited, true, "naming read is the same budget");
  for (const b of ["status", "register", "confirm"]) {
    assert.equal(ratelimit.check(ipReq(ip), 1, b).limited, false, `${b} is untouched by read`);
  }
});

test("buckets: status allows 30 per window and the 31st is limited, naming its bucket", () => {
  const ip = "203.0.113.202";
  for (let i = 0; i < 30; i++) assert.equal(ratelimit.check(ipReq(ip), 1, "status").limited, false, `poll ${i + 1}`);
  const r = ratelimit.check(ipReq(ip), 1, "status");
  assert.equal(r.limited, true);
  assert.equal(r.limit, 30);
  assert.equal(r.bucket, "status");
  assert.equal(ratelimit.check(ipReq(ip)).limited, false, "status polls did not spend read");
});

test("REGISTER: 31 register-status polls from one address do not 429 a following confirm from that address", async () => {
  const ip = "203.0.113.203";
  const email = "poller@example.com";
  const eh = register.sha256(register.normaliseEmail(email).normalised);

  const r = await call(makeReq({
    method: "POST",
    headers: { "x-forwarded-for": ip, accept: "application/json" },
    body: { email },
    query: { op: "register" },
  }));
  assert.equal(r._status, 200, JSON.stringify(r._body));
  const m = /[?&]t=([0-9a-f]{64})/.exec(sent[0].text);
  assert.ok(m, "the mail carries a confirm link");

  const statuses = [];
  for (let i = 0; i < 31; i++) {
    const s = await call(makeReq({ method: "GET", headers: { "x-forwarded-for": ip }, query: { op: "register-status", eh } }));
    statuses.push(s._status);
  }
  assert.ok(statuses.slice(0, 30).every((s) => s !== 429), `the first 30 polls pass: ${statuses.join(",")}`);
  assert.equal(statuses[30], 429, "the 31st poll is limited in its own bucket");

  const c = await call(makeReq({
    method: "POST",
    headers: { "x-forwarded-for": ip, accept: "application/json" },
    query: { op: "confirm" },
    body: { t: m[1] },
  }));
  assert.notEqual(c._status, 429, "confirm is not locked out by the polling");
  assert.equal(c._status, 200, JSON.stringify(c._body));

  // And the shared read bucket the public read endpoints use is untouched.
  assert.equal(ratelimit.check(ipReq(ip)).limited, false);
});
