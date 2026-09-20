// test/sealer_concurrency.test.js — the two gaps the 2026-09-20 second-lineage
// audit named as must-close before WITNESS_BATCH_SHADOW is ever turned on:
//
//   (1) nothing stopped two sealers from running at once (audit finding #14),
//   (2) nothing checked for a committed pin whose leaf is in no batch and no
//       longer pending, nor for the mirror — a leaf carried by two batches
//       (audit finding #16, and the check §9 Phase 1 already promised when it
//       said "run it until a full week reconciles clean").
//
// What the code ALREADY guaranteed, and is not re-litigated here (it is covered
// in test/sealer.test.js "THE BOUNDARY" and "THE ATOM"): the close CAS
// partitions the LEAF SET exactly, and the root write is the publication atom.
// The gap was never the leaf set. It was that two sealers could both take a
// turn at sealing the same set.
//
// Env BEFORE any require — same discipline as the sibling sealer tests.
"use strict";

process.env.GITHUB_PIN_REPO = "test-owner/test-pins";
process.env.GITHUB_PIN_BRANCH = "main";
process.env.GITHUB_USAGE_REPO = "test-owner/test-usage";
process.env.GITHUB_PIN_TOKEN = "test-token";
process.env.WITNESS_KEYS = "testkeyA:demo-";
process.env.WITNESS_BATCH_SHADOW = "on";
delete process.env.WITNESS_PLANS;
delete process.env.WITNESS_CADENCE;

const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const { MockGitHubStore, install } = require("./helpers/mock_store.js");
const { makeReq, makeRes } = require("./helpers/http_mocks.js");
const store = require("../lib/_store.js");
const merkle = require("../lib/_merkle.js");
const batch = require("../lib/_batch.js");
const pending = require("../lib/_pending.js");
const claim = require("../lib/_claim.js");
const sealer = require("../lib/_sealer.js");
const pinHandler = require("../api/pin.js");
const verifyHandler = require("../api/verify.js");
const reconciler = require("../tools/reconcile_batches.js");

const PIN_REPO = process.env.GITHUB_PIN_REPO;
const USAGE_REPO = process.env.GITHUB_USAGE_REPO;

let gh;
let restore;
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

function pinRepoWrites() {
  return gh.putLog.filter((w) => w.repo === PIN_REPO);
}
function usageRepoWrites() {
  return gh.putLog.filter((w) => w.repo === USAGE_REPO);
}
function readPendingDoc() {
  return gh.read(USAGE_REPO, pending.PENDING_PATH);
}
function readClaimDoc() {
  return gh.read(USAGE_REPO, claim.CLAIM_PATH);
}
function seedPending(state) {
  gh.seed(USAGE_REPO, pending.PENDING_PATH, state);
}

function leafFixture(ns, rows, chain, seq, dueBy = "2099-01-01T00:00:00.000Z") {
  return {
    namespace: ns,
    rows,
    chain,
    seq,
    accepted_at: "2026-08-14T18:00:00.000Z",
    cadence_hours: 24,
    next_pin_due_by: dueBy,
    record_kind: "advance",
    auth_level: "bearer-stage0",
  };
}

async function postPin(ns, rows, chain, extra = {}) {
  const res = makeRes();
  await pinHandler(
    makeReq({
      method: "POST",
      headers: { authorization: "Bearer testkeyA" },
      body: { namespace: ns, rows, chain, ...extra },
    }),
    res
  );
  return res;
}

// A clock that starts at `startIso` and jumps `stepSeconds` on every reading
// after the first. The lease runs on wall time, so this is how a test says
// "this sealer was slow" without sleeping.
function steppingClock(startIso, stepSeconds) {
  const base = Date.parse(startIso);
  let n = 0;
  return () => new Date(base + (n++ === 0 ? 0 : stepSeconds * 1000));
}
function fixedClock(iso) {
  return () => new Date(iso);
}

// Every leaf identity published anywhere in the pin repo, across all batches.
function publishedLeafIdentities() {
  const out = [];
  for (const [path] of gh.repos.get(PIN_REPO) || new Map()) {
    const m = /^batches\/(\d+)\/leaves\.json$/.exec(path);
    if (!m) continue;
    if (!gh.has(PIN_REPO, `batches/${m[1]}/root.json`)) continue; // orphan claims nothing
    for (const leaf of gh.read(PIN_REPO, path).leaves) {
      out.push(`${leaf.namespace}|${leaf.rows}|${String(leaf.chain).toLowerCase()}|${leaf.seq}`);
    }
  }
  return out;
}

// ===========================================================================
// A. ONE SEALER AT A TIME
// ===========================================================================

test("THE GAP, CLOSED: two sealers running at once never publish the same leaf under two roots", async () => {
  // The interleaving traced in lib/_claim.js's header, driven for real: sealer
  // A is stalled at the instant before its root write, and sealer B runs to
  // completion while A holds still. Against the pre-claim code B carried A's
  // leaves into its own batch and both published — every leaf in two roots.
  seedPending({
    ...pending.initialState(new Date("2026-08-14T18:00:00Z")),
    open: {
      batch_id: 1,
      opened_at: "2026-08-14T18:00:00.000Z",
      leaves: [leafFixture("demo-a", 10, "aaaaaaaa", 1), leafFixture("demo-b", 20, "bbbbbbbb", 1)],
    },
  });

  let reachedGate;
  const atGate = new Promise((r) => (reachedGate = r));
  let openGate;
  const gate = new Promise((r) => (openGate = r));

  const inner = global.fetch;
  let armed = true;
  global.fetch = async (url, opts) => {
    const u = new URL(String(url));
    const method = (opts && opts.method) || "GET";
    if (armed && method === "PUT" && u.pathname === `/repos/${PIN_REPO}/contents/${batch.rootPath(1)}`) {
      armed = false;
      reachedGate();
      await gate; // A is suspended one write short of publishing root 1
    }
    return inner(url, opts);
  };

  const aRun = sealer.sealOnce({
    now: new Date("2026-08-14T18:01:00Z"),
    claimClock: fixedClock("2026-08-14T18:01:00Z"),
  });
  await atGate;

  const b = await sealer.sealOnce({
    now: new Date("2026-08-14T18:01:05Z"),
    claimClock: fixedClock("2026-08-14T18:01:05Z"),
  });

  openGate();
  const a = await aRun;
  global.fetch = inner;

  assert.equal(a.sealed, true, "the sealer that took the claim finishes its seal");
  assert.equal(b.sealed, false, "the second sealer does not seal");
  assert.equal(b.refused, true);
  assert.equal(b.reason, "seal_claim_held");
  assert.equal(b.held_by, a.claim.holder, "and it names who is holding");

  // The property, asserted on the public record rather than on our word:
  const ids = publishedLeafIdentities();
  assert.equal(ids.length, 2);
  assert.equal(new Set(ids).size, ids.length, "no leaf identity is carried by two published batches");

  // And the second sealer wrote nothing at all into the public repo.
  assert.equal(pinRepoWrites().filter((w) => w.path.startsWith("batches/")).length, 2, "one leaves.json, one root.json — one batch");
});

test("TWO IN THE SAME SECOND: the loser is refused by name, writes nothing to the pin repo, and does not move the pending document", async () => {
  seedPending({
    ...pending.initialState(new Date("2026-08-14T18:00:00Z")),
    open: { batch_id: 1, opened_at: "2026-08-14T18:00:00.000Z", leaves: [leafFixture("demo-a", 10, "aaaaaaaa", 1)] },
  });
  // First sealer takes the claim and, for this test, never gives it back.
  const held = await claim.acquire({ now: new Date("2026-08-14T18:01:00Z"), ttlSeconds: 120 });
  assert.equal(held.ok, true);

  const before = readPendingDoc();
  const r = await sealer.sealOnce({
    now: new Date("2026-08-14T18:01:00Z"),
    claimClock: fixedClock("2026-08-14T18:01:00Z"),
  });

  assert.equal(r.refused, true);
  assert.equal(r.reason, "seal_claim_held");
  assert.equal(r.trigger, "interval_elapsed", "the trigger HAD fired — it was the claim that stopped it, and the receipt says so");
  assert.equal(pinRepoWrites().length, 0);
  assert.deepEqual(readPendingDoc(), before, "the open batch is untouched and intact for the holder");
});

test("A CRASHED SEALER DOES NOT WEDGE THE QUEUE: an EXPIRED claim is taken over, and the takeover is legible in the file", async () => {
  // The crash-after-claiming-before-the-close case: a claim left behind by a
  // process that died, with nothing else moved.
  gh.seed(USAGE_REPO, claim.CLAIM_PATH, {
    holder: "deadbeefdeadbeef",
    runner: "some-box:999",
    state: "held",
    acquired_at: "2026-08-14T17:58:00.000Z",
    expires_at: "2026-08-14T18:00:00.000Z",
    ttl_seconds: 120,
    scope: null,
  });
  seedPending({
    ...pending.initialState(new Date("2026-08-14T18:00:00Z")),
    open: { batch_id: 1, opened_at: "2026-08-14T18:00:00.000Z", leaves: [leafFixture("demo-a", 10, "aaaaaaaa", 1)] },
  });

  const r = await sealer.sealOnce({
    now: new Date("2026-08-14T18:01:00Z"),
    claimClock: fixedClock("2026-08-14T18:01:00Z"),
  });
  assert.equal(r.sealed, true, "an expired claim is not a wedge");
  assert.equal(r.claim.took_over, true);
  const doc = readClaimDoc();
  assert.equal(doc.took_over.holder, "deadbeefdeadbeef");
  assert.equal(doc.took_over.reason, "expired");
});

test("A LIVE claim is NOT takeable, however much the taker would like it to be", async () => {
  gh.seed(USAGE_REPO, claim.CLAIM_PATH, {
    holder: "aliveaaaaaaaaaaa",
    state: "held",
    acquired_at: "2026-08-14T18:00:00.000Z",
    expires_at: "2026-08-14T18:02:00.000Z",
    ttl_seconds: 120,
  });
  const r = await claim.acquire({ now: new Date("2026-08-14T18:01:00Z") });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "seal_claim_held");
  assert.equal(r.held_by, "aliveaaaaaaaaaaa");
  assert.equal(usageRepoWrites().length, 0, "a refused acquire writes nothing");
  assert.equal(readClaimDoc().holder, "aliveaaaaaaaaaaa", "and does not touch the holder's claim");
});

test("A RELEASED claim is takeable immediately — the next scheduled run does not wait out a TTL it does not need to", async () => {
  gh.seed(USAGE_REPO, claim.CLAIM_PATH, {
    holder: "previousholder00",
    state: "released",
    acquired_at: "2026-08-14T18:00:00.000Z",
    expires_at: "2026-08-14T18:02:00.000Z",
    released_at: "2026-08-14T18:00:30.000Z",
  });
  const r = await claim.acquire({ now: new Date("2026-08-14T18:00:45Z") });
  assert.equal(r.ok, true, "released is takeable even though the expiry has not passed");
  assert.equal(r.claim.took_over.reason, "released");
});

test("A SLOW SEALER whose claim expires mid-run detects it BEFORE the root write and aborts without damage", async () => {
  seedPending({
    ...pending.initialState(new Date("2026-08-14T18:00:00Z")),
    open: { batch_id: 1, opened_at: "2026-08-14T18:00:00.000Z", leaves: [leafFixture("demo-a", 10, "aaaaaaaa", 1)] },
  });

  // Reading 1 acquires at 18:01:00 with a 60s lease; every later reading is an
  // hour on. The run is, by its own lease, long dead by the time it reaches the
  // gate before the root write.
  const r = await sealer.sealOnce({
    now: new Date("2026-08-14T18:01:00Z"),
    claimTtlSeconds: 60,
    claimClock: steppingClock("2026-08-14T18:01:00Z", 3600),
  });

  assert.equal(r.sealed, false);
  assert.equal(r.refused, true);
  assert.equal(r.reason, "claim_lost_before_root");
  assert.equal(r.claim_reason, "expired");
  assert.equal(r.writes, 1, "the orphan leaf list is counted honestly, not rounded down to zero");

  // NO DAMAGE, in the three places damage would show:
  assert.equal(gh.has(PIN_REPO, batch.rootPath(1)), false, "no root was published");
  const doc = readPendingDoc();
  assert.equal(doc.sealing.batch_id, 1, "the leaves are held in the sealing slot");
  assert.equal(doc.sealing.leaves.length, 1, "and none of them was dropped");

  // The orphan leaf list is written and is inert — nothing cites it, and the
  // next run consumes a NEW id rather than rewriting this one.
  assert.equal(gh.has(PIN_REPO, batch.leavesPath(1)), true);

  // The next run picks the leaves up and seals them under a new id.
  const second = await sealer.sealOnce({
    now: new Date("2026-08-14T18:05:00Z"),
    claimClock: fixedClock("2026-08-14T18:05:00Z"),
  });
  assert.equal(second.sealed, true);
  assert.equal(second.batch_id, batch.batchName(2), "a consumed id is never reused");
  assert.equal(second.tree_size, 1);
  const ids = publishedLeafIdentities();
  assert.equal(new Set(ids).size, ids.length, "and still no leaf is carried twice");
});

test("FAIL CLOSED: a claim store that cannot be READ refuses the seal — an unknown door is not an open door", async () => {
  seedPending({
    ...pending.initialState(new Date("2026-08-14T18:00:00Z")),
    open: { batch_id: 1, opened_at: "2026-08-14T18:00:00.000Z", leaves: [leafFixture("demo-a", 10, "aaaaaaaa", 1)] },
  });
  const inner = global.fetch;
  global.fetch = async (url, opts) => {
    const u = new URL(String(url));
    if (u.pathname === `/repos/${USAGE_REPO}/contents/${claim.CLAIM_PATH}` && ((opts && opts.method) || "GET") === "GET") {
      return { status: 500, ok: false, json: async () => ({}), text: async () => "boom" };
    }
    return inner(url, opts);
  };
  const r = await sealer.sealOnce({
    now: new Date("2026-08-14T18:01:00Z"),
    claimClock: fixedClock("2026-08-14T18:01:00Z"),
  });
  global.fetch = inner;

  assert.equal(r.refused, true);
  assert.equal(r.reason, "claim_store_unreadable");
  assert.equal(pinRepoWrites().length, 0);
  assert.equal(readPendingDoc().sealing, null, "the batch was never closed");
});

test("FAIL CLOSED: a corrupt claim (unparseable expiry) holds the door rather than opening it to two sealers", async () => {
  gh.seed(USAGE_REPO, claim.CLAIM_PATH, { holder: "corrupt000000000", state: "held", expires_at: "not-a-date" });
  const r = await claim.acquire({ now: new Date("2026-08-14T18:01:00Z") });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "seal_claim_held");
  // The cost of this choice, stated: a human clears the file. The cost of the
  // other choice is two roots over one leaf, published.
});

test("A 409 ON THE CLAIM WRITE is re-read, not guessed — branch-ref contention is not a lost race", async () => {
  // lib/_store.js measured 465 409s out of 532 writes that raced NOTHING. A
  // claim that read a 409 as "somebody beat me" would refuse to seal most of
  // the time, for no reason at all.
  gh.forceConflict(USAGE_REPO, claim.CLAIM_PATH, 1);
  const r = await claim.acquire({ now: new Date("2026-08-14T18:01:00Z") });
  assert.equal(r.ok, true, "the re-read found no claim, so the write was retried and won");
  assert.equal(readClaimDoc().holder, r.holder);
});

test("A 409 THAT WAS a lost race IS a lost race — the re-read finds the winner and the acquire refuses", async () => {
  // Same 409 shape as the test above; the difference is only what the re-read
  // sees, which is the whole point of re-reading instead of guessing.
  const inner = global.fetch;
  let armed = true;
  global.fetch = async (url, opts) => {
    const u = new URL(String(url));
    const method = (opts && opts.method) || "GET";
    if (armed && method === "PUT" && u.pathname === `/repos/${USAGE_REPO}/contents/${claim.CLAIM_PATH}`) {
      armed = false;
      // Another sealer's claim lands in the same instant.
      gh.seed(USAGE_REPO, claim.CLAIM_PATH, {
        holder: "thewinner0000000",
        state: "held",
        acquired_at: "2026-08-14T18:01:00.000Z",
        expires_at: "2026-08-14T18:03:00.000Z",
      });
      return { status: 409, ok: false, json: async () => ({}), text: async () => "conflict" };
    }
    return inner(url, opts);
  };
  const r = await claim.acquire({ now: new Date("2026-08-14T18:01:00Z") });
  global.fetch = inner;

  assert.equal(r.ok, false);
  assert.equal(r.reason, "seal_claim_held");
  assert.equal(r.held_by, "thewinner0000000");
  assert.equal(readClaimDoc().holder, "thewinner0000000", "the winner's claim was never overwritten");
});

test("AN IDLE RUN TAKES NO CLAIM: a trigger that has not fired writes nothing, not even a lease", async () => {
  seedPending({
    ...pending.initialState(new Date("2026-08-14T18:00:00Z")),
    open: { batch_id: 1, opened_at: "2026-08-14T18:00:00.000Z", leaves: [leafFixture("demo-a", 10, "aaaaaaaa", 1)] },
  });
  const r = await sealer.sealOnce({
    now: new Date("2026-08-14T18:00:10Z"),
    claimClock: fixedClock("2026-08-14T18:00:10Z"),
  });
  assert.equal(r.reason, "trigger_not_fired");
  assert.equal(gh.putLog.length, 0, "a scheduler polling every 60s must not cost a write per poll");
  assert.equal(gh.has(USAGE_REPO, claim.CLAIM_PATH), false);
});

test("A SUCCESSFUL SEAL RELEASES the claim, so the next run starts immediately instead of waiting out the lease", async () => {
  seedPending({
    ...pending.initialState(new Date("2026-08-14T18:00:00Z")),
    open: { batch_id: 1, opened_at: "2026-08-14T18:00:00.000Z", leaves: [leafFixture("demo-a", 10, "aaaaaaaa", 1)] },
  });
  const r = await sealer.sealOnce({
    now: new Date("2026-08-14T18:01:00Z"),
    claimClock: fixedClock("2026-08-14T18:01:00Z"),
  });
  assert.equal(r.sealed, true);
  assert.equal(r.claim.released, true);
  assert.equal(readClaimDoc().state, "released");
  assert.equal(readClaimDoc().outcome, "sealed");

  // A second pin, a second interval, a second seal — no waiting.
  await postPin("demo-c", 30, "cccccccc");
  const second = await sealer.sealOnce({
    now: new Date("2026-08-14T18:02:10Z"),
    claimClock: fixedClock("2026-08-14T18:01:30Z"), // well inside the first lease's TTL
  });
  assert.equal(second.sealed, true);
});

test("THE CLAIM NAMES WHAT IT IS SEALING — the leaf set, not just 'busy'", async () => {
  const leaves = [leafFixture("demo-a", 10, "aaaaaaaa", 1), leafFixture("demo-b", 20, "bbbbbbbb", 1)];
  seedPending({
    ...pending.initialState(new Date("2026-08-14T18:00:00Z")),
    open: { batch_id: 7, opened_at: "2026-08-14T18:00:00.000Z", leaves },
  });
  gh.seed(PIN_REPO, batch.rootPath(6), { batch_id: "000000006", root: "sha256:witness-merkle:v1:" + "ab".repeat(32) });

  const inner = global.fetch;
  let seen = null;
  global.fetch = async (url, opts) => {
    const u = new URL(String(url));
    if (((opts && opts.method) || "GET") === "PUT" && u.pathname === `/repos/${PIN_REPO}/contents/${batch.rootPath(7)}`) {
      seen = readClaimDoc(); // read the live claim at the moment of the atom
    }
    return inner(url, opts);
  };
  await sealer.sealOnce({ now: new Date("2026-08-14T18:01:00Z"), claimClock: fixedClock("2026-08-14T18:01:00Z") });
  global.fetch = inner;

  assert.ok(seen, "the claim exists while the root is being written");
  assert.equal(seen.state, "held");
  assert.equal(seen.scope.batch_id, "000000007");
  assert.equal(seen.scope.leaf_count, 2);
  assert.equal(seen.scope.leaves_digest, claim.scopeDigest(leaves), "and the digest names THOSE leaves");
});

test("A CRASH AFTER the root write but BEFORE clearing pending: the takeover resolves against the public record and re-seals nothing", async () => {
  // Batch 1's root IS published; the sealing slot was never cleared; the dead
  // sealer's claim is still sitting there, expired.
  const leaves = [leafFixture("demo-a", 10, "aaaaaaaa", 1)];
  const hashes = leaves.map((l) => merkle.leafHash(l));
  const root = merkle.labelled(merkle.MERKLE_RECIPE, merkle.rootOf(merkle.buildLevels(hashes)));
  gh.seed(PIN_REPO, batch.leavesPath(1), { batch_id: "000000001", tree_size: 1, root, leaves, leaf_hashes: hashes.map((h) => h.toString("hex")) });
  gh.seed(PIN_REPO, batch.rootPath(1), { batch_id: "000000001", root, prev_root: null, tree_size: 1, opened_at: "2026-08-14T18:00:00.000Z" });
  gh.seed(USAGE_REPO, claim.CLAIM_PATH, { holder: "deadsealer000000", state: "held", expires_at: "2026-08-14T18:00:30.000Z" });
  seedPending({
    ...pending.initialState(new Date("2026-08-14T18:00:00Z")),
    open: { batch_id: 2, opened_at: "2026-08-14T18:01:00.000Z", leaves: [leafFixture("demo-b", 20, "bbbbbbbb", 1)] },
    sealing: { batch_id: 1, opened_at: "2026-08-14T18:00:00.000Z", leaves },
  });

  const r = await sealer.sealOnce({
    now: new Date("2026-08-14T18:02:00Z"),
    claimClock: fixedClock("2026-08-14T18:02:00Z"),
  });
  assert.equal(r.sealed, true);
  assert.equal(r.batch_id, batch.batchName(2));
  assert.equal(r.tree_size, 1, "batch 1's already-published leaf was NOT carried into batch 2");
  const ids = publishedLeafIdentities();
  assert.equal(new Set(ids).size, ids.length, "no leaf is published twice");
});

// ===========================================================================
// B. THE RECONCILER
// ===========================================================================

// Seal a real batch out of real pins, so the reconciler is reading the shape
// the sealer actually writes rather than one this test invented.
//
// The batch clock has to be REAL here, not a fixture date: api/pin.js stamps
// `opened_at` from its own clock, so an interval measured against a 2026-08-14
// literal would never elapse. The sections above seed the pending document by
// hand and can therefore pick their own dates; these cannot.
async function sealRealBatch(namespaces, offsetMinutes = 2) {
  for (const [ns, rows, chain] of namespaces) await postPin(ns, rows, chain);
  const at = new Date(Date.now() + offsetMinutes * 60000);
  return sealer.sealOnce({ now: at, claimClock: () => new Date() });
}

test("RECONCILE: a healthy witness reconciles CLEAN, exit 0, and writes absolutely nothing", async () => {
  const r1 = await sealRealBatch([["demo-a", 10, "aaaaaaaa"], ["demo-b", 20, "bbbbbbbb"]]);
  assert.equal(r1.sealed, true);

  const writesBefore = gh.putLog.length;
  const out = await reconciler.reconcile({ since: "2000-01-01T00:00:00Z" });

  assert.equal(out.verdict, "CLEAN", JSON.stringify(out.findings));
  assert.equal(out.exit_code, 0);
  assert.equal(out.findings.length, 0);
  assert.equal(out.could_not_look.length, 0);
  assert.equal(out.counts.pins_in_scope, 2);
  assert.equal(out.counts.leaves_in_batches, 2);
  assert.equal(gh.putLog.length, writesBefore, "READ ONLY — not one write");
});

test("RECONCILE: a LOST leaf — a committed pin in no batch and not pending — is found and named with its path", async () => {
  // The audit's finding #16 shape, produced the way it really happens: the
  // pending store drops the leaf (recordAcceptedSafe never fails a pin), so the
  // record is publicly committed and no tree ever covers it.
  await postPin("demo-a", 10, "aaaaaaaa");

  const inner = global.fetch;
  global.fetch = async (url, opts) => {
    const u = new URL(String(url));
    if (u.pathname === `/repos/${USAGE_REPO}/contents/${pending.PENDING_PATH}` && ((opts && opts.method) || "GET") === "PUT") {
      return { status: 500, ok: false, json: async () => ({}), text: async () => "pending store down" };
    }
    return inner(url, opts);
  };
  const dropped = await postPin("demo-b", 20, "bbbbbbbb");
  global.fetch = inner;
  assert.equal(dropped._status, 201, "the pin itself succeeded — that is the design, and it is why this gap is invisible without a reconciler");

  const at = new Date(Date.now() + 120000);
  await sealer.sealOnce({ now: at, claimClock: () => new Date() });

  const out = await reconciler.reconcile({ since: "2000-01-01T00:00:00Z" });
  assert.equal(out.verdict, "FINDINGS");
  assert.equal(out.exit_code, 1);
  const lost = out.findings.filter((f) => f.kind === "lost");
  assert.equal(lost.length, 1);
  assert.match(lost[0].path, /^pins\/demo-b\/\d+\.json$/);
  assert.match(lost[0].detail, /demo-b\|20\|bbbbbbbb\|1/);
});

test("RECONCILE: a pin still WAITING in the pending document is not lost, and is not reported as such", async () => {
  await postPin("demo-a", 10, "aaaaaaaa"); // sealed below
  const at = new Date(Date.now() + 120000);
  await sealer.sealOnce({ now: at, claimClock: () => new Date() });
  await postPin("demo-b", 20, "bbbbbbbb"); // still in the open batch

  const out = await reconciler.reconcile({ since: "2000-01-01T00:00:00Z" });
  assert.equal(out.verdict, "CLEAN", JSON.stringify(out.findings));
  assert.equal(out.counts.pending_leaves, 1);
});

test("RECONCILE: the MIRROR — a leaf carried by two batches — is found, which is what makes the claim's honesty checkable", async () => {
  await sealRealBatch([["demo-a", 10, "aaaaaaaa"]]);
  // Hand-forge the double-seal the claim is there to prevent: batch 2 carries
  // batch 1's leaf as well as its own.
  const b1 = gh.read(PIN_REPO, batch.leavesPath(1));
  const leaves = b1.leaves.concat([leafFixture("demo-c", 30, "cccccccc", 1)]);
  const hashes = leaves.map((l) => merkle.leafHash(l));
  const root = merkle.labelled(merkle.MERKLE_RECIPE, merkle.rootOf(merkle.buildLevels(hashes)));
  gh.seed(PIN_REPO, batch.leavesPath(2), { batch_id: "000000002", tree_size: 2, root, leaves, leaf_hashes: hashes.map((h) => h.toString("hex")) });
  gh.seed(PIN_REPO, batch.rootPath(2), { batch_id: "000000002", root, prev_root: b1.root, tree_size: 2, opened_at: "2026-08-14T18:02:00.000Z" });

  const out = await reconciler.reconcile({ since: "2000-01-01T00:00:00Z" });
  assert.equal(out.verdict, "FINDINGS");
  const dup = out.findings.filter((f) => f.kind === "duplicated");
  assert.equal(dup.length, 1);
  assert.match(dup[0].detail, /000000001, 000000002/);
});

test("RECONCILE: a batch whose published leaves do not hash to its published root is found", async () => {
  await sealRealBatch([["demo-a", 10, "aaaaaaaa"], ["demo-b", 20, "bbbbbbbb"]]);
  const doc = gh.read(PIN_REPO, batch.leavesPath(1));
  doc.leaves[0].rows = 999999; // the leaf list is edited; the root is not
  gh.seed(PIN_REPO, batch.leavesPath(1), doc);

  const out = await reconciler.reconcile({ since: "2000-01-01T00:00:00Z" });
  assert.equal(out.verdict, "FINDINGS");
  assert.equal(out.exit_code, 1);
  const mismatch = out.findings.filter((f) => f.kind === "root_mismatch");
  assert.ok(mismatch.length >= 1);
  assert.equal(mismatch[0].path, batch.rootPath(1));
});

test("RECONCILE: a proof that does not verify against its batch root is found even when the leaf array alone would hash fine", async () => {
  await sealRealBatch([["demo-a", 10, "aaaaaaaa"], ["demo-b", 20, "bbbbbbbb"], ["demo-c", 30, "cccccccc"]]);
  const doc = gh.read(PIN_REPO, batch.leavesPath(1));
  doc.tree_size = 7; // the DECLARED size lies; the leaves and the root agree
  gh.seed(PIN_REPO, batch.leavesPath(1), doc);

  const out = await reconciler.reconcile({ since: "2000-01-01T00:00:00Z" });
  assert.equal(out.verdict, "FINDINGS");
  const proofs = out.findings.filter((f) => f.kind === "proof_failed");
  assert.ok(proofs.length >= 1, "a stranger rebuilding a proof from this document gets a different answer than we did");
  assert.equal(out.findings.filter((f) => f.kind === "root_mismatch").length, 0, "and it is NOT reported as a root mismatch — the leaves do hash to the root");
});

test("RECONCILE: a TRUNCATED repository listing is INCOMPLETE, never CLEAN — it could not look", async () => {
  await sealRealBatch([["demo-a", 10, "aaaaaaaa"]]);
  gh.treeTruncated = true;

  const out = await reconciler.reconcile({ since: "2000-01-01T00:00:00Z" });
  assert.equal(out.verdict, "INCOMPLETE");
  assert.equal(out.exit_code, 2);
  assert.match(out.reading, /NOT a clean bill/);
  assert.equal(out.could_not_look[0].what, "repository listing");
});

test("RECONCILE: past its BOUND it says how many it did not look at, and the verdict is INCOMPLETE", async () => {
  await sealRealBatch([["demo-a", 10, "aaaaaaaa"], ["demo-b", 20, "bbbbbbbb"], ["demo-c", 30, "cccccccc"]]);

  const out = await reconciler.reconcile({ since: "2000-01-01T00:00:00Z", maxPins: 1 });
  assert.equal(out.verdict, "INCOMPLETE");
  assert.equal(out.exit_code, 2);
  const cap = out.could_not_look.find((c) => c.what === "pin records");
  assert.ok(cap);
  assert.match(cap.detail, /2 of 3 pin records were not read/);
});

test("RECONCILE: an UNREADABLE pending document is INCOMPLETE — a waiting leaf and a dropped one look the same without it", async () => {
  await sealRealBatch([["demo-a", 10, "aaaaaaaa"]]);
  const inner = global.fetch;
  global.fetch = async (url, opts) => {
    const u = new URL(String(url));
    if (u.pathname === `/repos/${USAGE_REPO}/contents/${pending.PENDING_PATH}` && ((opts && opts.method) || "GET") === "GET") {
      return { status: 500, ok: false, json: async () => ({}), text: async () => "down" };
    }
    return inner(url, opts);
  };
  const out = await reconciler.reconcile({ since: "2000-01-01T00:00:00Z" });
  global.fetch = inner;

  assert.equal(out.verdict, "INCOMPLETE");
  assert.equal(out.exit_code, 2);
  assert.equal(out.could_not_look[0].what, pending.PENDING_PATH);
  assert.equal(out.findings.filter((f) => f.kind === "lost").length, 0, "and it does not manufacture 'lost' out of what it could not see");
});

test("RECONCILE: an unreadable repository listing is INCOMPLETE, not a clean sheet over zero files", async () => {
  gh.treeStatus = 502;
  const out = await reconciler.reconcile({});
  assert.equal(out.verdict, "INCOMPLETE");
  assert.equal(out.exit_code, 2);
  assert.equal(out.could_not_look[0].what, "repository listing");
});

test("RECONCILE: an orphan leaves.json is a NOTE, not a finding — the design makes it inert and the tool agrees", async () => {
  await sealRealBatch([["demo-a", 10, "aaaaaaaa"]]);
  gh.seed(PIN_REPO, batch.leavesPath(9), { batch_id: "000000009", tree_size: 1, leaves: [leafFixture("demo-z", 1, "eeeeeeee", 1)] });

  const out = await reconciler.reconcile({ since: "2000-01-01T00:00:00Z" });
  assert.equal(out.verdict, "CLEAN");
  assert.equal(out.counts.orphan_leaf_lists, 1);
  assert.match(out.notes[0], /orphan leaf list/);
});

test("RECONCILE: a pin committed BEFORE anything ever sealed is out of scope, never 'lost'", async () => {
  gh.seed(PIN_REPO, "pins/demo-old/000000001.json", {
    namespace: "demo-old",
    rows: 5,
    chain: "0badc0de",
    seq: 1,
    pinned_at: "2026-01-01T00:00:00.000Z",
  });
  await sealRealBatch([["demo-a", 10, "aaaaaaaa"]]);

  const out = await reconciler.reconcile({}); // no --since: scope starts at the earliest batch
  assert.equal(out.verdict, "CLEAN", JSON.stringify(out.findings));
  assert.ok(out.counts.pins_out_of_scope >= 1);
  assert.ok(out.scope_start, "and it says where the window it checked begins");
});

// ===========================================================================
// C. NOTHING OLD MOVED
// ===========================================================================

test("THE ONE THAT MATTERS, STILL: a FROZEN pre-batching receipt verifies unchanged after a claimed seal and a reconciliation", async () => {
  // The same frozen record test/sealer.test.js uses, carried through the new
  // machinery: a claim taken, a root published, a reconciler run. None of it
  // touches the path this receipt verifies by.
  gh.seed(PIN_REPO, "pins/demo-frozen/latest.json", {
    namespace: "demo-frozen",
    rows: 512,
    chain: "0badc0de",
    seq: 3,
    pinned_at: "2026-08-01T00:00:00.000Z",
    first_seen_at: "2026-07-01T00:00:00.000Z",
    next_pin_due_by: "2099-01-01T00:00:00.000Z",
    cadence_hours: 24,
    record_kind: "advance",
    auth_level: "bearer-stage0",
  });

  const before = makeRes();
  await verifyHandler(makeReq({ query: { ns: "demo-frozen", rows: "512", chain: "0badc0de" } }), before);

  await sealRealBatch([["demo-a", 10, "aaaaaaaa"]]);
  await reconciler.reconcile({ since: "2000-01-01T00:00:00Z" });

  const after = makeRes();
  await verifyHandler(makeReq({ query: { ns: "demo-frozen", rows: "512", chain: "0badc0de" } }), after);

  assert.equal(after._status, 200);
  assert.equal(after._body.witnessed, true);
  assert.deepEqual(after._body, before._body, "byte-for-byte the same verify response, before and after");
});

test("FLAG OFF: what api/pin.js writes is byte-identical to the pre-claim shape — no claim, no pending, nothing new", async () => {
  const prev = process.env.WITNESS_BATCH_SHADOW;
  process.env.WITNESS_BATCH_SHADOW = "off";
  try {
    const res = await postPin("demo-off", 10, "aaaaaaaa");
    assert.equal(res._status, 201);

    // 1. WHERE it wrote: the two pin-repo files and the meter's own usage file,
    //    which predates all of this. Not the claim, not the pending document.
    assert.deepEqual(
      pinRepoWrites().map((w) => w.path),
      ["pins/demo-off/00000001.json", "pins/demo-off/latest.json"]
    );
    assert.equal(usageRepoWrites().filter((w) => w.path === claim.CLAIM_PATH).length, 0);
    assert.equal(usageRepoWrites().filter((w) => w.path === pending.PENDING_PATH).length, 0);
    assert.ok(
      usageRepoWrites().every((w) => w.path.startsWith("usage/")),
      "the only usage-repo write is the meter's, exactly as before"
    );

    // 2. WHAT it wrote: the whole record, field for field, with only the
    //    wall-clock timestamps normalized. A new field, a renamed field, a
    //    reordered nested object — any of it fails here.
    const record = gh.read(PIN_REPO, "pins/demo-off/00000001.json");
    const latest = gh.read(PIN_REPO, "pins/demo-off/latest.json");
    assert.deepEqual(record, latest, "the numbered record and the pointer are the same document");
    assert.deepEqual(normalizeTimestamps(record), FLAG_OFF_FROZEN_RECORD);

    // 3. WHAT IT READ: neither the claim nor the pending document, not once.
    assert.equal(gh.getLog.filter((p) => p === claim.CLAIM_PATH).length, 0);
    assert.equal(gh.getLog.filter((p) => p === pending.PENDING_PATH).length, 0);
  } finally {
    process.env.WITNESS_BATCH_SHADOW = prev;
  }
});

// Every ISO-8601 string anywhere in the document becomes "<ts>", so the frozen
// snapshot below is about SHAPE and VALUES and not about what time the suite
// ran. Everything else — every key, every number, every nested array — is
// compared literally.
function normalizeTimestamps(v) {
  if (Array.isArray(v)) return v.map(normalizeTimestamps);
  if (v && typeof v === "object") {
    const out = {};
    for (const k of Object.keys(v)) out[k] = normalizeTimestamps(v[k]);
    return out;
  }
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(v)) return "<ts>";
  return v;
}

const FLAG_OFF_FROZEN_RECORD = {
  namespace: "demo-off",
  rows: 10,
  chain: "aaaaaaaa",
  pinned_at: "<ts>",
  seq: 1,
  cadence_hours: 24,
  next_pin_due_by: "<ts>",
  record_kind: "content_head_advance",
  head_first_seen_at: "<ts>",
  renewals_since_advance: 0,
  renewals_total: 0,
  auth_level: "bearer-stage0",
  auth_note:
    "Bearer-key auth only. This is NOT owner-signature auth: the witness verifies that the caller holds a key bound " +
    "to this namespace prefix, not that the log's owner authorized this record. Anyone who obtains the key can pin " +
    "or renew. Owner-signature auth — a detached signature over {namespace, rows, chain, timestamp} verified " +
    "against a public key registered to the namespace — is the Stage-1 requirement and is NOT built yet. Read " +
    "publisher_heartbeat_current as proof that a key-holder was alive and asserting, never as proof of the log " +
    "owner's intent.",
  intervals: [
    {
      seq: 1,
      kind: "content_head_advance",
      opened_at: "<ts>",
      cadence_hours: 24,
      due_by: "<ts>",
      supersedes_due_by: null,
      superseded_deadline_was_missed: false,
    },
  ],
  intervals_total: 1,
  ever_missed_deadline: false,
  missed_deadline_count: 0,
  missed_deadlines: [],
};
