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

// A real, bound green: the only way to get one is a judge over a read.
const GOOD_PIN = { namespace: "demo", rows: 12, chain: "cafebabe", seq: 3 };
function boundGreen() {
  const v = verdict.judgePin({ json: GOOD_PIN }, { what: "x", namespace: "demo" });
  assert.equal(v.ok, true, "fixture: the bound green this test needs did not come out green");
  return v;
}

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
  assert.throws(() => verdict.refusal(boundGreen()), TypeError);
});

test("RED NEVER RENDERS GREEN: the fields cannot smuggle their own ok past the verdict", () => {
  // (until 2026-09-22 these called verdict.verifiedRecord, which is no longer
  // exported: they then threw "not a function", a TypeError, and passed for
  // the wrong reason. The control below makes that impossible to miss again.)
  assert.throws(() => verdict.success(boundGreen(), { ok: true }), /`ok` comes from the verdict/);
  assert.throws(() => verdict.success(boundGreen(), { ok: false }), /`ok` comes from the verdict/);
  assert.deepEqual(verdict.success(boundGreen(), { rows: 12 }), { ok: true, rows: 12 }, "control: a bound green with clean fields must render");
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

// ---------------------------------------------------------------------
// 2026-09-22 — atomic-raven's two points (Colony post 42b8d6e0; our reply,
// comment 43bed67b, said we would make them as he described).
//
// MUST-FAIL ARMS, run red before commit (results in CHANGELOG.md):
//   break A: judgeRead's last line put back to `return null;`  -> the
//            PRESENT_UNCHECKED tests below fail.
//   break B: requireVerdict's binding check removed, so success() accepts
//            any {ok:true, state} -> the UNBOUND GREEN tests below fail.
// ---------------------------------------------------------------------

const PRESENT_OBJECTS = [
  { json: {} },
  { json: { rows: 0, chain: "genesis" } },
  { json: { namespace: "demo", rows: "12", chain: "cafebabe", seq: 1 } },
  { json: GOOD_PIN },                    // even a perfectly good record is UNCHECKED until a shape rule has looked
  { json: { used: 97 } },
];

test("PRESENT_UNCHECKED: judgeRead never returns null — a present object is a typed verdict that is not green", () => {
  for (const got of PRESENT_OBJECTS) {
    const v = verdict.judgeRead(got, "head");
    assert.notEqual(v, null, `judgeRead returned null for ${JSON.stringify(got)}: a raw caller could read that as green`);
    assert.ok(v && typeof v === "object", `judgeRead returned ${v} for ${JSON.stringify(got)}`);
    assert.equal(v.state, verdict.STATES.UNCHECKED);
    assert.equal(v.ok, false, "present_unchecked must not be green");
    assert.equal(typeof v.read_id, "string", "present_unchecked carries the read_id judgeRead issued");
    assert.equal(verdict.isEmpty(v), false, "present is never empty");
  }
  // the other two answers are unchanged: 404 is a bound verified_empty, not-an-object is red
  const empty = verdict.judgeRead(null, "head");
  assert.equal(empty.state, verdict.STATES.EMPTY);
  assert.equal(typeof empty.read_id, "string");
  for (const got of [{ json: null }, { json: [] }, { json: "x" }, "x", []]) {
    const v = verdict.judgeRead(got, "head");
    assert.equal(v.ok, false);
    assert.equal(v.reason, "not_a_json_object");
  }
  assert.throws(() => verdict.judgeRead(undefined, "head"), verdict.VerdictRequiredError);
});

test("PRESENT_UNCHECKED: requireGreen, success and counterValue refuse it BY NAME", () => {
  for (const got of PRESENT_OBJECTS) {
    const v = verdict.judgeRead(got, "head");
    const named = (e) => e instanceof verdict.PresentUncheckedError && e.code === "present_unchecked";
    assert.throws(() => verdict.requireGreen(v, "t"), named);
    assert.throws(() => verdict.success(v, { witnessed: true }), named);
    assert.throws(() => verdict.counterValue(v, "t"), named);
  }
  // the raw caller atomic-raven described: "no verdict back means go on".
  // Under the old null it built a success; now there is no null to fall past,
  // and handing the verdict on is refused.
  const rawCaller = (got) => {
    const v = verdict.judgeRead(got, "head");
    if (!v) return { ok: true, rows: 0, chain: "genesis" }; // the disarm
    return verdict.success(v, { rows: got.json.rows });
  };
  assert.throws(() => rawCaller({ json: { rows: 0, chain: "genesis" } }), verdict.PresentUncheckedError);
});

test("PRESENT_UNCHECKED: judgePin and judgeCounter consume it and return verifiedRecord / red exactly as before", () => {
  const good = verdict.judgePin({ json: GOOD_PIN }, { namespace: "demo" });
  assert.equal(good.ok, true);
  assert.equal(good.state, verdict.STATES.RECORD);
  assert.equal(typeof good.read_id, "string");
  assert.equal(verdict.success(good, { rows: 12 }).ok, true);
  const bad = verdict.judgePin({ json: { ...GOOD_PIN, rows: "12" } }, { namespace: "demo" });
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, "rows_unreadable");
  assert.notEqual(bad.state, verdict.STATES.UNCHECKED, "a judge must not hand present_unchecked back out");

  const c = verdict.judgeCounter({ json: { used: 4 } }, "used", { integer: true });
  assert.equal(c.state, verdict.STATES.RECORD);
  assert.equal(verdict.counterValue(c), 4);
  const e = verdict.judgeCounter(null, "used");
  assert.equal(e.state, verdict.STATES.EMPTY);
  assert.equal(verdict.counterValue(e), 0);

  // a shape rule that decides nothing is a thrown error, never a pass
  for (const undecided of [undefined, null, false, 0, "", { ok: true }, { state: "verified_record" }, { read_id: "read-1" }]) {
    assert.throws(() => verdict.judgeWith({ json: {} }, "x", () => undecided), verdict.VerdictRequiredError,
      `judgeWith treated ${JSON.stringify(undecided)} as a decision`);
  }
});

test("UNBOUND GREEN: success() refuses every green that did not come out of a judge over an issued read", () => {
  const real = boundGreen();
  const forged = [
    { ok: true, state: verdict.STATES.RECORD },                               // hand-built, no read_id
    { ok: true, state: verdict.STATES.EMPTY },
    { ok: true, state: verdict.STATES.RECORD, what: "x", read_id: "read-zzzzzz" }, // read_id judgeRead never issued
    { ok: true, state: verdict.STATES.RECORD, what: "x", read_id: real.read_id },  // a REAL read_id copied onto a literal
    { ...real },                                                               // a spread copy of a real green
    Object.freeze({ ...real }),                                                // ...frozen, same fields
    Object.freeze({ ok: true, state: verdict.STATES.RECORD, what: "x", read_id: "" }),
  ];
  for (const v of forged) {
    assert.throws(
      () => verdict.success(v, { witnessed: true }),
      (e) => e instanceof verdict.UnboundVerdictError && e.code === "verdict_unbound",
      `success() minted an answer from an unbound verdict ${JSON.stringify(v)}`
    );
    assert.throws(() => verdict.requireGreen(v), verdict.UnboundVerdictError);
    assert.throws(() => verdict.isEmpty(v), verdict.UnboundVerdictError);
  }
  // present_unchecked is bound too: a hand-built one is refused as unbound, not trusted
  assert.throws(() => verdict.requireVerdict({ ok: false, state: verdict.STATES.UNCHECKED, reason: "present_unchecked", what: "x" }),
    verdict.UnboundVerdictError);
  // the green constructors are not reachable from outside
  assert.equal(verdict.verifiedRecord, undefined, "verifiedRecord is exported again: a green can be built without a read");
  assert.equal(verdict.verifiedEmpty, undefined, "verifiedEmpty is exported again: a green can be built without a read");
  // control: the real one still renders
  assert.deepEqual(verdict.success(real, { rows: 12 }), { ok: true, rows: 12 });
});

// ---- rule 6: a verdict gates only the record it was judged from ----

test("RULE 6 / WHAT BINDING: a green judged from one record cannot gate an answer about another when the caller names its record", () => {
  const pin = (seq) => ({ json: { namespace: "demo", rows: 10, chain: "deadbeef", seq }, sha: "s" });
  const head = verdict.judgePin(pin(3), { what: "pins/demo/latest.json", namespace: "demo" });
  const older = verdict.judgePin(pin(2), { what: "pins/demo/00000002.json", namespace: "demo" });
  assert.equal(head.ok, true);
  assert.equal(older.ok, true);

  // the head's green offered as the gate for an answer about the older record
  for (const fn of [
    () => verdict.success(head, { witnessed: true }, "verify", { what: "pins/demo/00000002.json" }),
    () => verdict.requireGreen(head, "verify", { what: "pins/demo/00000002.json" }),
    () => verdict.requireVerdict(head, "verify", { what: "pins/demo/00000002.json" }),
    () => verdict.isEmpty(head, "verify", { what: "pins/demo/00000002.json" }),
  ]) {
    assert.throws(fn, (err) => err instanceof verdict.VerdictMismatchError && err.code === "verdict_what_mismatch");
  }
  // a red about another record cannot be served as this record's refusal either
  const otherRed = verdict.judgePin({ json: null, sha: "s" }, { what: "pins/other/latest.json" });
  assert.throws(() => verdict.refusal(otherRed, "latest", { what: "pins/demo/latest.json" }), verdict.VerdictMismatchError);
  // a counter's value comes out only under its own name
  const bal = verdict.judgeCounter({ json: { balance: 4 }, sha: "s" }, "balance", { what: "credit balance" });
  assert.throws(() => verdict.counterValue(bal, "meter", { what: "monthly usage counter" }), verdict.VerdictMismatchError);
  assert.equal(verdict.counterValue(bal, "balance", { what: "credit balance" }), 4);

  // a malformed expectation is a programming error, not a pass
  assert.throws(() => verdict.requireGreen(head, "verify", { what: "" }), TypeError);
  assert.throws(() => verdict.requireGreen(head, "verify", "pins/demo/latest.json"), TypeError);

  // controls: each green renders under its own name, and with no expectation (opt-in)
  assert.deepEqual(verdict.success(head, { a: 1 }, "verify", { what: "pins/demo/latest.json" }), { ok: true, a: 1 });
  assert.deepEqual(verdict.success(older, { a: 1 }, "verify", { what: "pins/demo/00000002.json" }), { ok: true, a: 1 });
  assert.deepEqual(verdict.success(head, { a: 1 }, "verify"), { ok: true, a: 1 });
});
