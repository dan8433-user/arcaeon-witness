// test/verdict_required.test.js — lib/_verdict.js: the verdict is a REQUIRED
// argument, and a red one never renders green.
//
// The defect class (2026-09-19/20, receipt proxy health endpoint): a wrapper
// ignored a clean ok=false from the verify step and built a well-formed
// success out of DEFAULTS — rows 0, chain "genesis", ok true. These tests are
// about the constructor, not any one endpoint: whatever builds a
// success-shaped answer must throw when handed no verdict, must throw when
// handed a red one, and must reach "empty / brand new" only through an
// explicit verified-empty verdict.
//
// MUST-FAIL ARMS: each block was run red once by putting the defect back in
// lib/_verdict.js (give requireVerdict a default, let success() ignore red,
// let judgeRead treat a damaged document as empty). The red lines are in
// VERDICT_SURVEY.md.

"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const verdict = require("../lib/_verdict.js");

test("NO VERDICT, NO ANSWER: the success constructor throws a named error when no verdict is passed", () => {
  for (const missing of [undefined, null, {}, [], "ok", true, 1, { ok: 1 }, { ok: "true" }, { verified: true }]) {
    assert.throws(
      () => verdict.success(missing, { rows: 0, chain: "genesis" }),
      (e) => e instanceof verdict.VerdictRequiredError && e.code === "verdict_required",
      `success() built an answer from ${JSON.stringify(missing)}`
    );
  }
  // and called with nothing at all
  assert.throws(() => verdict.success(), verdict.VerdictRequiredError);
  assert.throws(() => verdict.requireVerdict(), verdict.VerdictRequiredError);
});

test("NO VERDICT, NO ANSWER: a bare {ok:true} is not a verdict — green has to say WHICH green", () => {
  assert.throws(() => verdict.success({ ok: true }, { witnessed: true }), verdict.VerdictRequiredError);
  assert.throws(() => verdict.success({ ok: true, state: "probably_fine" }, {}), verdict.VerdictRequiredError);
  assert.throws(() => verdict.requireVerdict({ ok: false }), verdict.VerdictRequiredError, "red without a reason");
});

test("RED NEVER RENDERS GREEN: success() throws on a red verdict, and refusal() is a 503 that is not ok", () => {
  const redV = verdict.red("pins/demo/latest.json", "rows_unreadable");
  assert.throws(
    () => verdict.success(redV, { witnessed: true, status: "current" }),
    (e) => e instanceof verdict.RedVerdictError && e.verdict === redV
  );
  const r = verdict.refusal(redV);
  assert.equal(r.status, 503);
  assert.equal(r.body.ok, false);
  assert.equal(r.body.reason, "rows_unreadable");
  assert.ok(!("witnessed" in r.body), "a refusal must not carry a witnessed field at all");
  // and the other direction: a green verdict cannot be turned into a refusal by accident
  assert.throws(() => verdict.refusal(verdict.verifiedRecord("x")), TypeError);
});

test("RED NEVER RENDERS GREEN: the fields cannot smuggle their own ok past the verdict", () => {
  assert.throws(() => verdict.success(verdict.verifiedRecord("x"), { ok: true }), TypeError);
  assert.throws(() => verdict.success(verdict.verifiedRecord("x"), { ok: false }), TypeError);
});

test("GENESIS IS A VERDICT: empty is reached by the store's 404 (null) and by nothing else", () => {
  // the honest case: the store said 404
  const empty = verdict.judgePin(null, { what: "head" });
  assert.equal(empty.ok, true);
  assert.equal(empty.state, verdict.STATES.EMPTY);
  assert.equal(verdict.isEmpty(empty), true);

  // everything that is NOT a 404 and NOT a pin record is red, never empty
  const damaged = [
    { json: {} },
    { json: null },
    { json: "garbage" },
    { json: [] },
    { json: { rows: 0, chain: "genesis" } },              // the original bug's exact payload
    { json: { namespace: "demo", rows: "12", chain: "cafebabe", seq: 1 } },
    { json: { namespace: "demo", rows: 12, chain: "genesis", seq: 1 } },
    { json: { namespace: "demo", rows: 12, chain: "cafebabe" } },
    { json: { namespace: "other", rows: 12, chain: "cafebabe", seq: 1 } },
  ];
  for (const got of damaged) {
    const v = verdict.judgePin(got, { what: "head", namespace: "demo" });
    assert.equal(v.ok, false, `damaged head read as green: ${JSON.stringify(got)}`);
    assert.equal(verdict.isEmpty(v), false, `damaged head read as EMPTY: ${JSON.stringify(got)}`);
  }

  // and a read that never happened is neither: it throws
  assert.throws(() => verdict.judgePin(undefined, { what: "head" }), verdict.VerdictRequiredError);

  const good = verdict.judgePin({ json: { namespace: "demo", rows: 12, chain: "cafebabe", seq: 3 } }, { namespace: "demo" });
  assert.equal(good.ok, true);
  assert.equal(good.state, verdict.STATES.RECORD);
});

test("COUNTERS: 404 is a verified 0, a readable number is that number, and a present-but-unreadable counter THROWS instead of reading as 0", () => {
  assert.equal(verdict.counterValue(verdict.judgeCounter(null, "used")), 0);
  assert.equal(verdict.counterValue(verdict.judgeCounter({ json: { used: 0 } }, "used")), 0);
  assert.equal(verdict.counterValue(verdict.judgeCounter({ json: { used: 97 } }, "used", { integer: true })), 97);
  assert.equal(verdict.counterValue(verdict.judgeCounter({ json: { balance: 2.5 } }, "balance")), 2.5);

  for (const got of [{ json: {} }, { json: { used: "97" } }, { json: { used: null } }, { json: { used: -1 } },
                     { json: { used: NaN } }, { json: [] }, { json: null }]) {
    const v = verdict.judgeCounter(got, "used");
    assert.equal(v.ok, false, `damaged counter read as green: ${JSON.stringify(got)}`);
    assert.throws(() => verdict.counterValue(v), verdict.RedVerdictError);
  }
  assert.equal(verdict.judgeCounter({ json: { used: 1.5 } }, "used", { integer: true }).ok, false);
  assert.throws(() => verdict.judgeCounter(undefined, "used"), verdict.VerdictRequiredError);
  assert.throws(() => verdict.counterValue(undefined), verdict.VerdictRequiredError);
  assert.throws(() => verdict.counterValue({ ok: true, state: verdict.STATES.RECORD }), verdict.VerdictRequiredError);
});

test("LISTINGS: a 200 that is not a listing throws — it does not read as an empty directory", () => {
  assert.deepEqual(verdict.requireListing([], "x"), []);
  for (const body of [undefined, null, {}, { message: "nope" }, "[]"]) {
    assert.throws(() => verdict.requireListing(body, "github LIST pins"), /refusing to read that as empty/);
  }
});

test("THE BOARD'S WORD: overallWord throws rather than fall through to ok", () => {
  process.env.GITHUB_PIN_TOKEN = process.env.GITHUB_PIN_TOKEN || "test-token";
  const { overallWord } = require("../lib/_status_data.js");
  assert.equal(overallWord({ degraded: false, indeterminate: false, overallOk: true }), "ok");
  assert.equal(overallWord({ degraded: true, indeterminate: false, overallOk: false }), "degraded");
  assert.equal(overallWord({ degraded: false, indeterminate: true, overallOk: false }), "indeterminate");
  // the old ternary read every one of these as "ok"
  for (const data of [undefined, null, {}, { degraded: undefined, indeterminate: undefined },
                      { degraded: false, indeterminate: false },
                      { degraded: false, indeterminate: false, overallOk: false },
                      { degraded: 0, indeterminate: 0, overallOk: 1 }]) {
    assert.throws(() => overallWord(data), verdict.VerdictRequiredError, `overallWord(${JSON.stringify(data)}) answered`);
  }
});

test("NO RECORD, NO GRADE: both cadence graders throw when handed no pin, instead of grading absence as 'legacy_no_deadline'", () => {
  process.env.GITHUB_PIN_TOKEN = process.env.GITHUB_PIN_TOKEN || "test-token";
  const store = require("../lib/_store.js");
  const { cadenceStatus } = require("../lib/_status_data.js");
  for (const missing of [undefined, null, "pin", 7, []]) {
    assert.throws(() => store.computeCadenceFields(missing), verdict.VerdictRequiredError);
    assert.throws(() => cadenceStatus(missing), verdict.VerdictRequiredError);
  }
  // the honest legacy case is untouched: a real record that predates the deadline field
  const legacy = { namespace: "demo", rows: 3, chain: "cafebabe", seq: 1, pinned_at: "2026-08-01T00:00:00Z" };
  assert.equal(store.computeCadenceFields(legacy).status, "legacy_no_deadline");
  assert.equal(cadenceStatus(legacy).status, "legacy_no_deadline");
});
