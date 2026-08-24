// test/cadence_overdue.test.js — the overdue alarm, observed firing.
//
// WHY THIS EXISTS. A pre-invite adversarial audit (2026-08-23) found that
// `cadence_status = "overdue"` had NEVER executed in any test: the string
// "overdue" appeared zero times in the whole test directory, and hardcoding
// the branch to "pass" left all 106 tests green.
//
// That alarm IS the product. The witness's entire cadence value proposition is
// telling you a namespace missed the pin schedule it promised. An alarm nobody
// has ever watched go off is a decoration, and this repo's own doctrine says a
// green that has never been observed failing is worth nothing. It applied to
// everything except the alarm.
//
// `computeCadenceFields(pin, now)` takes an injectable clock precisely so this
// is testable. It always was. Nobody used it.
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const store = require("../lib/_store.js");

const DUE = "2026-08-20T12:00:00.000Z";
const DUE_MS = Date.parse(DUE);

function pin(extra = {}) {
  return { namespace: "acme-prod", rows: 10, chain: "a".repeat(32),
           next_pin_due_by: DUE, ...extra };
}

// ---------------------------------------------------------------------------
// THE RED: the alarm fires.
// ---------------------------------------------------------------------------

test("a pin past its declared deadline grades OVERDUE", () => {
  const out = store.computeCadenceFields(pin(), DUE_MS + 3600 * 1000);
  assert.equal(out.cadence_status, "overdue");
  assert.equal(out.status, "overdue");
  assert.equal(out.cadence_gradeable, true);
  assert.equal(out.overdue_by_seconds, 3600);
});

test("overdue_by_seconds grows with the lateness, so the number means something", () => {
  const oneDay = store.computeCadenceFields(pin(), DUE_MS + 86400 * 1000);
  const twoDay = store.computeCadenceFields(pin(), DUE_MS + 2 * 86400 * 1000);
  assert.equal(oneDay.overdue_by_seconds, 86400);
  assert.equal(twoDay.overdue_by_seconds, 172800);
  assert.ok(twoDay.overdue_by_seconds > oneDay.overdue_by_seconds);
});

test("overdue outranks a publisher heartbeat: a heartbeat does not excuse a missed deadline", () => {
  const out = store.computeCadenceFields(
    pin({ record_kind: "publisher_heartbeat" }), DUE_MS + 60 * 1000);
  assert.equal(out.cadence_status, "overdue");
  assert.equal(out.status, "overdue",
    "a heartbeat pin past its deadline must still read overdue, or a publisher " +
    "can hold the alarm off forever by heartbeating");
});

// ---------------------------------------------------------------------------
// THE GREEN CONTROLS: without these the alarm could read "overdue" always and
// still pass every test above — the same green-by-construction trap the audit
// found in the mutation harness.
// ---------------------------------------------------------------------------

test("a pin inside its window grades CURRENT, not overdue", () => {
  const out = store.computeCadenceFields(pin(), DUE_MS - 3600 * 1000);
  assert.equal(out.cadence_status, "current");
  assert.equal(out.status, "current");
  assert.equal(out.overdue_by_seconds, undefined);
});

test("a pin with no declared deadline is LEGACY, neither current nor overdue", () => {
  const out = store.computeCadenceFields(
    { namespace: "acme-prod", rows: 1, chain: "b".repeat(32) }, DUE_MS);
  assert.equal(out.cadence_gradeable, false);
  assert.equal(out.cadence_status, "legacy_no_deadline");
  assert.equal(out.status, "legacy_no_deadline");
});

test("an unparseable deadline is legacy, not silently current", () => {
  const out = store.computeCadenceFields(pin({ next_pin_due_by: "not-a-date" }), DUE_MS);
  assert.equal(out.cadence_gradeable, false);
  assert.equal(out.cadence_status, "legacy_no_deadline");
  assert.notEqual(out.status, "current",
    "a deadline we cannot read must never render as inside the window");
});

// ---------------------------------------------------------------------------
// The boundary, stated once so it cannot drift silently.
// ---------------------------------------------------------------------------

test("the deadline instant itself counts as overdue (>=, not >)", () => {
  const out = store.computeCadenceFields(pin(), DUE_MS);
  assert.equal(out.cadence_status, "overdue");
  assert.equal(out.overdue_by_seconds, 0);
});
