// test/planted_dead_ledger.test.js — THE PLANTED-DEAD FIXTURE, on the producer.
//
// One job: overwrite the stored ledger head with garbage, ask the service
// about it, and require a non-200. It stays its own file on purpose. The
// constructor rule (lib/_verdict.js, test/verdict_required.test.js) forbids
// the DEFAULT; this plants the DAMAGE and watches what the producer actually
// says. They are not substitutes: a constructor can be perfect and a new call
// site can still walk around it, and only a planted corpse finds that.
//
// Lineage: this is the witness-side twin of
// arcaeon-receipt/tests/test_call_proxy.py::
//   test_health_endpoint_goes_non_200_when_the_ledger_is_unreadable
// (2026-09-19), where the defect was first found: a corrupt ledger answered
// 200 {"ok": true, "rows": 0, "chain": "genesis"}. The guard sentence below is
// carried over word for word.
//
// THE GUARD. A planted-dead test has one way to lie: the plant does not take,
// the ledger is still fine, the service correctly says so, and an assertion
// written as "not the healthy answer" passes anyway or fails for the wrong
// reason. So every arm first proves — from the FIXTURE's side, by reading the
// stored bytes back, not by asking the code under test — that the ledger it is
// about to ask about is in fact broken:
//     "fixture did not break the ledger; the test proves nothing"
//
// "The ledger" here is a namespace's stored head, pins/<ns>/latest.json, in
// the public pin repo: the one document every read endpoint answers from.

"use strict";

process.env.GITHUB_PIN_REPO = "test-owner/test-pins";
process.env.GITHUB_PIN_BRANCH = "main";
process.env.GITHUB_USAGE_REPO = "test-owner/test-usage";
process.env.GITHUB_PIN_TOKEN = "test-token";
process.env.WITNESS_KEYS = "testkeyA:demo-";
delete process.env.WITNESS_PLANS;
delete process.env.WITNESS_CADENCE;

const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const { MockGitHubStore, install } = require("./helpers/mock_store.js");
const { makeReq, makeRes } = require("./helpers/http_mocks.js");
const latestHandler = require("../api/latest.js");
const verifyHandler = require("../api/verify.js");
const pinHandler = require("../api/pin.js");

const PIN_REPO = process.env.GITHUB_PIN_REPO;
const NS = "demo-planted";
const HEAD = `pins/${NS}/latest.json`;
const GUARD = "fixture did not break the ledger; the test proves nothing";

// The same bytes the receipt repo's fixture plants.
const GARBAGE_NOT_JSON = "{this is not a ledger row\n";
// And the shape the original bug MANUFACTURED: valid JSON, zero rows, genesis.
const GARBAGE_GENESIS_JSON = JSON.stringify({ ok: true, rows: 0, chain: "genesis" }) + "\n";

let gh;
let restore;

beforeEach(() => {
  gh = new MockGitHubStore();
  const routed = install(gh);
  // api/latest.js falls back to the raw CDN when the contents API cannot be
  // reached. Serve that host from the SAME stored bytes, so the fallback can
  // never rescue this test with a 404 the mock invented.
  const viaStore = global.fetch;
  global.fetch = async (url, opts) => {
    const u = new URL(String(url));
    if (u.hostname === "raw.githubusercontent.com") {
      const path = u.pathname.split("/").slice(4).join("/");
      const rec = gh._repoMap(PIN_REPO).get(path);
      if (!rec) return { status: 404, ok: false, json: async () => ({}), text: async () => "" };
      return { status: 200, ok: true, json: async () => JSON.parse(rec.content), text: async () => rec.content };
    }
    return viaStore(url, opts);
  };
  restore = routed;
});
afterEach(() => restore());

async function call(handler, reqOpts) {
  const res = makeRes();
  await handler(makeReq(reqOpts), res);
  return res;
}

async function healthyLedger() {
  const res = await call(pinHandler, {
    method: "POST", headers: { authorization: "Bearer testkeyA" },
    body: { namespace: NS, rows: 12, chain: "cafebabe" },
  });
  assert.equal(res._status, 201, `could not build the healthy ledger to break: ${JSON.stringify(res._body)}`);
  const before = await call(latestHandler, { query: { ns: NS } });
  assert.equal(before._status, 200, "the ledger was not healthy BEFORE the plant, so a non-200 afterwards would prove nothing");
  assert.equal(before._body.ok, true);
}

// Overwrite the stored bytes directly — not through gh.seed(), which can only
// write well-formed JSON — and then prove from the fixture's side that it took.
function plantDead(bytes) {
  const map = gh._repoMap(PIN_REPO);
  assert.ok(map.has(HEAD), GUARD);
  map.set(HEAD, { content: bytes, sha: "0".repeat(40) });

  const stored = map.get(HEAD).content;
  assert.equal(stored, bytes, GUARD);
  let parsed;
  let parses = true;
  try { parsed = JSON.parse(stored); } catch { parses = false; }
  const stillAPin =
    parses && parsed && Number.isInteger(parsed.rows) && parsed.rows >= 1 &&
    typeof parsed.chain === "string" && /^[0-9a-f]{8,64}$/i.test(parsed.chain) && Number.isInteger(parsed.seq);
  assert.equal(stillAPin, false, GUARD);
}

function assertDeadAnswer(res, label) {
  // THE GUARD, producer side: if the service still calls this ledger ok, either
  // the plant did not take or the defect is back. Both mean stop.
  assert.equal(res._body && res._body.ok, false, `${label}: ${GUARD}`);
  assert.notEqual(res._status, 200, `${label}: a status-code-only probe saw a healthy service over a dead ledger`);
  assert.ok(res._status >= 500, `${label}: answered ${res._status} — a dead ledger is a server-side fault, not "not found"`);
  assert.doesNotMatch(JSON.stringify(res._body), /genesis|no pin recorded|no_pin_recorded|legacy_no_deadline|not_found_in_history/,
    `${label}: the body describes a dead ledger as a new, old, or empty one`);
}

for (const [name, bytes] of [["bytes that are not JSON", GARBAGE_NOT_JSON],
                             ["valid JSON saying rows:0 chain:genesis", GARBAGE_GENESIS_JSON]]) {
  test(`PLANTED DEAD (${name}): GET /api/latest goes non-200`, async () => {
    await healthyLedger();
    plantDead(bytes);
    assertDeadAnswer(await call(latestHandler, { query: { ns: NS } }), "/api/latest");
  });

  test(`PLANTED DEAD (${name}): GET /api/verify goes non-200 and gives no witnessed verdict`, async () => {
    await healthyLedger();
    plantDead(bytes);
    const res = await call(verifyHandler, { query: { ns: NS, rows: "12", chain: "cafebabe" } });
    assertDeadAnswer(res, "/api/verify");
    assert.ok(!("witnessed" in res._body), "/api/verify: a dead ledger produced a witnessed verdict");
  });

  test(`PLANTED DEAD (${name}): POST /api/pin refuses to pin over it and writes nothing`, async () => {
    await healthyLedger();
    plantDead(bytes);
    const writesBefore = gh.putLog.length;
    const res = await call(pinHandler, {
      method: "POST", headers: { authorization: "Bearer testkeyA" },
      body: { namespace: NS, rows: 13, chain: "deadbeef" },
    });
    assert.notEqual(res._status, 200, GUARD);
    assert.notEqual(res._status, 201, "/api/pin: a new head was accepted over a dead one");
    assert.ok(res._status >= 500, `/api/pin answered ${res._status}`);
    assert.equal(gh.putLog.length, writesBefore, "/api/pin wrote over a ledger it could not read");
  });
}

// ---------------------------------------------------------------------
// ROWS WENT BACKWARDS, over a damaged head (atomic-raven's control arm,
// Colony post 42b8d6e0; 2026-09-22).
//
// api/pin.js's monotonic guard, as it was before the verdict layer:
//     if (cur && Number.isInteger(cur.json.rows) && rows < cur.json.rows) -> 409
// Its precondition clause, Number.isInteger(cur.json.rows), is FALSE when the
// head's rows field is damaged, so the whole guard is false and a backward pin
// walks past it: the guard SKIPS rather than refuses. The arm below plants
// exactly that head (valid JSON, the right namespace, chain and seq intact,
// rows unreadable) and submits rows that are LOWER than the head's damaged
// "12". It must be refused red (503, nothing written), not accepted.
//
// Run red on the old guard before commit: with the headVerdict refusal in
// api/pin.js removed (the pre-verdict behaviour), this arm answered 201 and
// wrote a new head. See CHANGELOG.md, 2026-09-22.
// ---------------------------------------------------------------------
const DAMAGED_ROWS_HEAD = JSON.stringify({
  namespace: NS, rows: "12", chain: "cafebabe", seq: 1, pinned_at: "2026-09-22T00:00:00Z",
}) + "\n";

async function backwardPin() {
  return call(pinHandler, {
    method: "POST", headers: { authorization: "Bearer testkeyA" },
    body: { namespace: NS, rows: 5, chain: "deadbeef" },
  });
}

test("ROWS WENT BACKWARDS over a damaged head: the old guard's precondition is false, and the pin is REFUSED red, not waved through", async () => {
  await healthyLedger();
  plantDead(DAMAGED_ROWS_HEAD);
  // prove from the fixture side that this is the case the old guard skipped:
  // the head parses, carries the namespace, and its rows are not an integer.
  const planted = JSON.parse(gh._repoMap(PIN_REPO).get(HEAD).content);
  assert.equal(planted.namespace, NS, GUARD);
  assert.equal(Number.isInteger(planted.rows), false, `${GUARD} (the old guard's precondition would be true)`);

  const writesBefore = gh.putLog.length;
  const res = await backwardPin();
  assert.notEqual(res._status, 201, "a backward pin was ACCEPTED over a head whose rows could not be read: the guard skipped");
  assert.notEqual(res._status, 200, "a backward pin was answered 200 over a damaged head");
  assert.equal(res._status, 503, `expected the red refusal (503), got ${res._status}: ${JSON.stringify(res._body)}`);
  assert.equal(res._body.ok, false);
  assert.equal(res._body.reason, "rows_unreadable");
  assert.equal(gh.putLog.length, writesBefore, "/api/pin wrote over a head whose rows it could not read");
  assert.equal(gh._repoMap(PIN_REPO).get(HEAD).content, DAMAGED_ROWS_HEAD, "the damaged head was overwritten");
});

test("ROWS WENT BACKWARDS, control: the same backward pin over an UNDAMAGED head is the ordinary 409 monotonic refusal", async () => {
  // Same namespace, same submitted rows, head intact: the guard's own clause
  // fires. If this arm ever answers 503 the damaged arm above proves nothing
  // about damage, and if it answers 201 the monotonic guard itself is gone.
  await healthyLedger();
  const writesBefore = gh.putLog.length;
  const res = await backwardPin();
  assert.equal(res._status, 409, `control: expected the monotonic 409, got ${res._status}: ${JSON.stringify(res._body)}`);
  assert.match(res._body.error, /never goes backward/);
  assert.equal(gh.putLog.length, writesBefore, "control: a refused backward pin wrote something");
});

test("PLANTED DEAD, the guard's own control: an UNPLANTED ledger makes the dead-answer assertion fail with the guard sentence", async () => {
  // The guard is only worth its name if it fires. Skip the plant, run the same
  // assertion, and require that it refuses — with the guard's words.
  await healthyLedger();
  const res = await call(latestHandler, { query: { ns: NS } });
  assert.throws(() => assertDeadAnswer(res, "/api/latest"), (e) => e.message.includes(GUARD));
});
