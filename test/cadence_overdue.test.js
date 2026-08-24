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


// ---------------------------------------------------------------------------
// THE ZERO FLOOR on the public status board (pre-invite audit, 2026-08-23).
//
// A store holding NOTHING rendered overallOk:true and a green badge reading
// "ok · 0 ns · 0 overdue" — with no namespaces there are no errors, nothing
// overdue and nothing ungradeable, so every failure counter was zero and zero
// read as health. That is "0 found" and "0 looked at" printing identically, on
// the board whose entire job is saying whether the watched thing is fine.
//
// Same missing floor as the mutation harness's MIN_CASES, one surface over.
// ---------------------------------------------------------------------------

const statusData = require("../lib/_status_data.js");
const realStore = require("../lib/_store.js");

// A FRESH anchor, so anchor freshness cannot be what makes the verdict
// indeterminate. The first version of this test stubbed the anchors away too,
// which left anchorStatus="cannot_determine" carrying `indeterminate` by
// itself — the test passed with the zero-floor REMOVED. Green by construction,
// in the test written to catch green by construction. The mutation check is
// the only reason I know that.
function stubStore(realStore, { namespaces = [], pin = null } = {}) {
  const saved = {
    repoReachable: realStore.repoReachable,
    listDir: realStore.listDir,
    getFile: realStore.getFile,
    getRawFile: realStore.getRawFile,
    getTree: realStore.getTree,
  };
  const today = new Date().toISOString().slice(0, 10);
  const headName = `${today}-head.txt`;
  realStore.repoReachable = async () => true;
  realStore.listDir = async (dir) => {
    if (dir === "anchors") {
      return [{ type: "file", name: headName },
              { type: "file", name: `${headName}.ots` }];
    }
    return namespaces.map((n) => ({ type: "dir", name: n }));
  };
  realStore.getRawFile = async () => ({ text: `deadbeef ${new Date().toISOString()}` });
  realStore.getFile = async (path) =>
    (pin && path.endsWith("latest.json")) ? { json: pin } : null;
  realStore.getTree = async () => [];
  return () => Object.assign(realStore, saved);
}

test("an EMPTY but REACHABLE pin store, with a FRESH anchor, is indeterminate not OK", async () => {
  const restore = stubStore(realStore);
  try {
    const d = await statusData.gatherStatusData();
    assert.equal(d.reachable, true, "precondition: the store must be UP");
    assert.equal(d.anchorStatus, "current",
      "precondition: anchor freshness must NOT be what drives the verdict");
    assert.equal(d.nothingWatched, true);
    assert.equal(d.degraded, false,
      "an empty store is not a FAILURE — three states, not two");
    assert.equal(d.indeterminate, true,
      "no evidence either way is exactly what indeterminate is for");
    assert.equal(d.overallOk, false,
      "a watcher watching nothing reported itself OK");
  } finally {
    restore();
  }
});

test("GREEN CONTROL: a store with one healthy namespace reports OK", async () => {
  // Without this the floor could force indeterminate ALWAYS and the test above
  // would still pass.
  const future = new Date(Date.now() + 86400 * 1000).toISOString();
  const restore = stubStore(realStore, {
    namespaces: ["acme-prod"],
    pin: { namespace: "acme-prod", rows: 5, chain: "c".repeat(32),
           pinned_at: new Date().toISOString(), seq: 5, next_pin_due_by: future },
  });
  try {
    const d = await statusData.gatherStatusData();
    assert.equal(d.nothingWatched, false);
    assert.equal(d.overdueCount, 0);
    assert.equal(d.degraded, false);
    assert.equal(d.indeterminate, false);
    assert.equal(d.overallOk, true, "a healthy watched namespace must read OK");
  } finally {
    restore();
  }
});
