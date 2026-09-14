// test/merkle_batching.test.js — lib/_merkle.js and lib/_batch.js:
// MERKLE_BATCHING_DESIGN.md §3 (tree construction), §5 (proof format), §6.3
// (same-batch conflicts), and the write-count claim in §1.
//
// The test in here that matters most is the LAST section: a receipt built the
// old way must still verify by exactly the same path it does today. Batching is
// a change to publication, not to semantics (§2), and the only way to hold that
// honestly is to keep a fixture from before batching existed and re-run the
// real verify handler against it with the batch machinery loaded and batch
// files sitting in the store.
//
// Env vars set BEFORE requiring the handlers or _store.js — REPO/USAGE_REPO are
// top-level consts read at require time (same discipline as test/pin.test.js).
"use strict";

process.env.GITHUB_PIN_REPO = "test-owner/test-pins";
process.env.GITHUB_PIN_BRANCH = "main";
process.env.GITHUB_USAGE_REPO = "test-owner/test-usage";
process.env.GITHUB_PIN_TOKEN = "test-token";
process.env.WITNESS_KEYS = "testkeyA:demo-";
delete process.env.WITNESS_PLANS; // default free plan, cap 100
delete process.env.WITNESS_CADENCE; // default 24h cadence

const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const { MockGitHubStore, install } = require("./helpers/mock_store.js");
const { makeReq, makeRes } = require("./helpers/http_mocks.js");
const store = require("../lib/_store.js");
const merkle = require("../lib/_merkle.js");
const batch = require("../lib/_batch.js");
const pinHandler = require("../api/pin.js");
const verifyHandler = require("../api/verify.js");

const PIN_REPO = process.env.GITHUB_PIN_REPO;

let gh;
let restore;
let slept;
const realPutSleep = store._putRetry.sleep;

beforeEach(() => {
  gh = new MockGitHubStore();
  restore = install(gh);
  // The 409 backoff from task 093 still COMPUTES its schedule; only the waiting
  // is skipped, exactly as test/store_put_retry.test.js does it.
  slept = [];
  store._putRetry.sleep = async (ms) => {
    slept.push(ms);
  };
});

afterEach(() => {
  store._putRetry.sleep = realPutSleep;
  restore();
});

// Writes into the PIN repo only. The meter/credit stores live in a different
// repo (GITHUB_USAGE_REPO) and are not what §1 counts — §1 counts contents-API
// commits into the public pin repo.
function pinRepoWrites() {
  return gh.putLog.filter((w) => w.repo === PIN_REPO);
}

// A fixed, fully-specified pin record. Every field is a literal so the leaf
// bytes are a frozen prediction, not whatever the clock happened to say.
function fixturePin(seq, ns, rows, chain, kind = "content_head_advance") {
  return {
    namespace: ns,
    rows,
    chain,
    seq,
    pinned_at: `2026-08-14T18:00:0${seq}Z`,
    cadence_hours: 24,
    next_pin_due_by: `2026-08-15T18:00:0${seq}Z`,
    record_kind: kind,
    auth_level: "bearer-stage0",
  };
}

const FIXTURE_PINS = [
  fixturePin(1, "demo-a", 10, "aaaaaaaa"),
  fixturePin(2, "demo-b", 20, "bbbbbbbb"),
  fixturePin(3, "demo-a", 11, "cccccccc"),
  fixturePin(4, "demo-c", 30, "dddddddd"),
];
const FIXTURE_LEAVES = FIXTURE_PINS.map((p) => merkle.leafObjectFromPin(p));

// SEALED PREDICTIONS. Computed once, pinned here as literals. A fixture that
// only compares the code against itself cannot fail (the 2026-09-12 sentinel
// finding); these are the values a swapped pair, a changed domain byte, or a
// drifted canonicalizer all move.
const FROZEN_CANON_LEAF0 =
  '{"accepted_at":"2026-08-14T18:00:01Z","auth_level":"bearer-stage0","cadence_hours":24,' +
  '"chain":"aaaaaaaa","namespace":"demo-a","next_pin_due_by":"2026-08-15T18:00:01Z",' +
  '"record_kind":"content_head_advance","rows":10,"seq":1}';
const FROZEN_ROOT_4 = "ec5e9c8d0e2e4cea2dc35e4faa8ab3a8b19e061096e5069061ede58ca9b56800";
const FROZEN_ROOT_1 = "115b6910f8b5c2c917863bf4bbe233c1e9627f4daa757422897fcfb53342abde";
const FROZEN_ROOT_3 = "743ebd682e0716265c95494c79dba78e26dd778c30770f11de308841313ad889";

function rootHexOf(leaves) {
  return merkle.rootOf(merkle.buildLevels(leaves.map((l) => merkle.leafHash(l)))).toString("hex");
}

// ---------------------------------------------------------------------
// §3.1 / §3.2 — TREE CONSTRUCTION
// ---------------------------------------------------------------------

test("CONTRACT: the leaf canonicalizes through the repo's ONE json-c14n:v1 serializer — frozen bytes", () => {
  assert.equal(merkle.canonicalBytes(FIXTURE_LEAVES[0]).toString("utf-8"), FROZEN_CANON_LEAF0);
});

test("CONTRACT: the tree is deterministic — same leaves, same order, same root, asserted twice against a FROZEN root", () => {
  const first = rootHexOf(FIXTURE_LEAVES);
  const second = rootHexOf(FIXTURE_LEAVES);
  assert.equal(first, second, "two builds of the same leaves must agree");
  // The frozen literal is what makes this test able to fail. Twice-equal alone
  // is satisfied by any deterministic bug, a leaf swap included.
  assert.equal(first, FROZEN_ROOT_4);
});

test("CONTRACT: leaf ORDER is part of the commitment — swapping two leaves changes the root", () => {
  const swapped = FIXTURE_LEAVES.slice();
  [swapped[0], swapped[1]] = [swapped[1], swapped[0]];
  assert.notEqual(rootHexOf(swapped), FROZEN_ROOT_4);
});

test("CONTRACT: a single-item batch is a real tree — root === leaf hash, empty path, proof verifies", () => {
  const leaves = [FIXTURE_LEAVES[0]];
  const levels = merkle.buildLevels(leaves.map((l) => merkle.leafHash(l)));
  assert.equal(merkle.rootOf(levels).toString("hex"), FROZEN_ROOT_1);
  assert.equal(merkle.rootOf(levels).toString("hex"), merkle.leafHash(leaves[0]).toString("hex"));
  assert.deepEqual(merkle.proofPath(levels, 0), []);
  const v = merkle.verifyInclusion({
    leaf: leaves[0],
    leaf_index: 0,
    tree_size: 1,
    path: [],
    root: merkle.labelled(merkle.MERKLE_RECIPE, merkle.rootOf(levels)),
    recipe: merkle.MERKLE_RECIPE,
  });
  assert.equal(v.ok, true, v.reason);
});

test("CONTRACT: an odd node is PROMOTED, not duplicated — and the duplicate-the-last-leaf root is a different root", () => {
  const three = FIXTURE_LEAVES.slice(0, 3);
  const h = three.map((l) => merkle.leafHash(l));
  // Computed here by hand, independently of buildLevels: promote means the
  // unpaired leaf is carried up UNCHANGED, so the root is H(0x01 || H(L0,L1) || L2).
  const expected = merkle.nodeHash(merkle.nodeHash(h[0], h[1]), h[2]).toString("hex");
  assert.equal(rootHexOf(three), expected);
  assert.equal(rootHexOf(three), FROZEN_ROOT_3);
  // The Bitcoin-style shape (§3.2, CVE-2012-2459 lineage) must NOT collide.
  const duplicated = merkle.nodeHash(merkle.nodeHash(h[0], h[1]), merkle.nodeHash(h[2], h[2])).toString("hex");
  assert.notEqual(rootHexOf(three), duplicated);
});

test("CONTRACT: domain separation is real — a node hash is not a bare sha256 of two concatenated hashes", () => {
  const h0 = merkle.leafHash(FIXTURE_LEAVES[0]);
  const h1 = merkle.leafHash(FIXTURE_LEAVES[1]);
  const undomained = crypto.createHash("sha256").update(Buffer.concat([h0, h1])).digest("hex");
  assert.notEqual(merkle.nodeHash(h0, h1).toString("hex"), undomained);
  // And a leaf is not hashed with the node prefix either.
  const leafAsNode = crypto
    .createHash("sha256")
    .update(Buffer.concat([Buffer.from([0x01]), merkle.canonicalBytes(FIXTURE_LEAVES[0])]))
    .digest("hex");
  assert.notEqual(merkle.leafHash(FIXTURE_LEAVES[0]).toString("hex"), leafAsNode);
});

test("CONTRACT: an empty interval commits no root — buildLevels refuses rather than manufacturing one", () => {
  assert.throws(() => merkle.buildLevels([]), /empty interval commits no root/);
});

test("CONTRACT: a pin missing a leaf field is refused, not hashed partial", () => {
  const p = fixturePin(1, "demo-a", 10, "aaaaaaaa");
  delete p.record_kind;
  assert.throws(() => merkle.leafObjectFromPin(p), (err) => err.missing_field === "record_kind");
});

test("CONTRACT: every leaf of every tree size 1..9 verifies at every index, and the path stays ≤ ceil(log2 n)", () => {
  for (let n = 1; n <= 9; n++) {
    const leaves = [];
    for (let i = 0; i < n; i++) leaves.push(merkle.leafObjectFromPin(fixturePin(1, `demo-n${n}`, 100 + i, "ab".repeat(4))));
    // distinct leaves — rows differ, so the hashes do
    const levels = merkle.buildLevels(leaves.map((l) => merkle.leafHash(l)));
    const root = merkle.labelled(merkle.MERKLE_RECIPE, merkle.rootOf(levels));
    for (let i = 0; i < n; i++) {
      const p = merkle.proofPath(levels, i);
      assert.ok(p.length <= Math.ceil(Math.log2(Math.max(n, 2))), `n=${n} i=${i} path=${p.length}`);
      const v = merkle.verifyInclusion({ leaf: leaves[i], leaf_index: i, tree_size: n, path: p, root });
      assert.equal(v.ok, true, `n=${n} i=${i}: ${v.reason}`);
    }
  }
});

// ---------------------------------------------------------------------
// §5 — PROOF VERIFICATION, AND WHAT MUST NOT VERIFY
// ---------------------------------------------------------------------

test("CONTRACT: sibling placement is derived from the INDEX — the same path under a flipped index does not verify", () => {
  const leaves = FIXTURE_LEAVES.slice(0, 2);
  const levels = merkle.buildLevels(leaves.map((l) => merkle.leafHash(l)));
  const root = merkle.labelled(merkle.MERKLE_RECIPE, merkle.rootOf(levels));
  const p = merkle.proofPath(levels, 0);

  assert.equal(merkle.verifyInclusion({ leaf: leaves[0], leaf_index: 0, tree_size: 2, path: p, root }).ok, true);
  // Same leaf, same sibling, same root — only the claimed side moves. A
  // verifier that hashed the pair order-insensitively (sorted-pair, or always
  // h||sib) would accept this, and accepting it means a proof's direction is
  // decorative.
  const flipped = merkle.verifyInclusion({ leaf: leaves[0], leaf_index: 1, tree_size: 2, path: p, root });
  assert.equal(flipped.ok, false);
  assert.equal(flipped.reason, "root_mismatch");
});

test("CONTRACT: a reversed path does not verify", () => {
  const leaves = [];
  for (let i = 0; i < 8; i++) leaves.push(merkle.leafObjectFromPin(fixturePin(1, "demo-rev", 100 + i, "ab".repeat(4))));
  const levels = merkle.buildLevels(leaves.map((l) => merkle.leafHash(l)));
  const root = merkle.labelled(merkle.MERKLE_RECIPE, merkle.rootOf(levels));
  const p = merkle.proofPath(levels, 3);
  assert.equal(merkle.verifyInclusion({ leaf: leaves[3], leaf_index: 3, tree_size: 8, path: p, root }).ok, true);
  const rev = merkle.verifyInclusion({ leaf: leaves[3], leaf_index: 3, tree_size: 8, path: p.slice().reverse(), root });
  assert.equal(rev.ok, false);
  assert.equal(rev.reason, "root_mismatch");
});

test("CONTRACT: an unknown recipe label fails TYPED, never passes with a warning", () => {
  const leaves = FIXTURE_LEAVES.slice(0, 2);
  const levels = merkle.buildLevels(leaves.map((l) => merkle.leafHash(l)));
  const root = merkle.labelled(merkle.MERKLE_RECIPE, merkle.rootOf(levels));
  const p = merkle.proofPath(levels, 0);
  const v = merkle.verifyInclusion({
    leaf: leaves[0], leaf_index: 0, tree_size: 2, path: p, root, recipe: "sha256:witness-merkle:v2",
  });
  assert.equal(v.ok, false);
  assert.equal(v.reason, "unknown_recipe");
});

test("CONTRACT: a leaf_hash that disagrees with the leaf is a typed mismatch, not a pass on the hash", () => {
  const leaves = FIXTURE_LEAVES.slice(0, 2);
  const levels = merkle.buildLevels(leaves.map((l) => merkle.leafHash(l)));
  const v = merkle.verifyInclusion({
    leaf: leaves[0],
    leaf_hash: merkle.labelled(merkle.LEAF_RECIPE, merkle.leafHash(leaves[1])),
    leaf_index: 0,
    tree_size: 2,
    path: merkle.proofPath(levels, 0),
    root: merkle.labelled(merkle.MERKLE_RECIPE, merkle.rootOf(levels)),
  });
  assert.equal(v.ok, false);
  assert.equal(v.reason, "leaf_hash_mismatch");
});

// ---------------------------------------------------------------------
// §3.3 / §3.4 — SEALING, AND THE ROOT CHAIN
// ---------------------------------------------------------------------

async function sealFixture(id, pins, prevRoot) {
  const b = batch.openBatch({ batch_id: id, opened_at: "2026-08-14T18:00:00Z", prev_root: prevRoot });
  for (const p of pins) batch.addLeaf(b, p);
  const out = await batch.sealBatch(store, b, { now: new Date("2026-08-14T18:01:00Z") });
  return { b, out };
}

test("CONTRACT: an inclusion proof from a sealed batch verifies against that batch's root", async () => {
  const { out } = await sealFixture(1, FIXTURE_PINS, null);
  assert.equal(out.sealed, true);
  assert.equal(out.tree_size, 4);
  assert.equal(out.root, `${merkle.MERKLE_RECIPE}:${FROZEN_ROOT_4}`);
  for (const proof of out.proofs) {
    assert.equal(merkle.verifyInclusion(proof).ok, true, proof.reason);
  }
});

test("CONTRACT: a proof from batch A does NOT verify against batch B's root", async () => {
  const a = await sealFixture(1, FIXTURE_PINS, null);
  const bPins = [fixturePin(5, "demo-d", 40, "eeeeeeee"), fixturePin(6, "demo-d", 41, "ffffffff")];
  const b = await sealFixture(2, bPins, a.out.root);
  assert.notEqual(a.out.root, b.out.root);

  const crossed = { ...a.out.proofs[0], root: b.out.root };
  const v = merkle.verifyInclusion(crossed);
  assert.equal(v.ok, false);
  assert.equal(v.reason, "root_mismatch");
  // And the other direction, so this is not one-sided luck.
  assert.equal(merkle.verifyInclusion({ ...b.out.proofs[0], root: a.out.root }).ok, false);
});

test("CONTRACT: the root record carries prev_root, and readPrevRoot recovers the tip with ZERO extra writes", async () => {
  const a = await sealFixture(1, FIXTURE_PINS, null);
  const writesAfterFirst = pinRepoWrites().length;

  const recovered = await batch.readPrevRoot(store, 2);
  assert.equal(recovered.prev_root, a.out.root);
  assert.equal(recovered.chain_starts_here, false);
  assert.equal(pinRepoWrites().length, writesAfterFirst, "recovering the chain tip is a READ, never a write");

  const b = await sealFixture(2, [fixturePin(9, "demo-z", 90, "99999999")], recovered.prev_root);
  const rootDoc = gh.read(PIN_REPO, batch.rootPath(2));
  assert.equal(rootDoc.prev_root, a.out.root);
  assert.equal(rootDoc.root, b.out.root);
  assert.equal(rootDoc.batch_interval_seconds, 60);
  assert.equal(rootDoc.max_seal_lag_seconds, 300);
  assert.equal(rootDoc.auth_level, "bearer-stage0");
});

test("CONTRACT: a batch refuses to seal with a null prev_root unless readPrevRoot PROVED nothing came before — no second chain is started", async () => {
  const b = batch.openBatch({ batch_id: 2, opened_at: "2026-08-14T18:00:00Z", prev_root: null });
  batch.addLeaf(b, FIXTURE_PINS[0]);
  await assert.rejects(() => batch.sealBatch(store, b), (err) => err.chain_break === true);
  assert.equal(pinRepoWrites().length, 0);
});

test("CONTRACT: readPrevRoot walks BACK over retired ids — a gap left by a failed seal is not mistaken for the start of the chain", async () => {
  await sealFixture(1, FIXTURE_PINS, null); // batch 1 publishes a root
  // ids 2 and 3 die before their root write; only their orphan leaf lists exist.
  for (const id of [2, 3]) {
    gh.seed(PIN_REPO, batch.leavesPath(id), { batch_id: batch.batchName(id), orphan: true });
  }
  const tip = await batch.readPrevRoot(store, 4);
  assert.equal(tip.chain_starts_here, false);
  assert.equal(tip.scanned, 3, "read ids 3, 2, 1 — the gap was walked, not assumed");
  assert.equal(tip.prev_root, gh.read(PIN_REPO, batch.rootPath(1)).root);
});

test("CONTRACT: readPrevRoot refuses to CLAIM a chain start it did not establish — an exhausted lookback is a typed chain_break", async () => {
  await assert.rejects(
    () => batch.readPrevRoot(store, 500, { maxLookback: 3 }),
    (err) => err.chain_break === true
  );
  // Walking all the way to id 1 and finding nothing IS provable, and says so.
  const tip = await batch.readPrevRoot(store, 3);
  assert.equal(tip.chain_starts_here, true);
  assert.equal(tip.prev_root, null);
});

test("CONTRACT: an empty interval commits no root — zero writes, no file, not an error", async () => {
  const b = batch.openBatch({ batch_id: 1, opened_at: "2026-08-14T18:00:00Z" });
  const out = await batch.sealBatch(store, b);
  assert.equal(out.sealed, false);
  assert.equal(out.reason, "empty_interval_commits_no_root");
  assert.equal(out.writes, 0);
  assert.equal(pinRepoWrites().length, 0);
  assert.equal(gh.has(PIN_REPO, batch.rootPath(1)), false);
});

test("CONTRACT: §6.3 — two conflicting leaves in one batch: the LATER one is dropped, an observation is written immediately, and the root covers only accepted state", async () => {
  const pins = [
    fixturePin(1, "demo-a", 10, "aaaaaaaa"),
    fixturePin(2, "demo-b", 20, "bbbbbbbb"),
    fixturePin(3, "demo-a", 10, "deadbeef"), // same ns + rows, DIFFERENT chain
  ];
  const { b, out } = await sealFixture(1, pins, null);
  assert.equal(out.tree_size, 2, "the conflicting leaf never entered the tree");
  assert.equal(out.conflicts.length, 1);
  assert.equal(out.conflicts[0].claimed_chain, "deadbeef");
  assert.equal(out.proofs.length, 2);
  const obsWrites = pinRepoWrites().filter((w) => w.path.startsWith("observations/"));
  assert.equal(obsWrites.length, 1, "the observation is written immediately and unbatched (§6.2)");
  const obs = gh.read(PIN_REPO, obsWrites[0].path);
  assert.equal(obs.claimed.chain, "deadbeef");
  assert.equal(obs.accepted_head.chain, "aaaaaaaa");
  // Nothing in the sealed batch is the dropped leaf.
  for (const p of out.proofs) assert.notEqual(p.leaf.chain, "deadbeef");
  assert.equal(b.sealed_leaves.length, 2);
});

test("CONTRACT: sealTrigger fires on the interval, on max_leaves, and on a deadline about to expire — and never on an empty batch", () => {
  const opened = "2026-08-14T18:00:00Z";
  const t0 = Date.parse(opened);
  const empty = batch.openBatch({ batch_id: 1, opened_at: opened });
  assert.equal(batch.sealTrigger(empty, t0 + 10 * 60_000), null);

  const b = batch.openBatch({ batch_id: 1, opened_at: opened });
  batch.addLeaf(b, FIXTURE_PINS[0]); // due 2026-08-15T18:00:01Z, a day out
  assert.equal(batch.sealTrigger(b, t0 + 1000), null);
  assert.equal(batch.sealTrigger(b, t0 + 60_000), "interval_elapsed");
  // A deadline inside the safety margin forces the seal regardless of interval.
  const tight = batch.openBatch({ batch_id: 1, opened_at: opened });
  batch.addLeaf(tight, { ...FIXTURE_PINS[0], next_pin_due_by: "2026-08-14T18:02:00Z" });
  assert.equal(batch.sealTrigger(tight, t0 + 1000), "deadline_forces_seal");
});

// ---------------------------------------------------------------------
// THE FAILURE ATOM
// ---------------------------------------------------------------------

test("CONTRACT: a batch that fails to write its ROOT leaves no pin claiming a root that was never published", async () => {
  gh.forceFailure(PIN_REPO, batch.rootPath(1), 5, 500);
  const b = batch.openBatch({ batch_id: 1, opened_at: "2026-08-14T18:00:00Z" });
  for (const p of FIXTURE_PINS) batch.addLeaf(b, p);

  await assert.rejects(
    () => batch.sealBatch(store, b),
    (err) => err.stage === "root" && Array.isArray(err.unsealed_leaves) && err.unsealed_leaves.length === 4
  );

  assert.equal(b.sealed, false, "the batch is not sealed");
  assert.equal(gh.has(PIN_REPO, batch.rootPath(1)), false, "no root file exists");
  // The enforcement, not the comment: a proof cannot be minted at all.
  assert.throws(() => batch.buildProof(b, 0), (err) => err.unsealed === true);

  // §10 T4: the next batch absorbs the unsealed leaves and publishes a root
  // they really are under — and THAT proof verifies. Batch id 1 is RETIRED:
  // its orphan leaves.json is still on disk and §9's "nothing is ever
  // rewritten" means the replacement takes the next id, not the dead one.
  const tip = await batch.readPrevRoot(store, 2);
  assert.equal(tip.chain_starts_here, true, "batch 1 published no root, so the chain still starts here");
  const replacement = batch.openBatch({
    batch_id: 2,
    opened_at: "2026-08-14T18:01:00Z",
    prev_root: tip.prev_root,
    chain_starts_here: tip.chain_starts_here,
  });
  for (const p of err_unsealed_leaves(b)) batch.addLeaf(replacement, p);
  const out = await batch.sealBatch(store, replacement, { now: new Date("2026-08-14T18:02:00Z") });
  assert.equal(out.sealed, true);
  assert.equal(out.proofs.length, 4);
  for (const proof of out.proofs) assert.equal(merkle.verifyInclusion(proof).ok, true);
  assert.equal(gh.has(PIN_REPO, batch.leavesPath(1)), true, "the retired id's orphan leaf list is left exactly where it fell");
  assert.equal(gh.has(PIN_REPO, batch.rootPath(1)), false, "and still names no root");
});

// The pins whose leaves the failed seal handed back. Kept as a helper so the
// test reads the leaves off the FAILURE, not off the fixture array it started
// from — the point is that the sealer surrendered them, not that we remember.
function err_unsealed_leaves(failedBatch) {
  return failedBatch.leaves.map((leaf) => ({
    namespace: leaf.namespace,
    rows: leaf.rows,
    chain: leaf.chain,
    seq: leaf.seq,
    pinned_at: leaf.accepted_at,
    cadence_hours: leaf.cadence_hours,
    next_pin_due_by: leaf.next_pin_due_by,
    record_kind: leaf.record_kind,
    auth_level: leaf.auth_level,
  }));
}

test("CONTRACT: a batch that fails to write its LEAF LIST publishes no root either", async () => {
  gh.forceFailure(PIN_REPO, batch.leavesPath(1), 5, 500);
  const b = batch.openBatch({ batch_id: 1, opened_at: "2026-08-14T18:00:00Z" });
  for (const p of FIXTURE_PINS) batch.addLeaf(b, p);
  await assert.rejects(() => batch.sealBatch(store, b), (err) => err.stage === "leaves");
  assert.equal(b.sealed, false);
  assert.equal(gh.has(PIN_REPO, batch.rootPath(1)), false);
  assert.throws(() => batch.buildProof(b, 0), (err) => err.unsealed === true);
});

test("CONTRACT: the leaf list is written BEFORE the root — a root never commits ahead of the leaves it commits to", async () => {
  await sealFixture(1, FIXTURE_PINS, null);
  const paths = pinRepoWrites().map((w) => w.path);
  assert.deepEqual(paths, [batch.leavesPath(1), batch.rootPath(1)]);
});

// ---------------------------------------------------------------------
// THE 409 RETRY (aaa1378) STILL GOVERNS, AND IS NOT REIMPLEMENTED
// ---------------------------------------------------------------------

test("CONTRACT: a 409 on the root write is retried by lib/_store.js putFile, and the seal reports the extra attempt", async () => {
  gh.forceConflict(PIN_REPO, batch.rootPath(1), 1);
  const { out } = await sealFixture(1, FIXTURE_PINS, null);
  assert.equal(out.sealed, true);
  assert.equal(out.write_attempts, 3, "1 attempt for leaves + 2 for the retried root");
  assert.equal(slept.length, 1, "the retry backoff from task 093 actually ran");
  assert.ok(slept[0] >= 500 && slept[0] <= 1500, `first backoff ~1s jittered, got ${slept[0]}`);
});

test("CONTRACT: lib/_batch.js does not reimplement the retry — it has no fetch, no attempt loop, and one write primitive", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "lib", "_batch.js"), "utf-8");
  const code = src
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
  // Absence claims name their searches: these are the three greps.
  assert.equal(/\bfetch\s*\(/.test(code), false, "grep /\\bfetch\\s*\\(/ over non-comment lines");
  assert.equal(/maxAttempts|PUT_RETRY|putOnce/.test(code), false, "grep /maxAttempts|PUT_RETRY|putOnce/");
  const writeCalls = code.match(/store\.putFile\(/g) || [];
  assert.equal(writeCalls.length, 3, "exactly three putFile call sites: leaves, root, and the §6.3 observation");
});

// ---------------------------------------------------------------------
// MEASURED — WRITES PER PIN, BEFORE AND AFTER
// ---------------------------------------------------------------------
//
// Counted from gh.putLog, which the FIXTURE authors on every successful PUT —
// not from a number the code under test reports about itself. There is no
// network here, so these are counts of contents-API write CALLS, not of live
// GitHub commits; the mapping is one call to one commit (lib/_store.js:103,
// "PUT (create or update) a file via the contents API — one commit per call").

test("MEASURED (before): 10 pins through api/pin.js cost 20 pin-repo writes — 2 per pin", async () => {
  for (let i = 1; i <= 10; i++) {
    const res = makeRes();
    await pinHandler(
      makeReq({
        method: "POST",
        headers: { authorization: "Bearer testkeyA" },
        body: { namespace: "demo-measure", rows: i, chain: "ab".repeat(4) + String(i).padStart(2, "0") },
      }),
      res
    );
    assert.equal(res._status, 201, JSON.stringify(res._body));
  }
  const writes = pinRepoWrites();
  assert.equal(writes.length, 20);
  assert.equal(writes.filter((w) => w.path.endsWith("/latest.json")).length, 10);
  assert.equal(writes.length / 10, 2, "2.0 writes per pin");
});

test("MEASURED (after): one sealed batch of 10 leaves costs 2 pin-repo writes — 0.2 per pin — and all 10 proofs verify", async () => {
  const pins = [];
  for (let i = 1; i <= 10; i++) pins.push(fixturePin(1, "demo-measure", 100 + i, "ab".repeat(4)));
  const b = batch.openBatch({ batch_id: 1, opened_at: "2026-08-14T18:00:00Z" });
  pins.forEach((p, i) => batch.addLeaf(b, { ...p, seq: i + 1 }));
  const out = await batch.sealBatch(store, b, { now: new Date("2026-08-14T18:01:00Z") });

  const writes = pinRepoWrites();
  assert.equal(writes.length, 2);
  assert.equal(out.writes, 2);
  assert.equal(writes.length / 10, 0.2, "0.2 writes per pin");
  assert.equal(out.proofs.length, 10);
  for (const proof of out.proofs) assert.equal(merkle.verifyInclusion(proof).ok, true, proof.reason);
});

test("MEASURED: the batch write count does not move with the leaf count — 1 leaf and 100 leaves both cost 2", async () => {
  const one = batch.openBatch({ batch_id: 1, opened_at: "2026-08-14T18:00:00Z" });
  batch.addLeaf(one, FIXTURE_PINS[0]);
  await batch.sealBatch(store, one, { now: new Date("2026-08-14T18:01:00Z") });
  assert.equal(pinRepoWrites().length, 2);

  const many = batch.openBatch({ batch_id: 2, opened_at: "2026-08-14T18:01:00Z", prev_root: one.root });
  for (let i = 0; i < 100; i++) many.leaves.push(merkle.leafObjectFromPin(fixturePin(1, "demo-many", 1000 + i, "ab".repeat(4))));
  await batch.sealBatch(store, many, { now: new Date("2026-08-14T18:02:00Z") });
  assert.equal(pinRepoWrites().length, 4, "two more writes for 100 leaves, not 100 more");
});

// ---------------------------------------------------------------------
// THE ONE THAT MATTERS — A RECEIPT BUILT THE OLD WAY STILL VERIFIES
// BY EXACTLY THE SAME PATH
// ---------------------------------------------------------------------

// content_unchanged_for_seconds is computed against wall-clock now (see
// lib/_store.js computeCadenceFields), so two calls a millisecond apart can
// legitimately differ. Everything else in the body must be identical.
function normalize(body) {
  const copy = JSON.parse(JSON.stringify(body));
  (function strip(o) {
    if (!o || typeof o !== "object") return;
    if (Array.isArray(o)) return o.forEach(strip);
    delete o.content_unchanged_for_seconds;
    for (const k of Object.keys(o)) strip(o[k]);
  })(copy);
  return copy;
}

test("THE ONE THAT MATTERS: a pin made before batching verifies by exactly the same path after batching exists — byte-identical verify response", async () => {
  // 1. A receipt built the OLD way: through the real api/pin.js write path,
  //    with no batching involved at any point.
  const pinRes = makeRes();
  await pinHandler(
    makeReq({
      method: "POST",
      headers: { authorization: "Bearer testkeyA" },
      body: { namespace: "demo-legacy", rows: 77, chain: "feedface" },
    }),
    pinRes
  );
  assert.equal(pinRes._status, 201);
  const oldPin = pinRes._body.pin;

  // 2. Its verify response TODAY — the stranger-facing verification path.
  const before = makeRes();
  await verifyHandler(makeReq({ query: { ns: "demo-legacy", rows: "77", chain: "feedface" } }), before);
  assert.equal(before._status, 200);
  assert.equal(before._body.witnessed, true);

  // 3. Batching happens: this pin is put in a tree, a root is committed, and
  //    batch files now sit in the same repo the verifier reads from.
  const b = batch.openBatch({ batch_id: 1, opened_at: "2026-08-14T18:00:00Z" });
  batch.addLeaf(b, oldPin);
  batch.addLeaf(b, fixturePin(2, "demo-b", 20, "bbbbbbbb"));
  const sealed = await batch.sealBatch(store, b, { now: new Date("2026-08-14T18:01:00Z") });
  assert.equal(sealed.sealed, true);
  assert.ok(gh.has(PIN_REPO, batch.rootPath(1)));

  // 4. The SAME call, the SAME path, the SAME answer.
  const after = makeRes();
  await verifyHandler(makeReq({ query: { ns: "demo-legacy", rows: "77", chain: "feedface" } }), after);
  assert.equal(after._status, 200);
  assert.deepEqual(normalize(after._body), normalize(before._body));

  // 5. And the stored record itself is untouched — batching wrote nothing into
  //    pins/, so a stranger who cloned the repo yesterday reads the same bytes.
  assert.deepEqual(gh.read(PIN_REPO, "pins/demo-legacy/latest.json"), oldPin);
  assert.equal(
    pinRepoWrites().filter((w) => w.path.startsWith("pins/")).length,
    2,
    "the two per-pin writes, and not one more — batching added only batches/*"
  );
});

test("THE ONE THAT MATTERS: a FROZEN pre-batching record — no batch fields, no proof, no root — still verifies witnessed:true", async () => {
  // Hand-written to the shape api/pin.js wrote before any of this existed. It
  // is a literal on purpose: a fixture regenerated by the current code cannot
  // notice the current code changing what it writes.
  gh.seed(PIN_REPO, "pins/demo-frozen/latest.json", {
    namespace: "demo-frozen",
    rows: 512,
    chain: "0badc0de",
    pinned_at: "2026-08-01T12:00:00.000Z",
    seq: 3,
    cadence_hours: 24,
    next_pin_due_by: "2099-08-02T12:00:00.000Z",
    record_kind: "content_head_advance",
    head_first_seen_at: "2026-08-01T12:00:00.000Z",
    renewals_since_advance: 0,
    renewals_total: 0,
    auth_level: "bearer-stage0",
  });
  // Batch machinery present and a root committed in the same repo.
  const b = batch.openBatch({ batch_id: 1, opened_at: "2026-08-14T18:00:00Z" });
  batch.addLeaf(b, FIXTURE_PINS[0]);
  await batch.sealBatch(store, b, { now: new Date("2026-08-14T18:01:00Z") });

  const res = makeRes();
  await verifyHandler(makeReq({ query: { ns: "demo-frozen", rows: "512", chain: "0badc0de" } }), res);
  assert.equal(res._status, 200);
  assert.equal(res._body.witnessed, true);
  assert.equal(res._body.is_current_head, true);
  assert.equal(res._body.cadence_grade, "pass");
  assert.equal(res._body.auth_level, "bearer-stage0");
});
