// test/pin.test.js — api/pin.js: the write path (POST /api/pin).
//
// Env vars set BEFORE requiring the handler or _store.js/_meter.js/_balance.js
// — REPO/USAGE_REPO are top-level consts read at require time.
"use strict";

process.env.GITHUB_PIN_REPO = "test-owner/test-pins";
process.env.GITHUB_PIN_BRANCH = "main";
process.env.GITHUB_USAGE_REPO = "test-owner/test-usage";
process.env.GITHUB_PIN_TOKEN = "test-token";
// Two keys sharing one namespace prefix — this is exactly the shape
// excelsior's review said the prefix gate alone can't distinguish.
process.env.WITNESS_KEYS = "testkeyA:demo-,testkeyB:demo-";
delete process.env.WITNESS_PLANS; // default free plan, cap 100
delete process.env.WITNESS_CADENCE; // default 24h cadence

const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const { MockGitHubStore, install } = require("./helpers/mock_store.js");
const { makeReq, makeRes } = require("./helpers/http_mocks.js");
const store = require("../lib/_store.js");
const pinHandler = require("../api/pin.js");

const PIN_REPO = process.env.GITHUB_PIN_REPO;

let gh;
let restore;

// lib/_store.js putFile now retries a 409 with a ~1s jittered backoff (task
// 093). The waiting is swapped out here so the conflict regressions below run
// in milliseconds; the retry LOGIC is untouched and still exercised.
const realPutSleep = store._putRetry.sleep;

beforeEach(() => {
  gh = new MockGitHubStore();
  restore = install(gh);
  store._putRetry.sleep = async () => {};
});

afterEach(() => {
  store._putRetry.sleep = realPutSleep;
  restore();
});

function pinReq({ namespace, rows, chain, intent, key = "testkeyA" }) {
  const body = { namespace, rows, chain };
  if (intent !== undefined) body.intent = intent;
  return makeReq({
    method: "POST",
    headers: { authorization: `Bearer ${key}` },
    body,
  });
}

// ---------------------------------------------------------------------
// CONTRACT: baseline write behavior
// ---------------------------------------------------------------------

test("CONTRACT: first pin on a fresh namespace is a 201 content_head_advance", async () => {
  const req = pinReq({ namespace: "demo-fresh1", rows: 10, chain: "a1b2c3d4" });
  const res = makeRes();
  await pinHandler(req, res);
  assert.equal(res._status, 201);
  assert.equal(res._body.ok, true);
  assert.equal(res._body.record_kind, "content_head_advance");
  assert.equal(res._body.pin.rows, 10);
  assert.equal(res._body.pin.chain, "a1b2c3d4");
});

test("CONTRACT: monotonic guard rejects rows going backward, 409, charges nothing", async () => {
  await pinHandler(pinReq({ namespace: "demo-mono1", rows: 10, chain: "aaaaaaaa" }), makeRes());

  const usagePathBefore = gh.read(
    process.env.GITHUB_USAGE_REPO,
    `usage/${require("../lib/_meter.js").keyHash("testkeyA")}/${require("../lib/_meter.js").utcMonth()}.json`
  );
  const usedBefore = usagePathBefore ? usagePathBefore.used : 0;

  const res = makeRes();
  await pinHandler(pinReq({ namespace: "demo-mono1", rows: 5, chain: "bbbbbbbb" }), res);
  assert.equal(res._status, 409);

  const usagePathAfter = gh.read(
    process.env.GITHUB_USAGE_REPO,
    `usage/${require("../lib/_meter.js").keyHash("testkeyA")}/${require("../lib/_meter.js").utcMonth()}.json`
  );
  assert.equal(usagePathAfter.used, usedBefore, "a rejected pin must not increment the meter");
});

test("CONTRACT: same rows + different chain is a 409 head-conflict, recorded as an observation", async () => {
  await pinHandler(pinReq({ namespace: "demo-conflict1", rows: 10, chain: "aaaaaaaa" }), makeRes());
  const res = makeRes();
  await pinHandler(pinReq({ namespace: "demo-conflict1", rows: 10, chain: "bbbbbbbb" }), res);
  assert.equal(res._status, 409);
  assert.equal(res._body.error.includes("head-conflict"), true);
  // an observation file was written
  const anyObs = [...gh._repoMap(PIN_REPO).keys()].some((p) => p.startsWith("observations/demo-conflict1/"));
  assert.equal(anyObs, true);
});

test("CONTRACT: unknown intent fails closed with 400, never falls through to a plain pin", async () => {
  const res = makeRes();
  await pinHandler(pinReq({ namespace: "demo-badintent1", rows: 10, chain: "aaaaaaaa", intent: "bogus" }), res);
  assert.equal(res._status, 400);
  assert.equal(res._body.reason, "unknown_intent");
});

// ---------------------------------------------------------------------
// REGRESSION: legacy_no_deadline arming (ddee22a)
// ---------------------------------------------------------------------

test("REGRESSION (ddee22a): a bare re-pin of a legacy no-deadline head ARMS the first cadence deadline", async () => {
  const namespace = "demo-legacy1";
  const rows = 50;
  const chain = "deadbeefcafe1234";

  // Seed a pre-cadence-field legacy record — no next_pin_due_by, no
  // intervals array, exactly the shape the CHANGELOG names as the live
  // stuck state (pins/velouria-demo, pins/velouria-selftest).
  gh.seed(PIN_REPO, `pins/${namespace}/latest.json`, {
    namespace,
    rows,
    chain,
    pinned_at: "2026-08-01T00:00:00.000Z",
    seq: 3,
    record_kind: "content_head_advance",
  });

  const before = store.computeCadenceFields(gh.read(PIN_REPO, `pins/${namespace}/latest.json`));
  assert.equal(before.status, "legacy_no_deadline");
  assert.equal(before.cadence_gradeable, false);
  assert.equal(before.next_pin_due_by, null);

  // Bare re-pin: same rows, same chain, NO intent.
  const res1 = makeRes();
  await pinHandler(pinReq({ namespace, rows, chain }), res1);
  assert.equal(res1._status, 201, "arming a legacy head must succeed, not 200-noop");
  assert.equal(res1._body.armed_cadence, true);
  assert.equal(res1._body.record_kind, "publisher_heartbeat");
  assert.ok(res1._body.next_pin_due_by);

  const after = store.computeCadenceFields(gh.read(PIN_REPO, `pins/${namespace}/latest.json`));
  assert.equal(after.status, "publisher_heartbeat_current");
  assert.equal(after.cadence_gradeable, true);
  assert.equal(after.cadence_grade, "pass");
  assert.equal(after.had_ungradeable_history, true, "the record must remember it was once ungradeable, forever");

  // A SECOND bare re-pin must be the plain idempotent no-op — arming is
  // one-time and forward-only, never re-triggered.
  const res2 = makeRes();
  await pinHandler(pinReq({ namespace, rows, chain }), res2);
  assert.equal(res2._status, 200);
  assert.equal(res2._body.note.includes("already witnessed"), true);
  assert.notEqual(res2._body.armed_cadence, true);
});

test("REGRESSION (ddee22a): a head that already HAS a deadline is never re-armed by a bare re-pin", async () => {
  const namespace = "demo-notlegacy1";
  const res1 = makeRes();
  await pinHandler(pinReq({ namespace, rows: 5, chain: "cafebabe" }), res1);
  assert.equal(res1._status, 201);
  assert.ok(res1._body.pin.next_pin_due_by, "a fresh pin already carries a deadline, not legacy");

  const res2 = makeRes();
  await pinHandler(pinReq({ namespace, rows: 5, chain: "cafebabe" }), res2);
  assert.equal(res2._status, 200, "a non-legacy head's bare re-pin stays a plain idempotent no-op");
  assert.notEqual(res2._body.armed_cadence, true);
});

// ---------------------------------------------------------------------
// REGRESSION: owner-binding 403 (excelsior's find)
// ---------------------------------------------------------------------

test("REGRESSION (excelsior): a deadline write (renewal) requires the namespace's bound OWNER key, not just a prefix-valid key", async () => {
  const namespace = "demo-owner1";

  // First pin (content advance) — does NOT bind an owner; the prefix gate
  // alone governs content advances.
  const first = makeRes();
  await pinHandler(pinReq({ namespace, rows: 1, chain: "11111111", key: "testkeyA" }), first);
  assert.equal(first._status, 201);
  assert.equal(gh.has(PIN_REPO, store.ownerPath(namespace)), false, "content advance must not bind a deadline owner");

  // First RENEWAL — this is the first deadline write, so it binds keyA as owner.
  const renewA1 = makeRes();
  await pinHandler(pinReq({ namespace, rows: 1, chain: "11111111", intent: "renew", key: "testkeyA" }), renewA1);
  assert.equal(renewA1._status, 201);
  assert.equal(renewA1._body.renewed, true);
  assert.equal(gh.has(PIN_REPO, store.ownerPath(namespace)), true);

  // A DIFFERENT key that still passes the namespace-prefix gate (both keys
  // are bound to "demo-" in WITNESS_KEYS) must be refused — this is
  // precisely the gap excelsior's review closed: prefix-valid is not
  // owner-valid.
  const renewB = makeRes();
  await pinHandler(pinReq({ namespace, rows: 1, chain: "11111111", intent: "renew", key: "testkeyB" }), renewB);
  assert.equal(renewB._status, 403);
  assert.equal(renewB._body.reason, "not_deadline_owner");

  // The true owner can still renew again — the binding didn't lock out the
  // legitimate publisher.
  const renewA2 = makeRes();
  await pinHandler(pinReq({ namespace, rows: 1, chain: "11111111", intent: "renew", key: "testkeyA" }), renewA2);
  assert.equal(renewA2._status, 201);
  assert.equal(renewA2._body.renewed, true);
});

test("REGRESSION (excelsior): renewal of a namespace nobody has pinned yet is 404, binds no owner", async () => {
  const namespace = "demo-neverpinned1";
  const res = makeRes();
  await pinHandler(pinReq({ namespace, rows: 1, chain: "22222222", intent: "renew" }), res);
  assert.equal(res._status, 404);
  assert.equal(res._body.reason, "no_head_to_renew");
  assert.equal(gh.has(PIN_REPO, store.ownerPath(namespace)), false);
});

// ---------------------------------------------------------------------
// H4 REGRESSION (quad-check 2026-08-16): a namespace's first pin has no
// latest.json yet -- cur is legitimately null. verifyOrphanSuccessor used
// to treat any null `cur` as unverifiable, so the LOSER of two concurrent
// first pins on a brand-new namespace got a false "namespace is wedged,
// reconcile by hand" 409 on a namespace that was actually fine (latest.json
// landed correctly from the winner), and was charged a meter/credit count
// for it (metering runs before the self-heal retry). Reproduced here with
// real concurrency (Promise.all, no forced conflicts needed -- the mock
// store's own create-race 422 on the second writer's seq-record PUT is
// what triggers the self-heal path).
// ---------------------------------------------------------------------

test("H4 REGRESSION: two concurrent first pins on a new namespace never produce a false wedge", async () => {
  const namespace = "demo-race-first-h4";

  const resA = makeRes();
  const resB = makeRes();
  await Promise.all([
    pinHandler(pinReq({ namespace, rows: 10, chain: "aaaaaaaa" }), resA),
    pinHandler(pinReq({ namespace, rows: 10, chain: "aaaaaaaa" }), resB),
  ]);

  // Neither writer may see a false "orphaned_seq_record" wedge on a
  // namespace whose latest.json is actually present and correct.
  for (const res of [resA, resB]) {
    assert.notEqual(res._body.reason, "orphaned_seq_record",
      "a healthy first-pin race must never report a false wedge");
  }
  // One of them created the head (201); the other, having raced into the
  // same (rows, chain), self-heals and settles as the idempotent re-pin.
  const statuses = [resA._status, resB._status].sort();
  assert.deepEqual(statuses, [200, 201],
    "one writer records the advance (201), the other self-heals to the idempotent no-op (200)");

  const latest = gh.read(PIN_REPO, `pins/${namespace}/latest.json`);
  assert.ok(latest, "latest.json must exist after the race resolves");
  assert.equal(latest.rows, 10);
  assert.equal(latest.chain, "aaaaaaaa");
  assert.equal(latest.seq, 1, "the race must settle on exactly one seq record, not a wedge");
});

test("REGRESSION (excelsior): a rejected owner-gate renewal (403) charges no meter and writes no pin record", async () => {
  const namespace = "demo-ownercharge1";
  await pinHandler(pinReq({ namespace, rows: 1, chain: "33333333", key: "testkeyA" }), makeRes());
  await pinHandler(pinReq({ namespace, rows: 1, chain: "33333333", intent: "renew", key: "testkeyA" }), makeRes());

  const meter = require("../lib/_meter.js");
  const usedBefore = gh.read(
    process.env.GITHUB_USAGE_REPO,
    `usage/${meter.keyHash("testkeyB")}/${meter.utcMonth()}.json`
  );

  const res = makeRes();
  await pinHandler(pinReq({ namespace, rows: 1, chain: "33333333", intent: "renew", key: "testkeyB" }), res);
  assert.equal(res._status, 403);

  const usedAfter = gh.read(
    process.env.GITHUB_USAGE_REPO,
    `usage/${meter.keyHash("testkeyB")}/${meter.utcMonth()}.json`
  );
  assert.equal(usedAfter, usedBefore, "a 403'd renewal must not touch testkeyB's meter at all (still null/unset)");
});

// ---------------------------------------------------------------------
// REGRESSION (2026-09-05 audit): a credit charged for a pin must be
// refunded if the write it paid for never lands. Before this fix,
// meterAndCharge's own documented ordering (charge, THEN write) had exactly
// one uncovered failure mode: the charge succeeds and the write fails for a
// real, non-wedged reason (a transient store 5xx) — the credit was gone and
// no pin existed. Every prior audit here covered the REJECTION-before-charge
// case; none covered a genuine post-charge write failure.
// ---------------------------------------------------------------------

function zeroCapPlan(hash) {
  return JSON.stringify({ [hash]: { plan: "free", monthly_cap: 0 } });
}

test("REGRESSION (2026-09-05): a credit debited for a pin is refunded when the write never lands (non-wedged store failure)", async () => {
  const balanceLib = require("../lib/_balance.js");
  const hash = balanceLib.keyHash("testkeyA");
  await balanceLib.grantCredits(hash, 5, "test-seed", "evt-refund-seed-1", "test");

  const savedPlans = process.env.WITNESS_PLANS;
  process.env.WITNESS_PLANS = zeroCapPlan(hash); // force straight to credit on pin #1
  try {
    const ns = "demo-refund-fail1";
    // The seq-1 record's write fails as a genuine store error (not a
    // conflict, not a racing writer) — a transient GitHub 5xx.
    gh.forceFailure(PIN_REPO, `pins/${ns}/00000001.json`, 1, 500);

    const before = await balanceLib.readBalance(hash);
    assert.equal(before.balance, 5);

    const res = makeRes();
    await pinHandler(pinReq({ namespace: ns, rows: 1, chain: "aa11bb22" }), res);

    // The write genuinely failed — the caller must see a real error, never a
    // fabricated 201.
    assert.equal(res._status, 502);
    assert.equal(gh.has(PIN_REPO, `pins/${ns}/00000001.json`), false, "no pin record was actually written");

    // And the credit charged for that write must be back.
    const after = await balanceLib.readBalance(hash);
    assert.equal(after.balance, 5, "a debited credit must be refunded when its paired write never lands");
  } finally {
    if (savedPlans === undefined) delete process.env.WITNESS_PLANS;
    else process.env.WITNESS_PLANS = savedPlans;
  }
});

test("REGRESSION (2026-09-05): each of several independent failed attempts refunds its OWN charge (no drift, no cross-attempt collision)", async () => {
  const balanceLib = require("../lib/_balance.js");
  const hash = balanceLib.keyHash("testkeyA");
  await balanceLib.grantCredits(hash, 5, "test-seed", "evt-refund-seed-2", "test");

  const savedPlans = process.env.WITNESS_PLANS;
  process.env.WITNESS_PLANS = zeroCapPlan(hash);
  try {
    const ns = "demo-refund-fail2";
    // Two SEPARATE client attempts at the same (never-advancing) namespace,
    // each of which fails on its own seq-1 write. This is the exact shape
    // that broke a namespace+seq-derived idempotency key: since the write
    // never lands, latest.json never advances, so both attempts compute the
    // identical next seq — a refund id built from {namespace, seq} alone
    // would make attempt #2's real charge collide with attempt #1's refund.
    gh.forceFailure(PIN_REPO, `pins/${ns}/00000001.json`, 2, 500);

    const res1 = makeRes();
    await pinHandler(pinReq({ namespace: ns, rows: 1, chain: "aa11bb22" }), res1);
    assert.equal(res1._status, 502);
    const mid = await balanceLib.readBalance(hash);
    assert.equal(mid.balance, 5, "attempt #1's charge must be refunded before attempt #2 even runs");

    const res2 = makeRes();
    await pinHandler(pinReq({ namespace: ns, rows: 1, chain: "aa11bb22" }), res2);
    assert.equal(res2._status, 502);
    const final = await balanceLib.readBalance(hash);
    assert.equal(final.balance, 5, "attempt #2's OWN charge must also be refunded, not swallowed by attempt #1's refund id");
  } finally {
    if (savedPlans === undefined) delete process.env.WITNESS_PLANS;
    else process.env.WITNESS_PLANS = savedPlans;
  }
});

test("REGRESSION (2026-09-05): a WEDGED write failure that exhausts the repair budget also refunds its charge", async () => {
  const balanceLib = require("../lib/_balance.js");
  const hash = balanceLib.keyHash("testkeyA");
  await balanceLib.grantCredits(hash, 3, "test-seed", "evt-refund-seed-3", "test");

  const savedPlans = process.env.WITNESS_PLANS;
  process.env.WITNESS_PLANS = zeroCapPlan(hash);
  try {
    const ns = "demo-refund-wedge1";
    // The proactive healIfWedged check on pass 0 finds nothing (no orphan
    // exists yet), so the charge lands normally. Every actual seq-1 write
    // attempt after that is then forced to 409 (more times than MAX_PASSES
    // can self-heal past) — and because the PUT is forced to fail, the
    // record never actually lands, so each self-heal re-check also finds no
    // orphan and just retries. The pass budget exhausts with the charge
    // already taken and nothing ever written.
    //
    // The count was 10 until task 093 (2026-09-13): putFile now spends up to
    // FOUR PUTs of its own per call retrying a 409, so MAX_PASSES(4) passes
    // issue up to 16 PUTs, and a budget of 10 would let the 11th one SUCCEED
    // — turning this regression green for the wrong reason. 40 keeps the
    // test's actual intent ("every seq-1 write attempt is forced to 409")
    // true with headroom.
    gh.forceConflict(PIN_REPO, `pins/${ns}/00000001.json`, 40);

    const res = makeRes();
    await pinHandler(pinReq({ namespace: ns, rows: 1, chain: "aa11bb22" }), res);
    assert.equal(res._status, 409);
    assert.equal(res._body.reason, "orphaned_seq_record");
    assert.equal(gh.has(PIN_REPO, `pins/${ns}/00000001.json`), false, "no pin record was actually written");

    const after = await balanceLib.readBalance(hash);
    assert.equal(after.balance, 3, "a wedge that never resolves (never repairs) must also refund the charge it already took");
  } finally {
    if (savedPlans === undefined) delete process.env.WITNESS_PLANS;
    else process.env.WITNESS_PLANS = savedPlans;
  }
});

// ---------------------------------------------------------------------
// REGRESSION (2026-09-05 audit): a ledger-write failure on an otherwise-
// successful charge must be surfaced, not silently dropped. _balance.js's
// decrementCredit already returned `ledger_write_failed` on its own comment's
// promise ("surfaced in the return value, not swallowed") — but pin.js's
// meterAndCharge read only `c.ok` and threw the rest of the object away,
// so the promise was true one file down and false at the only caller.
// ---------------------------------------------------------------------

test("REGRESSION (2026-09-05): a ledger-write failure on a successful credit decrement is surfaced via a response header, not swallowed", async () => {
  const balanceLib = require("../lib/_balance.js");
  const hash = balanceLib.keyHash("testkeyA");
  await balanceLib.grantCredits(hash, 5, "test-seed", "evt-ledger-seed-1", "test");

  const savedPlans = process.env.WITNESS_PLANS;
  process.env.WITNESS_PLANS = zeroCapPlan(hash);
  try {
    const ns = "demo-ledgerlog1";
    // The balance file itself writes fine — only its paired append-only
    // ledger/ audit record (a SEPARATE file) fails to write. The decrement's
    // seq continues the balance file's own seq counter (already at 1 from
    // the grantCredits seed above), so the first decrement is seq=2, not
    // seq=1 — read it back rather than assuming, per this repo's own rule
    // about not inferring an identifier that can be read from the source.
    const usageRepo = process.env.GITHUB_USAGE_REPO;
    const seeded = await balanceLib.readBalance(hash);
    const decrementSeq = seeded.seq + 1;
    const ledgerPath = balanceLib.ledgerDecrementPath(hash, decrementSeq);
    gh.forceFailure(usageRepo, ledgerPath, 1, 500);

    const res = makeRes();
    await pinHandler(pinReq({ namespace: ns, rows: 1, chain: "aa11bb22" }), res);

    // The pin itself still succeeds — the balance moved correctly.
    assert.equal(res._status, 201);
    assert.equal(
      res._headers["x-ledger-write-failed"], "true",
      "a ledger-write failure on an otherwise-successful charge must be surfaced, not swallowed"
    );

    const after = await balanceLib.readBalance(hash);
    assert.equal(after.balance, 4, "the balance itself is correct even though its own audit record failed to write");
  } finally {
    if (savedPlans === undefined) delete process.env.WITNESS_PLANS;
    else process.env.WITNESS_PLANS = savedPlans;
  }
});
