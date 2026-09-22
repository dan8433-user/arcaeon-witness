// test/sealer.test.js — THE CALLER: lib/_pending.js (the open batch and §6.1's
// pending head) and lib/_sealer.js (the trigger, the boundary, the fail-closed
// refusal). MERKLE_BATCHING_DESIGN.md §3.4, §6.1, §9 Phase 1, §10 T4, §11 Q3.
//
// test/merkle_batching.test.js proves the LIBRARY. This file proves the thing
// whose absence was the gap: "Until the sealer exists, nothing calls sealBatch
// in production. The library is complete and the caller is not."
//
// The test that matters most is the last one — a pin made the old way must still
// verify by exactly the path it does today, with the accumulator running on
// every pin and a root committed in the same repo. Phase 1 is a change to
// publication, not to semantics, and this is where that stops being a claim.
//
// Env BEFORE any require: REPO / USAGE_REPO are top-level consts read at
// require time, same discipline as test/pin.test.js and test/merkle_batching.test.js.
"use strict";

process.env.GITHUB_PIN_REPO = "test-owner/test-pins";
process.env.GITHUB_PIN_BRANCH = "main";
process.env.GITHUB_USAGE_REPO = "test-owner/test-usage";
process.env.GITHUB_PIN_TOKEN = "test-token";
process.env.WITNESS_KEYS = "testkeyA:demo-";
process.env.WITNESS_BATCH_SHADOW = "on"; // §9 Phase 1: the shadow run, started
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
const sealer = require("../lib/_sealer.js");
const pinHandler = require("../api/pin.js");
const verifyHandler = require("../api/verify.js");

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

// Every write into the PUBLIC pin repo — the only writes §1 counts, and the
// only ones a stranger can see. Authored by the fixture, not by the code under
// test (mock_store.js's putLog).
function pinRepoWrites() {
  return gh.putLog.filter((w) => w.repo === PIN_REPO);
}
function usageRepoWrites() {
  return gh.putLog.filter((w) => w.repo === USAGE_REPO);
}

// Post a real pin through the real handler. Returns the committed record.
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

function readPendingDoc() {
  return gh.read(USAGE_REPO, pending.PENDING_PATH);
}

// A fully-specified leaf, every field a literal, so a trigger decision is a
// decision about the clock and nothing else.
function leafFixture(ns, rows, chain, seq, dueBy = "2099-01-01T00:00:00.000Z") {
  return {
    namespace: ns,
    rows,
    chain,
    seq,
    accepted_at: "2026-08-14T18:00:00.000Z",
    cadence_hours: 24,
    next_pin_due_by: dueBy,
    record_kind: "content_head_advance",
    auth_level: "bearer-stage0",
  };
}

// Seed a pending document directly — the state a previous invocation left.
function seedPending(state) {
  gh.seed(USAGE_REPO, pending.PENDING_PATH, state);
}

// ===========================================================================
// 1. THE ACCUMULATOR — pins land in the open batch
// ===========================================================================

test("CONTRACT: an accepted pin appends its leaf to the open batch, in acceptance order, and the pin's own record is untouched", async () => {
  const a = await postPin("demo-a", 10, "aaaaaaaa");
  const b = await postPin("demo-b", 20, "bbbbbbbb");
  assert.equal(a._status, 201);
  assert.equal(b._status, 201);

  const doc = readPendingDoc();
  assert.equal(doc.open.batch_id, 1);
  assert.equal(doc.open.leaves.length, 2);
  assert.deepEqual(
    doc.open.leaves.map((l) => `${l.namespace}:${l.rows}`),
    ["demo-a:10", "demo-b:20"],
    "leaf order is acceptance order (§3.2)"
  );
  // §6.1's pending head, one per namespace.
  assert.equal(doc.heads["demo-a"].rows, 10);
  assert.equal(doc.heads["demo-b"].chain, "bbbbbbbb");

  // The public record is exactly what it was before any of this: two writes
  // per pin, nothing else.
  assert.equal(pinRepoWrites().length, 4);
  assert.ok(pinRepoWrites().every((w) => w.path.startsWith("pins/")));
});

test("CONTRACT: a heartbeat is a leaf too (§11 Q4 decided: heartbeats stay in the tree, carrying record_kind)", async () => {
  await postPin("demo-hb", 10, "aaaaaaaa");
  const r = await postPin("demo-hb", 10, "aaaaaaaa", { intent: "renew" });
  assert.equal(r._status, 201);
  const doc = readPendingDoc();
  assert.equal(doc.open.leaves.length, 2);
  assert.equal(doc.open.leaves[1].record_kind, "publisher_heartbeat");
});

test("CONTRACT: a rejected pin contributes no leaf — the accumulator runs only on a committed record", async () => {
  await postPin("demo-c", 10, "aaaaaaaa");
  const backward = await postPin("demo-c", 5, "cccccccc"); // monotonic violation
  assert.equal(backward._status, 409);
  const idempotent = await postPin("demo-c", 10, "aaaaaaaa"); // no-op re-pin
  assert.equal(idempotent._status, 200);
  assert.equal(readPendingDoc().open.leaves.length, 1);
});

test("REGRESSION: a pending-store failure never turns a committed pin into an error", async () => {
  // The pin's two writes land; the pending append cannot. Phase 1: "Keep
  // per-pin commits exactly as they are."
  gh.forceFailure(USAGE_REPO, pending.PENDING_PATH, 9, 500);
  const res = await postPin("demo-d", 10, "aaaaaaaa");
  assert.equal(res._status, 201);
  assert.equal(res._body.ok, true);
  assert.ok(gh.has(PIN_REPO, "pins/demo-d/latest.json"));
});

// ===========================================================================
// 2. THE TRIGGER (§3.4) — seals on the stated trigger, and NOT before
// ===========================================================================

test("THE TRIGGER: a batch does NOT seal before batch_interval_seconds has elapsed, and writes nothing while it waits", async () => {
  seedPending({
    ...pending.initialState(new Date("2026-08-14T18:00:00Z")),
    open: {
      batch_id: 1,
      opened_at: "2026-08-14T18:00:00.000Z",
      leaves: [leafFixture("demo-a", 10, "aaaaaaaa", 1)],
    },
  });
  const before = gh.putLog.length;

  // 59s after opening. batch_interval_seconds is 60.
  const r = await sealer.sealOnce({ now: new Date("2026-08-14T18:00:59Z") });

  assert.equal(r.sealed, false);
  assert.equal(r.reason, "trigger_not_fired");
  assert.equal(r.trigger, null);
  assert.equal(gh.putLog.length, before, "not one write — not to the pin repo, not to the pending doc");
  assert.equal(gh.has(PIN_REPO, batch.rootPath(1)), false);
});

test("THE TRIGGER: at batch_interval_seconds the batch seals, one root, trigger named interval_elapsed", async () => {
  seedPending({
    ...pending.initialState(new Date("2026-08-14T18:00:00Z")),
    open: {
      batch_id: 1,
      opened_at: "2026-08-14T18:00:00.000Z",
      leaves: [leafFixture("demo-a", 10, "aaaaaaaa", 1), leafFixture("demo-b", 20, "bbbbbbbb", 1)],
    },
  });

  const r = await sealer.sealOnce({ now: new Date("2026-08-14T18:01:00Z") });

  assert.equal(r.sealed, true);
  assert.equal(r.trigger, "interval_elapsed");
  assert.equal(r.tree_size, 2);
  assert.equal(r.writes, 2, "two pin-repo writes regardless of leaf count (§1)");
  assert.ok(gh.has(PIN_REPO, batch.leavesPath(1)));
  assert.ok(gh.has(PIN_REPO, batch.rootPath(1)));

  // The root is a real commitment over those exact leaves.
  const rootDoc = gh.read(PIN_REPO, batch.rootPath(1));
  assert.equal(rootDoc.prev_root, null);
  assert.equal(rootDoc.tree_size, 2);
  const check = merkle.verifyInclusion(r.proofs[0]);
  assert.equal(check.ok, true);
  assert.equal(check.computed_root, rootDoc.root);
});

test("THE TRIGGER: a deadline inside seal_safety_margin forces a seal BEFORE the interval (§3.4 trigger 3)", async () => {
  seedPending({
    ...pending.initialState(new Date("2026-08-14T18:00:00Z")),
    open: {
      batch_id: 1,
      opened_at: "2026-08-14T18:00:00.000Z",
      // due in 60s; the margin is 300s, so this leaf cannot wait for the interval
      leaves: [leafFixture("demo-a", 10, "aaaaaaaa", 1, "2026-08-14T18:01:00.000Z")],
    },
  });

  const r = await sealer.sealOnce({ now: new Date("2026-08-14T18:00:10Z") });
  assert.equal(r.sealed, true);
  assert.equal(r.trigger, "deadline_forces_seal");
});

test("THE TRIGGER: an empty open batch seals nothing and writes nothing, however long it has been open (§3.2)", async () => {
  seedPending(pending.initialState(new Date("2026-08-14T18:00:00Z")));
  const before = gh.putLog.length;
  const r = await sealer.sealOnce({ now: new Date("2026-08-14T23:00:00Z") });
  assert.equal(r.sealed, false);
  assert.equal(r.reason, "trigger_not_fired");
  assert.equal(gh.putLog.length, before);
});

test("CONTRACT: with no pending document at all the sealer reports no_open_batch, not a refusal and not a failure", async () => {
  const r = await sealer.sealOnce({ now: new Date("2026-08-14T18:01:00Z") });
  assert.equal(r.sealed, false);
  assert.equal(r.reason, "no_open_batch");
  assert.notEqual(r.refused, true, "'there is nothing' must not be reported as 'I could not look'");
  assert.equal(gh.putLog.length, 0);
});

// ===========================================================================
// 3. FAIL CLOSED — a sealer that cannot read the pending head REFUSES
// ===========================================================================

// Make one GET path fail with a 500, leaving every other request alone. The
// mock's forceFailure only covers PUTs; a read that cannot answer is a
// different failure and gets its own fixture rather than a reinterpretation
// of that one.
function failGetsTo(repo, path, status = 500) {
  const inner = global.fetch;
  global.fetch = async (url, opts) => {
    const u = new URL(String(url));
    const method = (opts && opts.method) || "GET";
    if (method === "GET" && u.pathname === `/repos/${repo}/contents/${path}`) {
      return {
        status,
        ok: false,
        json: async () => ({ message: "mock: forced read failure" }),
        text: async () => '{"message":"mock: forced read failure"}',
      };
    }
    return inner(url, opts);
  };
}

test("FAIL CLOSED: a sealer that cannot READ the pending head refuses, names why, and writes nothing", async () => {
  // A batch that is unambiguously due — the only thing stopping this seal is
  // that the sealer cannot see the pending head.
  seedPending({
    ...pending.initialState(new Date("2026-08-14T18:00:00Z")),
    open: {
      batch_id: 1,
      opened_at: "2026-08-14T18:00:00.000Z",
      leaves: [leafFixture("demo-a", 10, "aaaaaaaa", 1)],
    },
  });
  const before = gh.putLog.length;
  failGetsTo(USAGE_REPO, pending.PENDING_PATH, 500);

  const r = await sealer.sealOnce({ now: new Date("2026-08-14T18:05:00Z") });

  assert.equal(r.refused, true);
  assert.equal(r.sealed, false);
  assert.equal(r.reason, "pending_head_unreadable");
  assert.equal(r.writes, 0);
  assert.equal(gh.putLog.length, before, "nothing written anywhere");
  assert.equal(gh.has(PIN_REPO, batch.rootPath(1)), false, "no root over a batch it could not prove complete");
  assert.equal(gh.has(PIN_REPO, batch.leavesPath(1)), false, "not even an orphan leaf list");
});

test("FAIL CLOSED: an unreadable pending head is REFUSED, never read as 'there is no batch'", async () => {
  seedPending({
    ...pending.initialState(new Date("2026-08-14T18:00:00Z")),
    open: { batch_id: 1, opened_at: "2026-08-14T18:00:00.000Z", leaves: [leafFixture("demo-a", 10, "aaaaaaaa", 1)] },
  });
  failGetsTo(USAGE_REPO, pending.PENDING_PATH, 500);
  const r = await sealer.sealOnce({ now: new Date("2026-08-14T18:05:00Z") });
  // The two outcomes a fail-open bug would merge. They must stay apart: one is
  // a fact about the world, the other is a fact about our sight.
  assert.notEqual(r.reason, "no_open_batch");
  assert.equal(r.reason, "pending_head_unreadable");
});

test("FAIL CLOSED: a pending document whose leaves are incomplete stops the seal instead of rooting a partial leaf", async () => {
  const bad = leafFixture("demo-a", 10, "aaaaaaaa", 1);
  delete bad.record_kind; // §3.1: "a proof that omits it would let a heartbeat be presented as an advance"
  seedPending({
    ...pending.initialState(new Date("2026-08-14T18:00:00Z")),
    open: { batch_id: 1, opened_at: "2026-08-14T18:00:00.000Z", leaves: [bad] },
  });
  const r = await sealer.sealOnce({ now: new Date("2026-08-14T18:05:00Z") });
  assert.equal(r.refused, true);
  assert.equal(r.reason, "pending_document_corrupt");
  assert.equal(gh.has(PIN_REPO, batch.rootPath(1)), false);
});

test("FAIL CLOSED: an unreadable PIN repo (the chain tip) refuses too, before the batch is closed", async () => {
  seedPending({
    ...pending.initialState(new Date("2026-08-14T18:00:00Z")),
    open: { batch_id: 5, opened_at: "2026-08-14T18:00:00.000Z", leaves: [leafFixture("demo-a", 10, "aaaaaaaa", 1)] },
  });
  failGetsTo(PIN_REPO, batch.rootPath(4), 500);
  const r = await sealer.sealOnce({ now: new Date("2026-08-14T18:05:00Z") });
  assert.equal(r.refused, true);
  assert.equal(r.reason, "pin_repo_unreadable");
  assert.equal(usageRepoWrites().length, 0, "the pending document was not closed — the batch is intact for the next run");
});

// ===========================================================================
// 4. THE BOUNDARY — a pin accepted during a seal is not lost
// ===========================================================================

test("THE BOUNDARY: a pin accepted after the close lands in the NEXT batch, not the sealed one, and is lost by neither", async () => {
  seedPending({
    ...pending.initialState(new Date("2026-08-14T18:00:00Z")),
    open: {
      batch_id: 1,
      opened_at: "2026-08-14T18:00:00.000Z",
      leaves: [leafFixture("demo-early", 10, "aaaaaaaa", 1)],
    },
  });

  const sealed = await sealer.sealOnce({ now: new Date("2026-08-14T18:01:00Z") });
  assert.equal(sealed.sealed, true);
  assert.equal(sealed.tree_size, 1);

  // A pin arriving now — after the close — appends to the batch the close
  // opened.
  const res = await postPin("demo-late", 99, "cccccccc");
  assert.equal(res._status, 201);

  const doc = readPendingDoc();
  assert.equal(doc.open.batch_id, 2, "the close opened batch 2");
  assert.equal(doc.open.leaves.length, 1);
  assert.equal(doc.open.leaves[0].namespace, "demo-late");
  assert.equal(doc.sealing, null, "the sealed batch released its slot");

  // And it is genuinely NOT in batch 1's published leaf list — the side of the
  // boundary is checkable from the public record, not from our word for it.
  const leaves1 = gh.read(PIN_REPO, batch.leavesPath(1));
  assert.equal(leaves1.leaves.length, 1);
  assert.equal(leaves1.leaves[0].namespace, "demo-early");

  // It seals in batch 2, on batch 2's own interval, chained to batch 1's root.
  const second = await sealer.sealOnce({ now: new Date("2026-08-14T18:02:30Z") });
  assert.equal(second.sealed, true);
  assert.equal(second.batch_id, batch.batchName(2));
  assert.equal(second.tree_size, 1);
  assert.equal(second.prev_root, gh.read(PIN_REPO, batch.rootPath(1)).root, "§3.3: the roots chain");
  const leaves2 = gh.read(PIN_REPO, batch.leavesPath(2));
  assert.equal(leaves2.leaves[0].namespace, "demo-late");
});

test("THE BOUNDARY: a pin that WINS the race against the close is inside the sealed batch, not orphaned past it", async () => {
  seedPending({
    ...pending.initialState(new Date("2026-08-14T18:00:00Z")),
    open: {
      batch_id: 1,
      opened_at: "2026-08-14T18:00:00.000Z",
      leaves: [leafFixture("demo-early", 10, "aaaaaaaa", 1)],
    },
  });

  // The close's FIRST CAS write loses to a racing appender. The fixture forces
  // that 409; the appended leaf is what a real winner would have left behind.
  let raced = false;
  const inner = global.fetch;
  global.fetch = async (url, opts) => {
    const u = new URL(String(url));
    const method = (opts && opts.method) || "GET";
    if (!raced && method === "PUT" && u.pathname === `/repos/${USAGE_REPO}/contents/${pending.PENDING_PATH}`) {
      raced = true;
      // The winner's append lands first, exactly as api/pin.js would have left it.
      const cur = gh.read(USAGE_REPO, pending.PENDING_PATH);
      cur.open.leaves.push(leafFixture("demo-racer", 55, "dddddddd", 1));
      cur.heads["demo-racer"] = { rows: 55, chain: "dddddddd", seq: 1 };
      gh.seed(USAGE_REPO, pending.PENDING_PATH, cur);
      return {
        status: 409,
        ok: false,
        json: async () => ({ message: "mock: racing appender won" }),
        text: async () => '{"message":"mock: racing appender won"}',
      };
    }
    return inner(url, opts);
  };

  const r = await sealer.sealOnce({ now: new Date("2026-08-14T18:01:00Z") });
  assert.equal(r.sealed, true);
  assert.equal(raced, true, "the race actually happened");
  assert.equal(r.tree_size, 2, "the loser re-read and the racer's leaf is inside the sealed batch");

  const leaves1 = gh.read(PIN_REPO, batch.leavesPath(1));
  assert.deepEqual(
    leaves1.leaves.map((l) => l.namespace),
    ["demo-early", "demo-racer"],
    "one side of the boundary, in acceptance order, and not the other"
  );
  assert.equal(readPendingDoc().open.leaves.length, 0);
});

// ===========================================================================
// 5. THE FAILURE ATOM (6c0bb93) still holds through the caller
// ===========================================================================

test("THE ATOM: a root write that fails publishes no root and mints no proof — and the leaves are held, not dropped (§10 T4)", async () => {
  seedPending({
    ...pending.initialState(new Date("2026-08-14T18:00:00Z")),
    open: {
      batch_id: 1,
      opened_at: "2026-08-14T18:00:00.000Z",
      leaves: [leafFixture("demo-a", 10, "aaaaaaaa", 1)],
    },
  });
  // Enough forced failures to outlast putFile's bounded 409 retry.
  gh.forceFailure(PIN_REPO, batch.rootPath(1), 9, 500);

  const r = await sealer.sealOnce({ now: new Date("2026-08-14T18:01:00Z") });

  assert.equal(r.sealed, false);
  assert.equal(r.failed, true);
  assert.equal(r.stage, "root");
  assert.equal(gh.has(PIN_REPO, batch.rootPath(1)), false, "no pin claims a root that was never published");
  assert.equal(r.proofs, undefined);

  // The leaf list that did land names no root and nothing points at it: an
  // inert orphan, by the design's own word.
  assert.equal(gh.has(PIN_REPO, batch.leavesPath(1)), true);

  // The leaves are held in the pending document, and the NEXT seal absorbs
  // them under a NEW batch id — the dead id is consumed, never reused.
  const held = readPendingDoc();
  assert.equal(held.sealing.batch_id, 1);
  assert.equal(held.sealing.leaves.length, 1);

  const retry = await sealer.sealOnce({ now: new Date("2026-08-14T18:02:00Z") });
  assert.equal(retry.sealed, true);
  assert.equal(retry.trigger, "unsealed_carry_over");
  assert.equal(retry.batch_id, batch.batchName(2));
  assert.equal(retry.tree_size, 1);
  assert.equal(retry.carried_leaves, 1);
  assert.equal(gh.has(PIN_REPO, batch.rootPath(1)), false, "the dead id stays dead");
  assert.equal(gh.has(PIN_REPO, batch.rootPath(2)), true);
});

test("THE ATOM: a sealing slot whose root DID publish is resolved against the public record, never re-sealed into a second root", async () => {
  // The shape that produces this: the root committed and the 'clear the slot'
  // write then failed. Trusting our own bookkeeping here would publish the same
  // leaves under a second root.
  const leaf = leafFixture("demo-a", 10, "aaaaaaaa", 1);
  seedPending({
    ...pending.initialState(new Date("2026-08-14T18:00:00Z")),
    open: { batch_id: 2, opened_at: "2026-08-14T18:01:00.000Z", leaves: [leafFixture("demo-b", 20, "bbbbbbbb", 1)] },
    sealing: { batch_id: 1, opened_at: "2026-08-14T18:00:00.000Z", leaves: [leaf] },
  });
  // Batch 1's root really is published.
  gh.seed(PIN_REPO, batch.rootPath(1), {
    batch_id: "000000001",
    root: "sha256:witness-merkle:v1:" + "11".repeat(32),
    prev_root: null,
    tree_size: 1,
  });

  const r = await sealer.sealOnce({ now: new Date("2026-08-14T18:02:00Z") });
  assert.equal(r.sealed, true);
  assert.equal(r.batch_id, batch.batchName(2));
  assert.equal(r.tree_size, 1, "only the open batch's leaf — the published batch's leaf is NOT re-rooted");
  assert.equal(r.carried_leaves, 0);
  const leaves2 = gh.read(PIN_REPO, batch.leavesPath(2));
  assert.deepEqual(leaves2.leaves.map((l) => l.namespace), ["demo-b"]);
});

// ===========================================================================
// 6. §6.1's PENDING HEAD — the first guard, with §6.3 still the backstop
// ===========================================================================

test("§6.1: a conflicting leaf is refused into the tree by the pending head, before it can reach the seal-time re-check", async () => {
  const state = pending.initialState(new Date("2026-08-14T18:00:00Z"));
  seedPending(state);
  const first = await pending.recordAccepted({
    namespace: "demo-x", rows: 10, chain: "aaaaaaaa", seq: 1,
    pinned_at: "2026-08-14T18:00:00.000Z", cadence_hours: 24,
    next_pin_due_by: "2099-01-01T00:00:00.000Z",
    record_kind: "content_head_advance", auth_level: "bearer-stage0",
  });
  assert.equal(first.ok, true);

  // Same rows, different chain — the re-mint signature.
  const second = await pending.recordAccepted({
    namespace: "demo-x", rows: 10, chain: "ffffffff", seq: 2,
    pinned_at: "2026-08-14T18:00:01.000Z", cadence_hours: 24,
    next_pin_due_by: "2099-01-01T00:00:00.000Z",
    record_kind: "content_head_advance", auth_level: "bearer-stage0",
  });
  assert.equal(second.ok, false);
  assert.equal(second.reason, "pending_head_conflict");
  assert.equal(second.accepted_chain, "aaaaaaaa");
  assert.equal(readPendingDoc().open.leaves.length, 1, "the conflicting leaf never entered the batch");
});

test("§6.3 REMAINS the backstop: a conflict that slips past the pending head is still caught at seal time and dropped from the tree", async () => {
  // Two conflicting leaves seated directly in the pending document — the shape
  // a stale cross-instance read produces, which is exactly why the contents API
  // not giving read-your-writes matters and why the re-check was never
  // redundant.
  seedPending({
    ...pending.initialState(new Date("2026-08-14T18:00:00Z")),
    open: {
      batch_id: 1,
      opened_at: "2026-08-14T18:00:00.000Z",
      leaves: [leafFixture("demo-x", 10, "aaaaaaaa", 1), leafFixture("demo-x", 10, "ffffffff", 2)],
    },
  });

  const r = await sealer.sealOnce({ now: new Date("2026-08-14T18:01:00Z") });
  assert.equal(r.sealed, true);
  assert.equal(r.tree_size, 1, "the LATER leaf was dropped — a conflict never advances accepted state");
  assert.equal(r.conflicts.length, 1);
  assert.equal(r.conflicts[0].claimed_chain, "ffffffff");
  // §6.2: the observation is written immediately and unbatched.
  const obs = pinRepoWrites().filter((w) => w.path.startsWith("observations/demo-x/"));
  assert.equal(obs.length, 1);
});

// ===========================================================================
// 7. THE ONE THAT MATTERS — an old-style pin verifies by exactly today's path
// ===========================================================================

test("THE ONE THAT MATTERS: with the accumulator live on every pin and a root committed by the sealer, an old-style pin verifies by exactly the path it does today", async () => {
  // 1. A receipt written the old way. The accumulator IS running — that is the
  //    point: this is the world after Phase 1 starts, not before it.
  const res = await postPin("demo-legacy", 77, "feedface");
  assert.equal(res._status, 201);
  const oldPin = res._body.pin;

  const before = makeRes();
  await verifyHandler(makeReq({ query: { ns: "demo-legacy", rows: "77", chain: "feedface" } }), before);
  assert.equal(before._status, 200);
  assert.equal(before._body.witnessed, true);

  // 2. The SEALER runs — the caller, not a hand-driven library call — and
  //    commits a real root into the same repo the verifier reads.
  const sealed = await sealer.sealOnce({ now: new Date(Date.now() + 120_000) });
  assert.equal(sealed.sealed, true);
  assert.ok(gh.has(PIN_REPO, batch.rootPath(1)));

  // 3. Same call, same answer, byte-for-byte.
  gh.getLog.length = 0;
  const after = makeRes();
  await verifyHandler(makeReq({ query: { ns: "demo-legacy", rows: "77", chain: "feedface" } }), after);
  assert.equal(after._status, 200);
  assert.deepEqual(after._body, before._body);

  // 4. "By exactly the path it does today" is a claim about which files were
  //    READ, so it is checked against the store's own read log — authored by
  //    the fixture, not by the handler.
  assert.deepEqual(gh.getLog, ["pins/demo-legacy/latest.json"]);
  assert.equal(
    gh.getLog.filter((p) => p.startsWith("batches/")).length,
    0,
    "the verifier does not know batches/ exists — §9 Phase 1: nothing reads the roots"
  );

  // 5. And the stored record is the same bytes a stranger cloned yesterday.
  assert.deepEqual(gh.read(PIN_REPO, "pins/demo-legacy/latest.json"), oldPin);
  assert.deepEqual(
    pinRepoWrites().map((w) => w.path),
    [
      "pins/demo-legacy/00000001.json",
      "pins/demo-legacy/latest.json",
      batch.leavesPath(1),
      batch.rootPath(1),
    ],
    "two per-pin writes unchanged, plus batches/* and nothing else"
  );
});

test("THE ONE THAT MATTERS: a FROZEN pre-batching record still verifies witnessed:true after the sealer has run", async () => {
  // Hand-written to the shape api/pin.js wrote before any of this existed.
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
  seedPending({
    ...pending.initialState(new Date("2026-08-14T18:00:00Z")),
    open: { batch_id: 1, opened_at: "2026-08-14T18:00:00.000Z", leaves: [leafFixture("demo-a", 10, "aaaaaaaa", 1)] },
  });
  const sealed = await sealer.sealOnce({ now: new Date("2026-08-14T18:01:00Z") });
  assert.equal(sealed.sealed, true);

  const r = makeRes();
  await verifyHandler(makeReq({ query: { ns: "demo-frozen", rows: "512", chain: "0badc0de" } }), r);
  assert.equal(r._status, 200);
  assert.equal(r._body.witnessed, true);
  assert.equal(r._body.is_current_head, true);
  assert.equal(r._body.cadence_grade, "pass");
});

// ===========================================================================
// 8. THE SWITCH — Phase 1 is a run someone starts
// ===========================================================================

test("CONTRACT: with the shadow run off, a pin accumulates nothing and the pending store is never touched", async () => {
  const prev = process.env.WITNESS_BATCH_SHADOW;
  process.env.WITNESS_BATCH_SHADOW = "off";
  try {
    const res = await postPin("demo-off", 10, "aaaaaaaa");
    assert.equal(res._status, 201);
    assert.equal(gh.has(USAGE_REPO, pending.PENDING_PATH), false);
    assert.equal(gh.getLog.filter((p) => p === pending.PENDING_PATH).length, 0);
  } finally {
    process.env.WITNESS_BATCH_SHADOW = prev;
  }
});

// ===========================================================================
// VERDICT_SURVEY.md §6: resolveSealing read two damaged shapes as green.
// ===========================================================================

test("VERDICT: a sealing slot that is present but has no leaf array refuses the run; it is never read as 'nothing owed' and written over", async () => {
  for (const slot of [{ batch_id: 1, opened_at: "2026-08-14T18:00:00.000Z", leaves: "garbage" }, {}, [], "x"]) {
    gh = new MockGitHubStore();
    restore();
    restore = install(gh);
    seedPending({
      ...pending.initialState(new Date("2026-08-14T18:00:00Z")),
      open: { batch_id: 2, opened_at: "2026-08-14T18:01:00.000Z", leaves: [leafFixture("demo-b", 20, "bbbbbbbb", 1)] },
      sealing: slot,
    });
    const r = await sealer.sealOnce({ now: new Date("2026-08-14T18:02:00Z") });
    assert.notEqual(r.sealed, true, `damaged slot ${JSON.stringify(slot)} was read as nothing owed and the run sealed: ${JSON.stringify(r)}`);
    assert.equal(r.refused, true);
    assert.equal(r.reason, "pending_document_corrupt");
    assert.equal(pinRepoWrites().length, 0, "nothing published over a slot nobody could read");
    assert.deepEqual(readPendingDoc().sealing, slot, "the damaged slot is left for a human, not overwritten");
  }
});

test("VERDICT: a root.json that is present but carries no root does not count as published; the run refuses and the slot's leaves stay held", async () => {
  const leaf = leafFixture("demo-a", 10, "aaaaaaaa", 1);
  seedPending({
    ...pending.initialState(new Date("2026-08-14T18:00:00Z")),
    open: { batch_id: 2, opened_at: "2026-08-14T18:01:00.000Z", leaves: [leafFixture("demo-b", 20, "bbbbbbbb", 1)] },
    sealing: { batch_id: 1, opened_at: "2026-08-14T18:00:00.000Z", leaves: [leaf] },
  });
  gh.seed(PIN_REPO, batch.rootPath(1), {});

  const r = await sealer.sealOnce({ now: new Date("2026-08-14T18:02:00Z") });
  assert.notEqual(r.sealed, true, `a root.json with no root was read as published and the run sealed: ${JSON.stringify(r)}`);
  assert.equal(r.refused, true);
  assert.equal(r.reason, "pin_repo_unreadable");
  assert.equal(pinRepoWrites().length, 0);
  assert.deepEqual(
    readPendingDoc().sealing.leaves.map((l) => l.namespace),
    ["demo-a"],
    "the held leaf is still held, not overwritten by the next close"
  );
});

test("VERDICT (legacy guard): a pending document with NO sealing key at all still seals normally", async () => {
  const state = {
    ...pending.initialState(new Date("2026-08-14T18:00:00Z")),
    open: { batch_id: 1, opened_at: "2026-08-14T18:00:00.000Z", leaves: [leafFixture("demo-b", 20, "bbbbbbbb", 1)] },
  };
  delete state.sealing;
  seedPending(state);
  const r = await sealer.sealOnce({ now: new Date("2026-08-14T18:02:00Z") });
  assert.equal(r.sealed, true, JSON.stringify(r));
});

test("VERDICT: a sealing slot holding leaves but no integer batch_id refuses; it cannot be checked against the public record, so it is never re-sealed", async () => {
  const leaf = leafFixture("demo-a", 10, "aaaaaaaa", 1);
  seedPending({
    ...pending.initialState(new Date("2026-08-14T18:00:00Z")),
    open: { batch_id: 2, opened_at: "2026-08-14T18:01:00.000Z", leaves: [leafFixture("demo-b", 20, "bbbbbbbb", 1)] },
    sealing: { opened_at: "2026-08-14T18:00:00.000Z", leaves: [leaf] },
  });
  // Batch 1 really did publish these leaves; a slot that lost its id cannot ask.
  gh.seed(PIN_REPO, batch.rootPath(1), { batch_id: "000000001", root: "sha256:witness-merkle:v1:" + "11".repeat(32), prev_root: null, tree_size: 1 });
  const r = await sealer.sealOnce({ now: new Date("2026-08-14T18:02:00Z") });
  assert.notEqual(r.sealed, true, `a slot with no batch_id was carried and re-sealed: ${JSON.stringify(r)}`);
  assert.equal(r.reason, "pending_document_corrupt");
  assert.equal(pinRepoWrites().length, 0);
});
