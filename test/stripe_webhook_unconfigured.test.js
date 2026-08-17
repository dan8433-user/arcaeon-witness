// test/stripe_webhook_unconfigured.test.js — the fail-closed path when
// WITNESS_STRIPE_WEBHOOK_SECRET is not set. Isolated in its own file/process
// (node --test spawns one process per test file) so it never fights the
// signed-secret env var the rest of test/stripe_webhook.test.js depends on.
"use strict";

delete process.env.WITNESS_STRIPE_WEBHOOK_SECRET;

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { makeRawReq, makeRes } = require("./helpers/http_mocks.js");
const webhook = require("../api/stripe-webhook.js");

test("CONTRACT: with no WITNESS_STRIPE_WEBHOOK_SECRET configured, the webhook fails closed with 501 (not silently 200)", async () => {
  const rawBody = Buffer.from(JSON.stringify({ type: "checkout.session.completed" }), "utf8");
  const req = makeRawReq({ headers: { "stripe-signature": "t=1,v1=deadbeef" }, rawBody });
  const res = makeRes();
  await webhook(req, res);
  assert.equal(res._status, 501);
  assert.ok(res._body.human_step, "the 501 must name the concrete human step owed, not just say 'not configured'");
});

test("CONTRACT: only POST is accepted", async () => {
  const req = makeRawReq({ method: "GET", headers: {}, rawBody: Buffer.alloc(0) });
  const res = makeRes();
  await webhook(req, res);
  assert.equal(res._status, 405);
});
