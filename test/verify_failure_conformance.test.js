// test/verify_failure_conformance.test.js — FAILURE conformance for GET/POST /api/verify.
//
// Every test here asks the Sigstore-conformance question: "does the verifier
// FAIL when given a bad X?" A suite of happy paths cannot tell a working
// checker from one that answers witnessed:true unconditionally, so every case
// below feeds a deliberately bad head / bad store state and asserts the answer
// is NOT a positive confirmation (witnessed !== true).
//
// The break arm at the bottom runs every case against a LYING verifier that
// always answers witnessed:true, and asserts every single case goes red. If a
// case passes against the liar, the case proves nothing.
//
// Known accept-bad-input findings are kept as `todo` with the reason, never
// deleted and never "fixed" by changing the verifier from this file.
"use strict";

process.env.GITHUB_PIN_REPO = "test-owner/test-pins";
process.env.GITHUB_PIN_BRANCH = "main";
process.env.GITHUB_PIN_TOKEN = "test-token";

const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const { MockGitHubStore, install } = require("./helpers/mock_store.js");
const { makeReq, makeRes } = require("./helpers/http_mocks.js");
const realHandler = require("../api/verify.js");

const PIN_REPO = process.env.GITHUB_PIN_REPO;
const NS = "conf-ns";
const CHAIN = "0123456789abcdef0123456789abcdef";
const OTHER = "fedcba9876543210fedcba9876543210";

let gh;
let restore;
let ipCounter = 0;

beforeEach(() => {
  gh = new MockGitHubStore();
  restore = install(gh);
});

afterEach(() => {
  restore();
});

// Unique IP per call so the per-IP limiter never turns a case into a 429 that
// "passes" for the wrong reason.
function nextIp() {
  ipCounter += 1;
  return `198.51.${(ipCounter >> 8) & 255}.${ipCounter & 255}`;
}

async function callGet(handler, query) {
  const res = makeRes();
  await handler(makeReq({ query, headers: { "x-forwarded-for": nextIp() } }), res);
  return res;
}

async function callBulk(handler, items) {
  const res = makeRes();
  await handler(makeReq({ method: "POST", query: { op: "bulk" }, body: { items }, headers: { "x-forwarded-for": nextIp() } }), res);
  return res;
}

// The ONE assertion every case shares: no positive confirmation.
function assertNotWitnessed(res, label) {
  const b = res._body || {};
  assert.notEqual(b.witnessed, true, `${label}: verifier said witnessed:true on bad input (${JSON.stringify(b).slice(0, 300)})`);
  if (Array.isArray(b.results)) {
    for (const r of b.results) {
      assert.notEqual(r.witnessed, true, `${label}: bulk item said witnessed:true on bad input (${JSON.stringify(r).slice(0, 200)})`);
    }
  }
}

function pin(rows, chain, seq, extra = {}) {
  return { namespace: NS, rows, chain, seq, pinned_at: new Date(Date.now() - 3600e3).toISOString(), ...extra };
}

function seedHistory(records) {
  // records: array of pins in seq order; the last is latest.json
  for (const r of records) gh.seed(PIN_REPO, `pins/${r.namespace}/${String(r.seq).padStart(8, "0")}.json`, r);
  const last = records[records.length - 1];
  gh.seed(PIN_REPO, `pins/${last.namespace}/latest.json`, last);
}

// ---------------------------------------------------------------------------
// The case table. Each case seeds the store, calls the handler it is given,
// and returns the response. Shared by the real run and by the break arm.
// ---------------------------------------------------------------------------
test("PRECONDITION: a genuinely witnessed current head IS witnessed:true (so every red below is the verifier's doing)", async () => {
  seedHistory([pin(10, CHAIN, 1)]);
  const res = await callGet(realHandler, { ns: NS, rows: "10", chain: CHAIN });
  assert.equal(res._body.witnessed, true);
  assert.equal(res._body.is_current_head, true);
});

const CASES = [
  ["wrong chain at the current head's rows", async (h) => {
    seedHistory([pin(10, CHAIN, 1)]);
    return callGet(h, { ns: NS, rows: "10", chain: OTHER });
  }],
  ["prefix of the true chain (8 hex) is not the chain", async (h) => {
    seedHistory([pin(10, CHAIN, 1)]);
    return callGet(h, { ns: NS, rows: "10", chain: CHAIN.slice(0, 8) });
  }],
  ["true chain with one hex digit flipped", async (h) => {
    seedHistory([pin(10, CHAIN, 1)]);
    const flipped = CHAIN.slice(0, -1) + (CHAIN.endsWith("f") ? "e" : "f");
    return callGet(h, { ns: NS, rows: "10", chain: flipped });
  }],
  ["rows one MORE than the witnessed head", async (h) => {
    seedHistory([pin(10, CHAIN, 1)]);
    return callGet(h, { ns: NS, rows: "11", chain: CHAIN });
  }],
  ["rows one FEWER than the witnessed head (never itself a head)", async (h) => {
    seedHistory([pin(10, CHAIN, 1)]);
    return callGet(h, { ns: NS, rows: "9", chain: CHAIN });
  }],
  ["right chain, wrong rows in a deeper history", async (h) => {
    seedHistory([pin(5, OTHER, 1), pin(10, CHAIN, 2)]);
    return callGet(h, { ns: NS, rows: "5", chain: CHAIN });
  }],
  ["unknown namespace", async (h) => callGet(h, { ns: "never-pinned-ns", rows: "10", chain: CHAIN })],
  ["right head, but asked under a DIFFERENT namespace", async (h) => {
    seedHistory([pin(10, CHAIN, 1)]);
    gh.seed(PIN_REPO, "pins/other-ns/latest.json", { namespace: "other-ns", rows: 3, chain: OTHER, seq: 1, pinned_at: new Date().toISOString() });
    return callGet(h, { ns: "other-ns", rows: "10", chain: CHAIN });
  }],
  ["missing ns", async (h) => callGet(h, { rows: "10", chain: CHAIN })],
  ["missing rows", async (h) => { seedHistory([pin(10, CHAIN, 1)]); return callGet(h, { ns: NS, chain: CHAIN }); }],
  ["missing chain", async (h) => { seedHistory([pin(10, CHAIN, 1)]); return callGet(h, { ns: NS, rows: "10" }); }],
  ["empty strings everywhere", async (h) => callGet(h, { ns: "", rows: "", chain: "" })],
  ["no query at all", async (h) => callGet(h, {})],
  ["rows zero", async (h) => { seedHistory([pin(10, CHAIN, 1)]); return callGet(h, { ns: NS, rows: "0", chain: CHAIN }); }],
  ["rows negative", async (h) => { seedHistory([pin(10, CHAIN, 1)]); return callGet(h, { ns: NS, rows: "-10", chain: CHAIN }); }],
  ["rows fractional", async (h) => { seedHistory([pin(10, CHAIN, 1)]); return callGet(h, { ns: NS, rows: "10.5", chain: CHAIN }); }],
  ["rows not a number", async (h) => { seedHistory([pin(10, CHAIN, 1)]); return callGet(h, { ns: NS, rows: "ten", chain: CHAIN }); }],
  ["chain with non-hex characters", async (h) => { seedHistory([pin(10, CHAIN, 1)]); return callGet(h, { ns: NS, rows: "10", chain: "zz" + CHAIN.slice(2) }); }],
  ["chain too short (7 hex)", async (h) => { seedHistory([pin(10, "0123456", 1)]); return callGet(h, { ns: NS, rows: "10", chain: "0123456" }); }],
  ["chain and digest disagree", async (h) => { seedHistory([pin(10, CHAIN, 1)]); return callGet(h, { ns: NS, rows: "10", chain: CHAIN, digest: OTHER }); }],
  ["namespace with path traversal", async (h) => callGet(h, { ns: "../conf-ns", rows: "10", chain: CHAIN })],
  ["namespace uppercase / illegal shape", async (h) => callGet(h, { ns: "CONF-NS", rows: "10", chain: CHAIN })],
  ["array-valued query params (?rows=10&rows=10)", async (h) => { seedHistory([pin(10, CHAIN, 1)]); return callGet(h, { ns: NS, rows: ["10", "10"], chain: [CHAIN, CHAIN] }); }],
  ["store latest.json has a non-integer rows (edited pin)", async (h) => {
    gh.seed(PIN_REPO, `pins/${NS}/latest.json`, pin("10", CHAIN, 1));
    return callGet(h, { ns: NS, rows: "10", chain: CHAIN });
  }],
  ["store latest.json has no chain (edited pin)", async (h) => {
    const p = pin(10, CHAIN, 1); delete p.chain;
    gh.seed(PIN_REPO, `pins/${NS}/latest.json`, p);
    return callGet(h, { ns: NS, rows: "10", chain: "756e646566696e6564" }); // hex("undefined")
  }],
  ["store read error is never a yes", async (h) => {
    // An unreadable store must not become a positive answer. Mock 500 on the GET.
    const origFetch = global.fetch;
    global.fetch = async () => ({ status: 500, ok: false, json: async () => ({ message: "boom" }), text: async () => "boom" });
    try { return await callGet(h, { ns: NS, rows: "10", chain: CHAIN }); }
    finally { global.fetch = origFetch; }
  }],
  ["bulk: every item bad, never a yes", async (h) => {
    seedHistory([pin(10, CHAIN, 1)]);
    return callBulk(h, [
      { ns: NS, rows: 10, chain: OTHER },
      { ns: NS, rows: 11, chain: CHAIN },
      { ns: "never-pinned-ns", rows: 10, chain: CHAIN },
      { ns: NS, rows: "x", chain: CHAIN },
      null,
      "not-an-object",
      {},
    ]);
  }],
  ["bulk: empty items", async (h) => callBulk(h, [])],
  ["bulk: items not an array", async (h) => {
    const res = makeRes();
    await h(makeReq({ method: "POST", query: { op: "bulk" }, body: { items: { ns: NS, rows: 10, chain: CHAIN } }, headers: { "x-forwarded-for": nextIp() } }), res);
    return res;
  }],
  ["bulk: over the cap is refused whole", async (h) => {
    seedHistory([pin(10, CHAIN, 1)]);
    return callBulk(h, Array.from({ length: 21 }, () => ({ ns: NS, rows: 10, chain: CHAIN })));
  }],
];

for (const [name, run] of CASES) {
  test(`FAILS on bad input: ${name}`, async () => {
    assertNotWitnessed(await run(realHandler), name);
  });
}

// --- Stale pin: a superseded head IS witnessed, but must never claim to be current ---
test("FAILS to call a stale (superseded) head current: is_current_head is false", async () => {
  seedHistory([pin(5, OTHER, 1), pin(10, CHAIN, 2)]);
  const res = await callGet(realHandler, { ns: NS, rows: "5", chain: OTHER });
  assert.equal(res._body.witnessed, true, "precondition: the historical head was witnessed");
  assert.equal(res._body.is_current_head, false, "a superseded head must not be reported as the current head");
});

// ---------------------------------------------------------------------------
// KNOWN ACCEPT-BAD-INPUT FINDINGS. Kept as todo; the verifier is not changed here.
// ---------------------------------------------------------------------------

// FINDING W-1: the record's own `namespace` field is never cross-checked against
// the namespace asked about. A pin copied from namespace A into pins/B/latest.json
// verifies as witnessed:true for B. Same class as cosign GHSA-ccxc-vr6p-4858 (a
// bundle copied across signatures) / GHSA-whqx (entry not cross-checked against
// the artifact). Needs write access to the pins repo, so it is an operator/insider
// or store-corruption path, not a stranger path.
test("FAILS when the stored pin names a DIFFERENT namespace than the path it sits at",
  { todo: "FINDING W-1: api/verify.js never compares record.namespace to the requested ns; a pin copied across namespaces verifies witnessed:true" },
  async () => {
    gh.seed(PIN_REPO, `pins/${NS}/latest.json`, { ...pin(10, CHAIN, 1), namespace: "someone-else" });
    const res = await callGet(realHandler, { ns: NS, rows: "10", chain: CHAIN });
    assertNotWitnessed(res, "cross-namespace pin");
  });

// FINDING W-2: same missing cross-check on the history scan: a record at
// pins/<ns>/<seq>.json whose own `seq` (or namespace) disagrees with its path is
// still accepted.
test("FAILS when a historical record's own seq/namespace disagrees with its path",
  { todo: "FINDING W-2: history scan trusts the record body; seq/namespace are not checked against the file path" },
  async () => {
    seedHistory([pin(5, OTHER, 1), pin(10, CHAIN, 2)]);
    gh.seed(PIN_REPO, `pins/${NS}/00000001.json`, { namespace: "someone-else", rows: 5, chain: OTHER, seq: 77, pinned_at: new Date().toISOString() });
    const res = await callGet(realHandler, { ns: NS, rows: "5", chain: OTHER });
    assertNotWitnessed(res, "history record path/body mismatch");
  });

// FINDING W-3 (low): rows is parsed with Number(), so "0x0a", "1e1" and " 10 "
// are all accepted as 10. The head is genuinely witnessed, so this is a
// malformed-input acceptance, not a false head; recorded because a strict
// verifier rejects an ill-formed request instead of reinterpreting it.
test("FAILS on non-decimal rows encodings (0x0a, 1e1)",
  { todo: "FINDING W-3 (low): Number() coerces hex/exponent rows strings into a valid integer and the head verifies" },
  async () => {
    seedHistory([pin(10, CHAIN, 1)]);
    for (const rows of ["0x0a", "1e1"]) {
      assertNotWitnessed(await callGet(realHandler, { ns: NS, rows, chain: CHAIN }), `rows=${rows}`);
    }
  });

// ---------------------------------------------------------------------------
// BREAK ARM: the suite must fail against a lying verifier.
// ---------------------------------------------------------------------------
test("BREAK ARM: every failure case goes RED against a verifier that always says witnessed:true", async () => {
  const liar = async (req, res) => res.status(200).json({ ok: true, witnessed: true, is_current_head: true, results: [{ witnessed: true }] });
  const survivors = [];
  for (const [name, run] of CASES) {
    let caught = false;
    try {
      assertNotWitnessed(await run(liar), name);
    } catch (e) {
      caught = e instanceof assert.AssertionError;
    }
    if (!caught) survivors.push(name);
    // fresh store per case, same as the real run
    restore(); gh = new MockGitHubStore(); restore = install(gh);
  }
  assert.deepEqual(survivors, [], "these cases did NOT catch a lying verifier, so they prove nothing");
});
