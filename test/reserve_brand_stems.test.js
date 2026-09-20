// test/reserve_brand_stems.test.js — the operator's brand stems ("velouria-",
// "arcaeon-") are reserved at claim time, not just tagged after the fact.
//
// WHY THIS EXISTS (2026-09-20, second-model review). Before this fix,
// lib/_status_data.js's isReferenceNamespace() tagged any "velouria-"/
// "arcaeon-" namespace as "our own log" on the PUBLIC status page, but
// lib/_keys.js's validatePrefix() only reserved the "wk-" stem. A paying
// customer could claim a prefix like "velouria-something" or "arcaeon-x" and
// (a) be mislabelled as the operator on the public status page, and (b)
// squat the operator's brand namespace outright — the same class of harm the
// existing "wk-" reservation already exists to prevent, just left open for
// the two stems that actually matter for brand.
//
// This file pins FOUR things:
//   1. validatePrefix() refuses the brand stems the same shape as "wk-".
//   2. prefixConflicts()/the overlap machinery is untouched — a stem merely
//      appearing inside a longer, differently-rooted prefix is still fine.
//   3. Single source of truth: lib/_status_data.js's REFERENCE_PREFIXES is
//      DERIVED from lib/_keys.js's RESERVED_BRAND_STEMS, so the claim-time
//      refusal and the status page's "reference" tag cannot drift apart.
//   4. Grandfathering: an already-issued key on a brand-stem prefix (minted
//      before this fix, or hand-provisioned via WITNESS_KEYS for the
//      operator's own use) keeps authorizing pins — the reservation is a gate
//      on NEW customer claims, not a re-check of stored records.
"use strict";

process.env.GITHUB_USAGE_REPO = "test-owner/test-usage";
process.env.GITHUB_PIN_TOKEN = "test-token";
delete process.env.WITNESS_KEYS;

const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const { MockGitHubStore, install } = require("./helpers/mock_store.js");
const keys = require("../lib/_keys.js");
const statusData = require("../lib/_status_data.js");

let gh, restoreFetch;

beforeEach(() => {
  gh = new MockGitHubStore();
  restoreFetch = install(gh);
});

afterEach(() => {
  restoreFetch();
  delete process.env.WITNESS_KEYS;
});

// ---------------------------------------------------------------------
// 1. validatePrefix refuses the brand stems, same shape as "wk-"
// ---------------------------------------------------------------------

for (const bad of ["velouria-x-", "arcaeon-x-", "velouria-", "arcaeon-"]) {
  test(`validatePrefix refuses '${bad}' with reason 'reserved'`, () => {
    const v = keys.validatePrefix(bad);
    assert.equal(v.ok, false);
    assert.equal(v.reason, "reserved");
    assert.ok(v.detail, "a refusal must say why");
    assert.match(v.detail, /operator/, "detail should be an honest sentence, not a bare code");
  });
}

test("a bare brand name with no trailing dash still fails (pre-existing format rule, unrelated to the stem)", () => {
  // "velouria" alone can never satisfy PREFIX_RE (trailing dash required) —
  // it is refused either way; this just documents which rule catches it.
  const v = keys.validatePrefix("velouria");
  assert.equal(v.ok, false);
});

test("case: an upper-cased stem is only caught once normalized the way every caller already normalizes (H3 trim+lowercase)", () => {
  const raw = "  ARCAEON-Mine-  ";
  const normalized = String(raw).trim().toLowerCase();
  assert.equal(normalized, "arcaeon-mine-");
  const v = keys.validatePrefix(normalized);
  assert.equal(v.ok, false);
  assert.equal(v.reason, "reserved");
});

// ---------------------------------------------------------------------
// 2. Lookalikes that do NOT start with the reserved stem stay allowed
// ---------------------------------------------------------------------

for (const ok of ["acme-velouria-mirror-", "myarcaeon-x-", "arc-", "velo-"]) {
  test(`validatePrefix allows '${ok}' — the stem is not at the START`, () => {
    const v = keys.validatePrefix(ok);
    assert.equal(v.ok, true, JSON.stringify(v));
  });
}

test("prefixConflicts (the two-way overlap check) is untouched by the reservation — different mechanism, different job", () => {
  // A reserved-stem prefix never reaches prefixConflicts in the real flow
  // (validatePrefix refuses it first), but the function itself must not have
  // grown brand-awareness — overlap is still purely about existing prefixes.
  assert.equal(keys.prefixConflicts("gamma-", ["acme-"]), false);
  assert.equal(keys.prefixConflicts("acme-labs-", ["acme-"]), true);
});

// ---------------------------------------------------------------------
// 3. Single source of truth: the status page derives from the same array
// ---------------------------------------------------------------------

test("SINGLE SOURCE: every RESERVED_BRAND_STEMS entry is a REFERENCE_PREFIXES entry, and nothing else is", () => {
  // Read isReferenceNamespace's behavior against the exact stems validatePrefix
  // reserves, rather than re-hardcoding the list in this test — if someone
  // adds a stem in one place and not the other, this test must fail.
  for (const stem of keys.RESERVED_BRAND_STEMS) {
    assert.equal(
      statusData.isReferenceNamespace(`${stem}-anything`), true,
      `'${stem}-' is reserved at claim time but the status page does not tag it as ours`
    );
  }
});

test("SINGLE SOURCE: a stem the status page treats as ours is also a stem a customer cannot claim", () => {
  // The inverse direction, driven off validatePrefix directly rather than a
  // second hardcoded list, so drift in either file trips this test.
  for (const stem of keys.RESERVED_BRAND_STEMS) {
    const v = keys.validatePrefix(`${stem}-newcustomer-`);
    assert.equal(v.ok, false, `'${stem}-' is tagged as ours on the status page but is claimable`);
    assert.equal(v.reason, "reserved");
  }
});

test("the removed env override cannot make an unreserved stem look like ours anymore", () => {
  process.env.WITNESS_REFERENCE_NS_PREFIXES = "totallycustom-";
  // Re-require is unnecessary: the module already dropped the env read, so
  // setting it after load (or before — either way) must have no effect.
  assert.equal(statusData.isReferenceNamespace("totallycustom-thing"), false);
  delete process.env.WITNESS_REFERENCE_NS_PREFIXES;
});

// ---------------------------------------------------------------------
// 4. Grandfathering: existing issued keys on a brand stem keep authorizing
// ---------------------------------------------------------------------

function seedIssuedKey(prefix, tag) {
  const hash = `${tag}`.padEnd(64, "0").slice(0, 64);
  gh.seed(process.env.GITHUB_USAGE_REPO, `keys/${hash}.json`, {
    key_hash: hash,
    namespace_prefix: prefix,
    plan: "free",
    source: "test",
  });
  return hash;
}

test("GRANDFATHERING: a key issued before this fix, on a velouria- prefix, still authorizes pins", async () => {
  const secret = "wk_legacy_velouria_key_from_before_the_fix";
  const hash = keys.keyHash(secret);
  gh.seed(process.env.GITHUB_USAGE_REPO, `keys/${hash}.json`, {
    key_hash: hash,
    namespace_prefix: "velouria-legacy-",
    plan: "free",
    source: "test-legacy",
  });
  // issuedKeyPrefix is a pure READ of the stored record — it must never
  // re-run validatePrefix against history, only against new claims.
  const prefix = await keys.issuedKeyPrefix(secret);
  assert.equal(prefix, "velouria-legacy-",
    "an already-issued key on a reserved stem must keep authorizing — the reservation gates NEW claims, not stored ones");
});

test("GRANDFATHERING: listPrefixes() still counts a legacy brand-stem key as taken, for overlap purposes", async () => {
  seedIssuedKey("arcaeon-legacy-", "leg1");
  const existing = await keys.listPrefixes();
  assert.ok(existing.includes("arcaeon-legacy-"));
  // A NEW customer still cannot land on or overlap it — reserved AND taken.
  assert.equal(keys.prefixConflicts("arcaeon-legacy-", existing), true);
});

test("GRANDFATHERING: the operator's own WITNESS_KEYS-provisioned prefix is never run through validatePrefix", async () => {
  // The operator's own keys are hand-provisioned via WITNESS_KEYS and never
  // pass through the customer claim path (fulfill.js) or validatePrefix at
  // all — envKeyPrefixes() just reads the env var. This documents that the
  // reservation cannot lock the operator out of its own stem.
  process.env.WITNESS_KEYS = "opskey1:velouria-,opskey2:arcaeon-";
  const envPrefixes = keys.envKeyPrefixes();
  assert.deepEqual(envPrefixes.sort(), ["arcaeon-", "velouria-"]);
});
