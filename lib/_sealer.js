// _sealer.js — THE CALLER. The thing whose absence was the whole gap:
// "Until the sealer exists, nothing calls sealBatch in production. The library
// is complete and the caller is not."
//
// MERKLE_BATCHING_DESIGN.md §3.4 (the trigger), §9 Phase 1 (shadow trees),
// §10 T4 (a failed seal's leaves), §11 Q3 (who runs the sealer).
//
// ---- THE TRIGGER, QUOTED ----
//
// §3.4: "Seal when any of these fires, whichever comes first:
//   1. batch_interval_seconds elapsed since the batch opened (default proposal: 60s).
//   2. max_leaves reached (proposal: 4096 ...).
//   3. A deadline forces it — any pending leaf whose next_pin_due_by is within
//      seal_safety_margin of expiring."
//
// All three are already implemented, in lib/_batch.js `sealTrigger`. This file
// does not restate them and does not own a fourth copy of the rule; it reads
// the open batch out of the pending store, hands it to `sealTrigger`, and does
// nothing at all when the answer is null. One addition, and it is a carry not a
// cadence: a leaf set left behind by a seal that already failed (§10 T4,
// "bounded retry with the next batch absorbing the unsealed leaves") seals on
// the next run regardless of the interval — leaves that missed one root must
// not wait a second interval for the next.
//
// ---- WHERE IT IS INVOKED FROM, AND WHY THERE (§11 Q3) ----
//
// §11 Q3 left this open — "Options: scheduled function, an external cron poking
// a seal endpoint, or opportunistic sealing on the next inbound pin ... Leaning
// scheduled." A lean, not a decision. The decision, and its two constraints:
//
//   1. api/ is at the Vercel Hobby 12-function cap (9e8b060, "the witness app
//      is at the Hobby cap of 12 functions and the deploy with 14 was
//      refused"). A scheduled function is a 13th file. Not available.
//   2. Opportunistic sealing on the next inbound pin is refused by the design's
//      own parenthesis: it "starves a quiet witness — a batch with no following
//      pin would never seal."
//
// That leaves a mode on an existing entry point, or a command. It is a COMMAND:
// tools/seal_batch.js, run by the operator's own scheduler. A seal writes to the
// public pin repo, so a mode on a public endpoint would need a new operator-auth
// surface built and defended before the first seal; a command needs none,
// because running it already requires the GITHUB_PIN_TOKEN in the operator's
// environment — the same credential the seal spends. And Phase 1 is a watched
// run with a start date ("Run it until a full week reconciles clean"), not a
// background daemon: the smallest thing that cannot be triggered by a stranger,
// and stops the moment the operator stops running it, is the right shape for it.
//
// tools/ is not routed as functions — tools/ceiling_probe.js has sat there
// across the deploy that was capped at 12, which is the evidence, not the
// assumption.
//
// ---- FAIL CLOSED ----
//
// Every read that could refuse happens BEFORE any write. If the pending head
// cannot be read, the sealer refuses and writes nothing — it never seals a
// batch it cannot prove complete. A store that answers "I don't know" is not a
// store that answered "empty," and collapsing those two is the bug this guard
// exists to make impossible.

"use strict";

const store = require("./_store.js");
const batch = require("./_batch.js");
const pending = require("./_pending.js");

// §3.4 trigger 3's margin. Same default as _batch.js's MAX_SEAL_LAG_SECONDS,
// named separately here because the design names it separately
// ("seal_safety_margin").
const SEAL_SAFETY_MARGIN_SECONDS = batch.MAX_SEAL_LAG_SECONDS;

function refusal(reason, detail, extra) {
  return { sealed: false, refused: true, reason, detail: detail || null, writes: 0, ...(extra || {}) };
}

// A previously-closed-but-unconfirmed batch is resolved against the PUBLIC
// RECORD, never against our own bookkeeping.
//
// The hazard this closes: a seal whose root.json committed but whose "clear the
// sealing slot" write then failed would, on the next run, look exactly like a
// seal that failed — and re-sealing it would publish the same leaves under a
// second root. Asking the pin repo whether a root exists at that batch id turns
// a question about our memory into a question about the published record, which
// is the only authority this system ever lets itself use.
//
// Returns {carry: [leaves], published: bool}. Throws if the pin repo cannot be
// read — an unknown here refuses the whole run, same rule as the pending head.
async function resolveSealing(state) {
  if (!state.sealing || !Array.isArray(state.sealing.leaves) || state.sealing.leaves.length === 0) {
    return { carry: [], published: false };
  }
  const id = state.sealing.batch_id;
  const rec = await store.getFile(batch.rootPath(id));
  if (rec) return { carry: [], published: true, batch_id: id, root: rec.json.root };
  return { carry: pending.validateLeaves(state.sealing.leaves, "sealing.leaves"), published: false, batch_id: id };
}

// Build a batch object holding ALREADY-CANONICAL leaf objects. batch.addLeaf
// takes a stored pin record and converts it through merkle.leafObjectFromPin;
// what comes out of the pending store has already been through that conversion,
// so re-converting it would be a second, divergent shape of the same leaf.
// sealBatch and sealTrigger read `batch.leaves` as leaf objects directly
// (`leaves.map((l) => merkle.leafHash(l))`), so seating them is exact.
function batchFromPending(open, leaves, opts) {
  const b = batch.openBatch({
    batch_id: open.batch_id,
    opened_at: open.opened_at,
    ...(opts || {}),
  });
  b.leaves = leaves.slice();
  return b;
}

// One sealing pass. Returns a receipt; throws nothing a caller must catch for
// control flow — a refusal is a value, not an exception, because "refused and
// wrote nothing" is a normal, reportable outcome and not an error condition.
async function sealOnce({
  now = new Date(),
  sealSafetyMarginSeconds = SEAL_SAFETY_MARGIN_SECONDS,
  attempts = pending.CAS_ATTEMPTS,
} = {}) {
  // ---- READ 1: the pending head. THE FAIL-CLOSED POINT. ----
  let cur;
  try {
    cur = await pending.readPending();
  } catch (err) {
    // Not "no open batch" — "I cannot see the open batch." Refuse, write
    // nothing, and say which it was. §6.1: "Accepting a pin we cannot
    // conflict-check is worse than not accepting it, because it enters the
    // record looking checked" — the same sentence about a root is stronger
    // still, because a root is published and a pin is not yet.
    return refusal("pending_head_unreadable", err && err.message);
  }
  if (!cur) return { sealed: false, reason: "no_open_batch", writes: 0, trigger: null };

  const state = cur.json;
  if (!state || !state.open || !Array.isArray(state.open.leaves)) {
    return refusal("pending_document_corrupt", "open batch document has no leaf array");
  }

  // ---- READ 2: is a previously-closed batch actually published? ----
  let resolved;
  try {
    resolved = await resolveSealing(state);
  } catch (err) {
    return refusal(
      err && err.corrupt ? "pending_document_corrupt" : "pin_repo_unreadable",
      err && err.message
    );
  }

  let openLeaves;
  try {
    openLeaves = pending.validateLeaves(state.open.leaves, "open.leaves");
  } catch (err) {
    return refusal("pending_document_corrupt", err && err.message);
  }

  // ---- THE TRIGGER (§3.4), evaluated by lib/_batch.js, not restated here ----
  const probe = batchFromPending(state.open, openLeaves);
  let trigger = batch.sealTrigger(probe, now.getTime(), sealSafetyMarginSeconds);
  if (!trigger && resolved.carry.length) trigger = "unsealed_carry_over";
  if (!trigger) {
    return {
      sealed: false,
      reason: "trigger_not_fired",
      writes: 0,
      trigger: null,
      batch_id: state.open.batch_id,
      pending_leaves: openLeaves.length,
      opened_at: state.open.opened_at,
    };
  }

  const toSeal = resolved.carry.concat(openLeaves); // carried leaves are older
  if (toSeal.length === 0) {
    // Reachable only through the carry path with an empty open batch and a
    // carry that turned out to be published. §3.2: an empty interval commits
    // no root, and a manufactured one is refused rather than written.
    return { sealed: false, reason: "empty_interval_commits_no_root", writes: 0, trigger };
  }

  // ---- READ 3: the chain tip (§3.3). Before any write, so a broken chain
  // refuses without having moved pending state. ----
  let chain;
  try {
    chain = await batch.readPrevRoot(store, state.open.batch_id);
  } catch (err) {
    return refusal(err && err.chain_break ? "chain_break" : "pin_repo_unreadable", err && err.message);
  }

  // ---- WRITE 1: CLOSE the batch. THIS IS THE BOUNDARY. ----
  //
  // Close BEFORE sealing, never after. A leaf appended after a root is computed
  // would be a leaf claiming membership in a tree it is not in; freezing the
  // leaf set first makes that unrepresentable. The close is a CAS on the same
  // document api/pin.js appends to, so a pin racing this seal either wins (its
  // leaf is inside the closed set, and this close 409s and re-reads) or loses
  // (its append 409s and re-reads, landing in the NEXT batch). It cannot land
  // in both and it cannot land in neither.
  let closed = null;
  let closeState = state;
  let closeSha = cur.sha;
  let closeLeaves = toSeal;
  for (let i = 0; i < attempts; i++) {
    const next = {
      ...closeState,
      open: {
        batch_id: closeState.open.batch_id + 1,
        opened_at: now.toISOString(),
        leaves: [],
      },
      sealing: {
        batch_id: closeState.open.batch_id,
        opened_at: closeState.open.opened_at,
        leaves: closeLeaves,
      },
      updated_at: now.toISOString(),
    };
    try {
      await pending.writePending(
        next,
        closeSha,
        `pending: close batch ${closeState.open.batch_id} for sealing (${closeLeaves.length} leaves), open ${closeState.open.batch_id + 1}`
      );
      closed = next;
      break;
    } catch (err) {
      if (!(err && err.conflict) || i === attempts - 1) {
        // Nothing has been written to the PIN repo at this point. The batch is
        // untouched and the next run tries again.
        return refusal("close_failed", err && err.message, { trigger, batch_id: closeState.open.batch_id });
      }
      // A pin appended between our read and our close. Re-read and re-derive:
      // its leaf belongs in this batch, which is the whole point of losing.
      let fresh;
      try {
        fresh = await pending.readPending();
      } catch (readErr) {
        return refusal("pending_head_unreadable", readErr && readErr.message, { trigger });
      }
      if (!fresh) return refusal("pending_head_vanished", "the open batch document disappeared mid-close", { trigger });
      closeState = fresh.json;
      closeSha = fresh.sha;
      try {
        const freshResolved = await resolveSealing(closeState);
        closeLeaves = freshResolved.carry.concat(pending.validateLeaves(closeState.open.leaves, "open.leaves"));
      } catch (reErr) {
        return refusal(
          reErr && reErr.corrupt ? "pending_document_corrupt" : "pin_repo_unreadable",
          reErr && reErr.message,
          { trigger }
        );
      }
    }
  }

  // ---- WRITE 2 & 3: leaves.json then root.json. lib/_batch.js owns the atom. ----
  const b = batchFromPending(closed.sealing, closeLeaves, {
    prev_root: chain.prev_root,
    chain_starts_here: chain.chain_starts_here,
  });
  let result;
  try {
    result = await batch.sealBatch(store, b, { now });
  } catch (err) {
    // The failure atom, unchanged from 6c0bb93: no root file, no proofs, an
    // unmoved chain tip. The leaves stay in `sealing` and the next run's
    // resolveSealing carries them forward under a NEW batch id (the dead id is
    // consumed, never reused — see _batch.js readPrevRoot's header).
    return {
      sealed: false,
      failed: true,
      reason: "seal_failed",
      stage: err && err.stage ? err.stage : "unknown",
      detail: err && err.message,
      trigger,
      batch_id: batch.batchName(closed.sealing.batch_id),
      carried_leaves: closeLeaves.length,
      note: "no root was published; these leaves are held in the pending document and the next seal absorbs them (§10 T4)",
    };
  }

  if (!result.sealed) {
    // §6.3 dropped every leaf as a conflict, so there is no tree to commit.
    // Clear the slot anyway: nothing is owed a root.
    await clearSealing(now, attempts);
    return { ...result, trigger, writes: result.writes || 0 };
  }

  // ---- The root is published. Release the slot. ----
  const cleared = await clearSealing(now, attempts);

  return {
    ...result,
    trigger,
    sealing_slot_cleared: cleared.ok,
    // If this is false the root IS published and the only thing stale is our
    // own note-to-self; the next run asks the pin repo, sees the root, and
    // drops the slot without re-sealing. Reported, never silent.
    sealing_slot_detail: cleared.ok ? null : cleared.error,
    carried_leaves: resolved.carry.length,
    proofs_minted: result.proofs ? result.proofs.length : 0,
  };
}

// Drop the `sealing` slot, preserving whatever has been appended to the open
// batch since the close. Bounded CAS; a failure here is annoying, not unsafe,
// because resolveSealing re-derives the truth from the published record.
async function clearSealing(now, attempts) {
  for (let i = 0; i < attempts; i++) {
    let cur;
    try {
      cur = await pending.readPending();
    } catch (err) {
      return { ok: false, error: err && err.message };
    }
    if (!cur) return { ok: false, error: "pending document disappeared" };
    const next = { ...cur.json, sealing: null, updated_at: now.toISOString() };
    try {
      await pending.writePending(next, cur.sha, "pending: root published, releasing the sealing slot");
      return { ok: true };
    } catch (err) {
      if (err && err.conflict && i < attempts - 1) continue;
      return { ok: false, error: err && err.message };
    }
  }
  return { ok: false, error: "clear did not converge" };
}

module.exports = {
  SEAL_SAFETY_MARGIN_SECONDS,
  sealOnce,
  resolveSealing,
  clearSealing,
  batchFromPending,
};
