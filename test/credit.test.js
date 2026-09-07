// test/credit.test.js — api/credit.js: the ADMIN MONEY PATH.
//
// WHY THIS EXISTS. A pre-invite adversarial audit (2026-08-23) found this
// endpoint had no test file at all. It is the path that grants paid credit
// without a card: an auth bypass here is free money, and a broken idempotency
// key is double-crediting a real purchase. Every other surface in this repo had
// coverage; the one that moves value had none.
//
// The endpoint's own header promises three things. This file makes each of them
// observable rather than asserted:
//   1. it FAILS CLOSED when WITNESS_ADMIN_KEY is unset (never silently open)
//   2. it is idempotent on event_id (retry a real purchase, credit it once)
//   3. it grants exactly what the pack catalogue declares
"use strict";

process.env.GITHUB_USAGE_REPO = "test-owner/test-usage";
process.env.GITHUB_PIN_TOKEN = "test-token";

const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const { MockGitHubStore, install } = require("./helpers/mock_store.js");
const { makeReq, makeRes } = require("./helpers/http_mocks.js");
const balance = require("../lib/_balance.js");
const creditHandler = require("../api/credit.js");

const ADMIN = "admin-key-for-tests";

let store;
let restore;
let savedAdmin;

beforeEach(() => {
  store = new MockGitHubStore();
  restore = install(store);
  savedAdmin = process.env.WITNESS_ADMIN_KEY;
  process.env.WITNESS_ADMIN_KEY = ADMIN;
});

afterEach(() => {
  restore();
  if (savedAdmin === undefined) delete process.env.WITNESS_ADMIN_KEY;
  else process.env.WITNESS_ADMIN_KEY = savedAdmin;
});

function call({ auth = `Bearer ${ADMIN}`, body = {}, method = "POST" } = {}) {
  const req = makeReq({ method, headers: auth ? { authorization: auth } : {}, body });
  const res = makeRes();
  return creditHandler(req, res).then(() => res);
}

// ---------------------------------------------------------------------
// AUTH — the part where a mistake is free money
// ---------------------------------------------------------------------

test("FAILS CLOSED: with no WITNESS_ADMIN_KEY configured, every call is refused", async () => {
  delete process.env.WITNESS_ADMIN_KEY;
  const res = await call({ body: { pack: "mini", event_id: "e1", key: "k" } });
  assert.equal(res._status, 500);
  assert.match(res._body.error, /not configured/i);
  // and nothing was credited on the way out
  const bal = await balance.readBalance(balance.keyHash("k"));
  assert.equal(bal.balance, 0, "a disabled endpoint must not credit");
});

test("a wrong admin key is refused", async () => {
  const res = await call({ auth: "Bearer not-the-admin-key",
                           body: { pack: "mini", event_id: "e1", key: "k" } });
  assert.equal(res._status, 401);
  const bal = await balance.readBalance(balance.keyHash("k"));
  assert.equal(bal.balance, 0);
});

test("a missing Authorization header is refused", async () => {
  const res = await call({ auth: null,
                           body: { pack: "mini", event_id: "e1", key: "k" } });
  assert.equal(res._status, 401);
});

test("a key that is a PREFIX of the admin key is refused", async () => {
  // guards the comparison against length-sloppy equality
  const res = await call({ auth: `Bearer ${ADMIN.slice(0, 5)}`,
                           body: { pack: "mini", event_id: "e1", key: "k" } });
  assert.equal(res._status, 401);
});

test("GET is refused even with a valid admin key", async () => {
  const res = await call({ method: "GET", body: {} });
  assert.equal(res._status, 405);
});

// ---------------------------------------------------------------------
// IDEMPOTENCY — the part where a mistake is double-charging a real buyer
// ---------------------------------------------------------------------

test("the same event_id credits ONCE, however many times it is retried", async () => {
  const key = "buyer-key-1";
  const hash = balance.keyHash(key);
  const body = { pack: "mini", event_id: "stripe-evt-abc", key };

  const first = await call({ body });
  assert.equal(first._status, 200);
  assert.equal(first._body.ok, true);
  assert.equal(first._body.already_credited, false);
  const afterFirst = (await balance.readBalance(hash)).balance;
  assert.equal(afterFirst, balance.PACKS.mini.pins);

  for (let i = 0; i < 3; i++) {
    const again = await call({ body });
    assert.equal(again._status, 200);
    assert.equal(again._body.already_credited, true, "retry must be marked");
  }
  const afterRetries = (await balance.readBalance(hash)).balance;
  assert.equal(afterRetries, afterFirst,
    "retrying one purchase changed the balance — that is double-crediting");
});

test("GREEN CONTROL: two DIFFERENT event_ids credit twice", async () => {
  // without this, an endpoint that credited NOTHING would pass the idempotency
  // test above and look correct
  const key = "buyer-key-2";
  const hash = balance.keyHash(key);
  await call({ body: { pack: "mini", event_id: "evt-1", key } });
  await call({ body: { pack: "mini", event_id: "evt-2", key } });
  const bal = (await balance.readBalance(hash)).balance;
  assert.equal(bal, balance.PACKS.mini.pins * 2);
});

test("a missing event_id is refused, so a retry can never be ambiguous", async () => {
  const res = await call({ body: { pack: "mini", key: "k" } });
  assert.equal(res._status, 400);
  assert.match(res._body.error, /event_id/);
});

// ---------------------------------------------------------------------
// WHAT GETS GRANTED — the catalogue is the contract
// ---------------------------------------------------------------------

test("every pack grants exactly the pins the catalogue declares", async () => {
  for (const packId of Object.keys(balance.PACKS)) {
    const key = `catalogue-${packId}`;
    const res = await call({ body: { pack: packId, event_id: `evt-${packId}`, key } });
    assert.equal(res._status, 200, `${packId} should credit`);
    assert.equal(res._body.pins_added, balance.PACKS[packId].pins, packId);
    const bal = (await balance.readBalance(balance.keyHash(key))).balance;
    assert.equal(bal, balance.PACKS[packId].pins, `${packId} stored balance`);
  }
});

test("an unknown pack is refused and credits nothing", async () => {
  const res = await call({ body: { pack: "free-money", event_id: "e", key: "k" } });
  assert.equal(res._status, 400);
  const bal = await balance.readBalance(balance.keyHash("k"));
  assert.equal(bal.balance, 0);
});

test("neither key nor key_hash is refused", async () => {
  const res = await call({ body: { pack: "mini", event_id: "e" } });
  assert.equal(res._status, 400);
  assert.match(res._body.error, /key_hash|key/);
});

test("crediting by key_hash and by raw key reach the same account", async () => {
  const key = "same-account-key";
  const hash = balance.keyHash(key);
  await call({ body: { pack: "mini", event_id: "by-raw", key } });
  await call({ body: { pack: "mini", event_id: "by-hash", key_hash: hash } });
  const bal = (await balance.readBalance(hash)).balance;
  assert.equal(bal, balance.PACKS.mini.pins * 2,
    "raw key and its hash must not resolve to different accounts");
});

// REGRESSION (2026-09-05 audit): a ledger-write failure on an otherwise-
// successful grant must be surfaced in the response, not silently dropped —
// same gap and same fix as pin.test.js's sibling regression for the decrement
// side. The balance moves correctly either way; only the audit trail failed.
test("REGRESSION (2026-09-05): a ledger-write failure on a successful grant is surfaced, not swallowed", async () => {
  const key = "ledger-fail-key";
  const hash = balance.keyHash(key);
  const ledgerPath = balance.ledgerGrantPath(hash, "evt-ledger-fail-1");
  store.forceFailure(process.env.GITHUB_USAGE_REPO, ledgerPath, 1, 500);

  const res = await call({ body: { pack: "mini", event_id: "evt-ledger-fail-1", key } });
  assert.equal(res._status, 200, "the grant itself must still succeed — only its audit record failed");
  assert.equal(res._body.ok, true);
  assert.equal(res._body.ledger_write_failed, true,
    "a ledger-write failure on an otherwise-successful grant must be surfaced, not swallowed");

  const bal = await balance.readBalance(hash);
  assert.equal(bal.balance, balance.PACKS.mini.pins, "the balance itself is correct regardless of the ledger write");
});
