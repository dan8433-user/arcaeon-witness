// test/meter.test.js — api/_meter.js: the free-tier monthly cap.
"use strict";

process.env.GITHUB_USAGE_REPO = "test-owner/test-usage";
process.env.GITHUB_PIN_TOKEN = "test-token";
delete process.env.WITNESS_PLANS;

const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const { MockGitHubStore, install } = require("./helpers/mock_store.js");
const meter = require("../api/_meter.js");

let store;
let restore;

beforeEach(() => {
  store = new MockGitHubStore();
  restore = install(store);
});

afterEach(() => {
  restore();
});

test("CONTRACT: a free-plan key is allowed up to its cap, then denied over_cap", async () => {
  process.env.WITNESS_PLANS = JSON.stringify({
    [meter.keyHash("cap-test-key")]: { plan: "free", monthly_cap: 3 },
  });
  try {
    for (let i = 1; i <= 3; i++) {
      const r = await meter.check("cap-test-key");
      assert.equal(r.ok, true, `check #${i} should be allowed`);
      assert.equal(r.used, i);
    }
    const denied = await meter.check("cap-test-key");
    assert.equal(denied.ok, false);
    assert.equal(denied.reason, "over_cap");
    assert.equal(denied.used, 3);
    assert.equal(denied.cap, 3);
  } finally {
    delete process.env.WITNESS_PLANS;
  }
});

test("CONTRACT: an explicit unlimited plan (monthly_cap:null) is still counted but never denies", async () => {
  process.env.WITNESS_PLANS = JSON.stringify({
    [meter.keyHash("unlimited-key")]: { plan: "internal", monthly_cap: null },
  });
  try {
    for (let i = 1; i <= 5; i++) {
      const r = await meter.check("unlimited-key");
      assert.equal(r.ok, true);
      assert.equal(r.used, i);
      assert.equal(r.cap, null);
    }
  } finally {
    delete process.env.WITNESS_PLANS;
  }
});

test("CONTRACT: peek() is non-mutating (checking your own usage must never itself cost usage)", async () => {
  await meter.check("peek-test-key");
  const before = await meter.peek("peek-test-key");
  assert.equal(before.used, 1);
  await meter.peek("peek-test-key");
  await meter.peek("peek-test-key");
  const after = await meter.peek("peek-test-key");
  assert.equal(after.used, 1, "peek must never increment usage");
});
