// test/retired_namespaces.test.js — WITNESS_RETIRED_NS end to end, through
// the real status computation (lib/_status_data.js's loadRetiredNamespaces()
// + lib/_status_json.js's summary shaping), board item S-arcaeon-10c.
//
// WHY THIS EXISTS. The 2026-08-30 CHANGELOG entry: live status.json read
// `degraded` with `summary.overdue: 1` (velouria-audit-20260819) while
// `summary.retired_namespaces` listed only TWO of the three names that were
// supposed to be retired — the `vercel env add` write had come up short and
// nobody could tell from the code alone, because the retirement filter
// itself has never been exercised end to end in this suite. This file is
// that coverage: it drives the real gatherStatusData() -> status.json shaping
// pipeline with a SHORT var to reproduce the exact failure as a red, then a
// FULL var to prove the fix path, then a blank var as the off-switch control.
//
// Fixture/injection seam: the same one test/cadence_overdue.test.js's "ZERO
// FLOOR" tests use — monkeypatch lib/_store.js's read functions directly
// (repoReachable/listDir/getFile/getRawFile/getTree), never touching
// GitHub. Extended here to serve a DIFFERENT pin per namespace, since the
// three retired candidates all need to be overdue while a fourth namespace
// stays current — otherwise an all-retired store trips the unrelated ZERO
// FLOOR (nothingWatched) and the overdue-specific assertions would be
// confounded by that separate mechanism instead of isolating this one.
"use strict";

const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const { makeReq, makeRes } = require("./helpers/http_mocks.js");
const realStore = require("../lib/_store.js");
const statusJson = require("../lib/_status_json.js");

// Safely in the past relative to any real test run, and safely in the
// future — so "overdue" vs "current" never depends on wall-clock timing.
const PAST_DUE = "2020-01-01T00:00:00.000Z";
const FUTURE_DUE = "2099-01-01T00:00:00.000Z";

const RETIRE_CANDIDATES = [
  "velouria-cadence-verify",
  "velouria-canon",
  "velouria-audit-20260819",
];
const HEALTHY_NS = "acme-prod";
const ALL_NS = [...RETIRE_CANDIDATES, HEALTHY_NS];

function overduePin(ns) {
  return { namespace: ns, rows: 10, chain: "a".repeat(32),
           pinned_at: PAST_DUE, seq: 1, next_pin_due_by: PAST_DUE };
}
function currentPin(ns) {
  return { namespace: ns, rows: 10, chain: "b".repeat(32),
           pinned_at: PAST_DUE, seq: 1, next_pin_due_by: FUTURE_DUE };
}

const PINS = {
  "velouria-cadence-verify": overduePin("velouria-cadence-verify"),
  "velouria-canon": overduePin("velouria-canon"),
  "velouria-audit-20260819": overduePin("velouria-audit-20260819"),
  [HEALTHY_NS]: currentPin(HEALTHY_NS),
};

// Same shape as cadence_overdue.test.js's stubStore, generalized to one pin
// PER NAMESPACE instead of one shared pin for every namespace.
function stubStore(store, { namespaces = [], pins = {} } = {}) {
  const saved = {
    repoReachable: store.repoReachable,
    listDir: store.listDir,
    getFile: store.getFile,
    getRawFile: store.getRawFile,
    getTree: store.getTree,
  };
  const today = new Date().toISOString().slice(0, 10);
  const headName = `${today}-head.txt`;
  store.repoReachable = async () => true;
  store.listDir = async (dir) => {
    if (dir === "anchors") {
      return [{ type: "file", name: headName },
              { type: "file", name: `${headName}.ots` }];
    }
    return namespaces.map((n) => ({ type: "dir", name: n }));
  };
  store.getRawFile = async () => ({ text: `deadbeef ${new Date().toISOString()}` });
  store.getFile = async (path) => {
    const m = path.match(/^pins\/([^/]+)\/latest\.json$/);
    if (m && pins[m[1]]) return { json: pins[m[1]] };
    return null;
  };
  store.getTree = async () => [];
  return () => Object.assign(store, saved);
}

let restoreStore;

beforeEach(() => {
  restoreStore = stubStore(realStore, { namespaces: ALL_NS, pins: PINS });
});

afterEach(() => {
  restoreStore();
  delete process.env.WITNESS_RETIRED_NS;
});

async function getStatusJson() {
  const req = makeReq({ method: "GET" });
  const res = makeRes();
  await statusJson(req, res);
  assert.equal(res._status, 200, "status.json handler must answer 200 for this fixture");
  return res._body;
}

function rowFor(body, ns) {
  const row = body.namespaces.find((n) => n.namespace === ns);
  assert.ok(row, `expected a namespaces[] row for ${ns}`);
  return row;
}

// ---------------------------------------------------------------------
// (a) full list: all three retired -> excluded from the verdict, still
// listed with their real (overdue) cadence status.
// ---------------------------------------------------------------------

test("WITNESS_RETIRED_NS with all three names: retired_namespaces lists all three, overdue == 0, each row still carries retired:true + real overdue status", async () => {
  process.env.WITNESS_RETIRED_NS = RETIRE_CANDIDATES.join(",");
  const body = await getStatusJson();

  assert.deepEqual(
    [...body.summary.retired_namespaces].sort(),
    [...RETIRE_CANDIDATES].sort(),
  );
  assert.equal(body.summary.overdue, 0,
    "all three overdue candidates are retired, so the graded overdue count must be zero");

  for (const ns of RETIRE_CANDIDATES) {
    const row = rowFor(body, ns);
    assert.equal(row.retired, true, `${ns} should be listed as retired`);
    assert.equal(row.status, "overdue",
      `${ns} is still actually overdue by cadence math — retirement excludes it from the VERDICT, not from its own honest status`);
  }

  // The only graded namespace left is the healthy one -> the top-level
  // verdict reads OK, not swallowed by the unrelated "nothingWatched" floor.
  const healthy = rowFor(body, HEALTHY_NS);
  assert.equal(healthy.retired, false);
  assert.equal(healthy.status, "current");
  assert.equal(body.status, "ok");
  assert.equal(body.ok, true);
});

// ---------------------------------------------------------------------
// (b) SHORT list: velouria-audit-20260819 missing -> counts as overdue,
// verdict degrades. This is the 2026-08-24 -> 2026-08-30 production
// failure, reproduced here as a red.
// ---------------------------------------------------------------------

test("WITNESS_RETIRED_NS missing one name (the 8/24->8/30 failure): the un-retired namespace counts as overdue and the verdict degrades", async () => {
  process.env.WITNESS_RETIRED_NS = "velouria-cadence-verify,velouria-canon";
  const body = await getStatusJson();

  assert.deepEqual(
    [...body.summary.retired_namespaces].sort(),
    ["velouria-cadence-verify", "velouria-canon"].sort(),
  );

  const missed = rowFor(body, "velouria-audit-20260819");
  assert.equal(missed.retired, false,
    "velouria-audit-20260819 was dropped from the env var, so it must NOT be treated as retired");
  assert.equal(missed.status, "overdue");

  assert.equal(body.summary.overdue, 1,
    "exactly the one namespace missing from the retired list is graded overdue");
  assert.equal(body.status, "degraded",
    "an ungraded-retirement overdue namespace must degrade the public verdict, exactly as it did in production on 2026-08-24/30");
  assert.equal(body.ok, false);
});

// ---------------------------------------------------------------------
// (c) whitespace/empty var -> nothing retired.
// ---------------------------------------------------------------------

for (const [label, value] of [["empty string", ""], ["whitespace only", "   \t  "]]) {
  test(`WITNESS_RETIRED_NS as ${label}: nothing is retired`, async () => {
    process.env.WITNESS_RETIRED_NS = value;
    const body = await getStatusJson();

    assert.deepEqual(body.summary.retired_namespaces, []);
    for (const ns of RETIRE_CANDIDATES) {
      const row = rowFor(body, ns);
      assert.equal(row.retired, false, `${ns} must not be retired when the var is ${label}`);
      assert.equal(row.status, "overdue");
    }
    assert.equal(body.summary.overdue, RETIRE_CANDIDATES.length,
      "with nothing retired, all three overdue candidates are graded overdue");
    assert.equal(body.status, "degraded");
  });
}

test("WITNESS_RETIRED_NS unset entirely: same as empty -- nothing retired", async () => {
  delete process.env.WITNESS_RETIRED_NS;
  const body = await getStatusJson();

  assert.deepEqual(body.summary.retired_namespaces, []);
  assert.equal(body.summary.overdue, RETIRE_CANDIDATES.length);
  assert.equal(body.status, "degraded");
});
