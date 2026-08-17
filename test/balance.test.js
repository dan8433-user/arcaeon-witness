// test/balance.test.js — api/_balance.js: the purchased-credit ledger.
//
// Env vars must be set BEFORE requiring the module under test — _balance.js
// reads GITHUB_USAGE_REPO into a top-level const at require time.
"use strict";

process.env.GITHUB_USAGE_REPO = "test-owner/test-usage";
process.env.GITHUB_PIN_TOKEN = "test-token";

const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const { MockGitHubStore, install } = require("./helpers/mock_store.js");
const balance = require("../api/_balance.js");

const REPO = process.env.GITHUB_USAGE_REPO;

let store;
let restore;

beforeEach(() => {
  store = new MockGitHubStore();
  restore = install(store);
});

afterEach(() => {
  restore();
});

// ---------------------------------------------------------------------
// CONTRACT: pack catalogue grants match PACKS exactly (incl. mini=1000)
// ---------------------------------------------------------------------

test("CONTRACT: creditPack grants exactly the pins each PACKS entry declares", async () => {
  const { PACKS } = balance;
  for (const packId of Object.keys(PACKS)) {
    const hash = balance.keyHash(`pack-catalogue-${packId}`);
    const result = await balance.creditPack(hash, packId, `evt-catalogue-${packId}`, "test");
    assert.equal(result.ok, true, `creditPack(${packId}) should succeed`);
    assert.equal(result.pins, PACKS[packId].pins, `creditPack(${packId}) pins mismatch`);
    const bal = await balance.readBalance(hash);
    assert.equal(bal.balance, PACKS[packId].pins, `stored balance for ${packId} mismatch`);
  }
});

test("CONTRACT: mini pack is 1000 pins (the CEO-ruled entry SKU, kills the $15 wall)", async () => {
  const hash = balance.keyHash("mini-pack-check");
  const result = await balance.creditPack(hash, "mini", "evt-mini-1", "test");
  assert.equal(result.ok, true);
  assert.equal(result.pins, 1000);
  assert.equal(balance.PACKS.mini.price_usd, 5);
});

test("CONTRACT: creditPack refuses an unknown pack id and grants nothing", async () => {
  const hash = balance.keyHash("unknown-pack-check");
  const result = await balance.creditPack(hash, "not-a-real-pack", "evt-unknown-1", "test");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "unknown_pack");
  const bal = await balance.readBalance(hash);
  assert.equal(bal.balance, 0);
  assert.equal(bal.ever_purchased, false);
});

test("CONTRACT: creditPack refuses a missing event id", async () => {
  const hash = balance.keyHash("missing-event-check");
  const result = await balance.creditPack(hash, "mini", undefined, "test");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "missing_event_id");
});

// ---------------------------------------------------------------------
// CONTRACT: insufficient-credit refusal (fails closed)
// ---------------------------------------------------------------------

test("CONTRACT: decrementCredit refuses a key that never purchased (fails closed, not silently free)", async () => {
  const secret = "never-purchased-secret";
  const result = await balance.decrementCredit(secret, "test-spend");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "insufficient_credit");
  assert.equal(result.balance, 0);
  assert.equal(result.ever_purchased, false);
});

test("CONTRACT: decrementCredit refuses once a purchased balance is fully spent", async () => {
  const secret = "spend-to-zero-secret";
  const hash = balance.keyHash(secret);
  await balance.creditPack(hash, "mini", "evt-spend-zero-1", "test"); // 1000 pins

  for (let i = 0; i < 1000; i++) {
    const r = await balance.decrementCredit(secret, "test-spend");
    assert.equal(r.ok, true, `spend #${i + 1} should succeed`);
  }

  const exhausted = await balance.decrementCredit(secret, "test-spend");
  assert.equal(exhausted.ok, false);
  assert.equal(exhausted.reason, "insufficient_credit");
  assert.equal(exhausted.balance, 0);
  // The distinction pin.js's 402-vs-429 choice depends on:
  assert.equal(exhausted.ever_purchased, true, "a spent-out key is NOT the same state as a never-purchased key");
});

// ---------------------------------------------------------------------
// REGRESSION: THE WEEKEND MONEY BUG — applied_events carried through decrement
//
// _balance.js's decrementCredit() rebuilds the balance object on every spend.
// Before the 2026-08-16 fix, that rebuild dropped the `applied_events` set,
// so ANY spend silently wiped the double-credit idempotency guard. A Stripe
// retry delivered AFTER a spend would then see an empty applied_events set,
// conclude the event had never been applied, and re-grant the full pack on
// top of the post-spend balance — the exact mechanism the audit reproduced
// live: "$15 bought 5,999 pins in the mechanical replay."
//
// This is the one regression test that would have caught the bug BEFORE it
// shipped a second time: grant -> spend -> replay the SAME Stripe event.
// ---------------------------------------------------------------------

test("REGRESSION (money bug): grant -> spend -> replay same event_id must be idempotent, not a re-grant", async () => {
  const secret = "money-bug-secret";
  const hash = balance.keyHash(secret);
  const eventId = "evt-money-bug-1";

  const grant = await balance.creditPack(hash, "mini", eventId, "stripe-webhook");
  assert.equal(grant.ok, true);
  assert.equal(grant.already_credited, false);
  assert.equal(grant.balance_after, 1000);

  const spend = await balance.decrementCredit(secret, "pin-consumed");
  assert.equal(spend.ok, true);
  assert.equal(spend.balance, 999);

  // Simulate Stripe's retry of the SAME checkout.session.completed event,
  // arriving AFTER the buyer already spent one pin from the grant.
  const replay = await balance.creditPack(hash, "mini", eventId, "stripe-webhook");
  assert.equal(replay.ok, true);
  assert.equal(
    replay.already_credited,
    true,
    "the replayed event must be recognized as already-applied, not treated as a fresh grant"
  );
  assert.equal(
    replay.balance_after,
    999,
    "THE MONEY BUG: a replay after a spend must not add another 1000 pins on top of the post-spend balance"
  );

  const finalBal = await balance.readBalance(hash);
  assert.equal(
    finalBal.balance,
    999,
    "if decrementCredit ever again drops applied_events on its rebuild, this reads back as 1999 (bug) instead of 999 (correct)"
  );

  // Multiple spends, multiple replays — the guard must hold every time, not
  // just survive one round.
  const spend2 = await balance.decrementCredit(secret, "pin-consumed");
  assert.equal(spend2.balance, 998);
  const replay2 = await balance.creditPack(hash, "mini", eventId, "stripe-webhook");
  assert.equal(replay2.already_credited, true);
  assert.equal(replay2.balance_after, 998);
});

test("REGRESSION (money bug variant): applied_events set itself survives a decrement byte-for-byte", async () => {
  // Direct check on the stored file shape, independent of the behavioral
  // assertion above — proves WHY the bug happened, not just that it doesn't
  // reproduce. If a future edit reintroduces the dropped-field bug, this
  // fails even in a build where the replay-balance assertion above might
  // pass for an unrelated reason.
  const secret = "applied-events-shape-secret";
  const hash = balance.keyHash(secret);
  const eventId = "evt-shape-check-1";

  await balance.creditPack(hash, "starter", eventId, "test");
  const beforeSpend = store.read(REPO, balance.balancePath(hash));
  assert.ok(Array.isArray(beforeSpend.applied_events));
  assert.ok(beforeSpend.applied_events.includes(eventId));

  await balance.decrementCredit(secret, "test-spend");
  const afterSpend = store.read(REPO, balance.balancePath(hash));
  assert.ok(
    Array.isArray(afterSpend.applied_events) && afterSpend.applied_events.includes(eventId),
    "applied_events must survive the decrement rebuild — this is the exact field the 2026-08-16 fix restored"
  );
});

// ---------------------------------------------------------------------
// REGRESSION: the double-grant guard itself (2026-08-14 CAS fix)
// ---------------------------------------------------------------------

test("REGRESSION (double-grant): duplicate delivery of the same event_id grants exactly once", async () => {
  const hash = balance.keyHash("dup-delivery-secret");
  const eventId = "evt-dup-delivery-1";

  const r1 = await balance.creditPack(hash, "starter", eventId, "stripe-webhook");
  const r2 = await balance.creditPack(hash, "starter", eventId, "stripe-webhook");
  const r3 = await balance.creditPack(hash, "starter", eventId, "stripe-webhook");

  assert.equal(r1.already_credited, false);
  assert.equal(r2.already_credited, true);
  assert.equal(r3.already_credited, true);
  assert.equal(r1.balance_after, balance.PACKS.starter.pins);
  assert.equal(r2.balance_after, balance.PACKS.starter.pins);
  assert.equal(r3.balance_after, balance.PACKS.starter.pins);

  const bal = await balance.readBalance(hash);
  assert.equal(bal.balance, balance.PACKS.starter.pins, "three deliveries of one event must credit the pack exactly once");
});

test("REGRESSION (double-grant): the CAS retry survives a forced write conflict without double- or zero-crediting", async () => {
  // Simulates the exact race the audit reproduced: two overlapping deliveries
  // both read the balance file, then one loses the write race. grantCredits'
  // retry loop must re-read, see its own event NOT yet applied on that fresh
  // read (since the OTHER writer's commit is what won), and correctly add
  // once — never twice, never zero.
  const hash = balance.keyHash("cas-race-secret");
  const path = balance.balancePath(hash);
  store.forceConflict(REPO, path, 1); // first PUT attempt 409s

  const result = await balance.grantCredits(hash, 500, "test-pack", "evt-cas-race-1", "test");
  assert.equal(result.ok, true);
  assert.equal(result.balance_after, 500, "exactly one grant's worth of pins after surviving one forced conflict");

  const bal = await balance.readBalance(hash);
  assert.equal(bal.balance, 500);
});

test("REGRESSION (double-grant): two DIFFERENT events for the same key both grant (idempotency is per-event, not per-key)", async () => {
  const hash = balance.keyHash("two-events-secret");
  const r1 = await balance.creditPack(hash, "mini", "evt-two-a", "test");
  const r2 = await balance.creditPack(hash, "mini", "evt-two-b", "test");
  assert.equal(r1.already_credited, false);
  assert.equal(r2.already_credited, false);
  const bal = await balance.readBalance(hash);
  assert.equal(bal.balance, 2000, "two distinct events must both credit — the guard must not be per-key");
});
