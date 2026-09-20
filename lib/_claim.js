// _claim.js — the single-sealer claim. The gap this closes, stated plainly:
// lib/_sealer.js's close CAS partitions the LEAF SET exactly (a leaf lands in
// one batch id's set or the next one's, never both and never neither — see
// test/sealer.test.js "THE BOUNDARY"), but nothing partitions the SEAL
// EXECUTION. Two sealers running at once can therefore publish the same leaves
// under two different roots:
//
//   A closes batch N   -> pending: {open: N+1, sealing: {N, L}}
//   B's close 409s, B re-reads, sees sealing={N,L}, asks the pin repo whether
//     root N is published. A has not written it yet. Legitimately: "not
//     published, carry it forward."
//   B closes N+1 carrying L, seals it, publishes root N+1 over L.
//   A, still running, publishes root N over L.
//   -> every leaf of L is now claimed by two roots.
//
// No crash is needed for that; two overlapping invocations are enough. This is
// the audit's finding #14 and the interleaving above is the one I traced.
//
// ---- THE PRIMITIVE, AND WHY IT IS THE ONLY ONE ----
//
// The store is a GitHub repo. There is no lease service, no transaction, no
// compare-and-set API beyond the one the contents API already gives us, and
// this file refuses to invent one:
//
//   PUT with NO sha  -> creates the file, or 422 "sha wasn't supplied" if it
//                       already exists.  == create-if-absent.
//   PUT WITH a sha   -> writes, or 409 if the file moved.
//                       == update-if-unchanged.
//
// Both are conditional writes arbitrated by GitHub, so exactly one of two
// racing writers wins each one. Acquiring the claim IS one of those two writes.
// lib/_pending.js already tags both shapes as `err.conflict` (writeUsageDoc),
// and this file re-reads on a conflict rather than guessing which shape it was
// — the same discipline lib/_store.js putFile applies to a 409.
//
// ---- WHAT IS AND IS NOT GUARANTEED ----
//
// GUARANTEED: two sealers that both attempt to acquire cannot both be told
//   yes for the same live claim. The winner is picked by GitHub, not by us.
// GUARANTEED: a sealer that crashes holding the claim does not wedge the queue
//   forever. The claim carries an absolute `expires_at` and any sealer may take
//   over an expired one — by conditional write, so two takers still produce one
//   winner.
// GUARANTEED: a sealer whose claim expired or was taken over while it worked
//   detects that BEFORE the root write (lib/_sealer.js passes `beforeRoot` into
//   batch.sealBatch, which runs it between leaves.json and root.json — the one
//   point where aborting costs nothing but an inert orphan leaf list).
// NOT GUARANTEED — and this is the honest part: this is a LEASE, not a lock.
//   Between the pre-root check and the root PUT landing at GitHub there is a
//   window. A sealer that stalls inside that window past its expiry, while
//   another takes over and seals, can still publish a second root over the same
//   leaves. The TTL is sized so that window is far smaller than a run (default
//   120s against a 60s cadence), and nothing here claims it is zero.
//   The property that does hold without qualification: such a violation SHOWS.
//   tools/reconcile_batches.js reports any leaf carried by two batches, and the
//   roots chain publicly, so a double-seal is evidence in the record rather
//   than a silence.
// NOT GUARANTEED: clock agreement. Expiry is compared against each runner's own
//   wall clock. A runner whose clock is far ahead will take over a claim that
//   is, by the holder's clock, still live. The TTL must exceed (worst run
//   duration + worst clock skew) for the lease to mean what it says; 120s
//   against a single operator-scheduled runner is generous, a fleet with
//   unsynchronized clocks would need it raised.
// NOT GUARANTEED: anything at all about writers that do not take the claim. It
//   binds the sealers, and the sealers are the only writers of roots.
//
// ---- WHY A LEASE AND NOT A QUEUE ----
//
// A wedged claim costs at most one TTL of not-sealing, and not-sealing is
// already a safe state in this design: the leaves stay in the pending document
// and the next run absorbs them (§10 T4). A claim that never expires would
// trade a bounded delay for an unbounded one and would need a human to clear
// it. So the expiry is not a nicety — it is what keeps the failure mode on the
// harmless side of the line.

"use strict";

const crypto = require("crypto");
const os = require("os");
const pending = require("./_pending.js");

// Beside the pending document, in the same private usage repo, because that is
// where the CAS primitive is and because a lock file in the PUBLIC pin repo
// would be operational noise inside the customer-facing record.
const CLAIM_PATH = "pending/seal_claim.json";

// Two batch intervals (§3.4's default is 60s). Long enough that a normal seal
// never races its own expiry, short enough that a crashed sealer costs two
// missed intervals and not a morning.
const CLAIM_TTL_SECONDS = 120;

// Bounded, like every retry here. Each attempt RE-READS: a conflict is either
// branch-ref contention (retry) or another sealer got there (refuse), and the
// re-read is what tells them apart.
const ACQUIRE_ATTEMPTS = 3;

function newHolderId() {
  return crypto.randomBytes(8).toString("hex");
}

// Diagnostics only — it is what the operator reads when they want to know which
// box is holding a claim they are about to clear by hand.
function runnerLabel() {
  let host = "unknown";
  try {
    host = os.hostname() || "unknown";
  } catch {
    host = "unknown";
  }
  return `${host}:${process.pid}`;
}

// The claim names the leaf set it covers, so a claim found in the wild says
// what the holder is sealing and not merely that something is. Identity is the
// same tuple tools/reconcile_batches.js dedupes on — (namespace, rows, chain,
// seq) — deliberately NOT the leaf hash, so a claim can be read and compared
// without reproducing the tree recipe.
function scopeDigest(leaves) {
  const ids = (leaves || []).map((l) => [
    String(l.namespace),
    Number(l.rows),
    String(l.chain).toLowerCase(),
    Number(l.seq),
  ]);
  return "sha256:" + crypto.createHash("sha256").update(JSON.stringify(ids), "utf-8").digest("hex");
}

// Is this claim still holding the door? An UNPARSEABLE expiry counts as live,
// on purpose: a corrupt claim document wedges the sealer (harmless — leaves
// wait in the pending document) rather than opening the door to two sealers
// (not harmless — two roots over one leaf, published). Recovery is the operator
// deleting the file, and the "before turning the flag on" checklist says so.
function isLive(claim, nowMs) {
  if (!claim || typeof claim !== "object") return false;
  if (claim.state === "released") return false;
  const exp = Date.parse(claim.expires_at);
  if (!Number.isFinite(exp)) return true;
  return nowMs < exp;
}

// Take the claim, or say why not. NEVER throws: a refusal is a value, same as
// everywhere else in the sealer.
//
// Returns {ok:true, holder, claim, took_over} or
//         {ok:false, reason, ...detail}. Reasons:
//   seal_claim_held        another sealer holds a live claim. Normal, expected,
//                          and the whole point. Not an error.
//   claim_store_unreadable the claim file could not be READ. Fail closed: an
//                          unknown is not a free door.
//   seal_claim_race_lost   we lost the conditional write itself after re-reading.
//   claim_write_failed     the write failed for a non-conflict reason.
async function acquire({
  now = new Date(),
  ttlSeconds = CLAIM_TTL_SECONDS,
  scope = null,
  attempts = ACQUIRE_ATTEMPTS,
  holder = null,
} = {}) {
  const id = holder || newHolderId();
  const nowMs = now.getTime();
  let lastErr = null;

  for (let i = 0; i < attempts; i++) {
    let cur;
    try {
      cur = await pending.readUsageDoc(CLAIM_PATH);
    } catch (err) {
      return { ok: false, reason: "claim_store_unreadable", detail: err && err.message };
    }

    if (cur && isLive(cur.json, nowMs)) {
      return {
        ok: false,
        reason: "seal_claim_held",
        held_by: cur.json.holder || null,
        runner: cur.json.runner || null,
        expires_at: cur.json.expires_at || null,
        held_scope: cur.json.scope || null,
      };
    }

    const prior = cur ? cur.json : null;
    const doc = {
      holder: id,
      runner: runnerLabel(),
      state: "held",
      acquired_at: now.toISOString(),
      expires_at: new Date(nowMs + ttlSeconds * 1000).toISOString(),
      ttl_seconds: ttlSeconds,
      scope: scope || null,
      // What was here before, kept so a takeover is legible in the file itself
      // rather than only in a log nobody reads.
      took_over: prior
        ? {
            holder: prior.holder || null,
            state: prior.state || null,
            expires_at: prior.expires_at || null,
            reason: prior.state === "released" ? "released" : "expired",
          }
        : null,
      note:
        "the single-sealer claim (lib/_claim.js). Held for the length of one seal. A holder that dies leaves this " +
        "behind; it expires at expires_at and any sealer may then take it over by conditional write. Safe to delete " +
        "by hand when no sealer is running.",
    };

    try {
      await pending.writeUsageDoc(
        CLAIM_PATH,
        doc,
        cur ? cur.sha : undefined,
        prior
          ? `seal claim: ${id} takes over ${prior.holder || "an unnamed claim"} (${doc.took_over.reason})`
          : `seal claim: ${id} acquires`
      );
      return { ok: true, holder: id, claim: doc, took_over: !!prior };
    } catch (err) {
      lastErr = err;
      // A conflict here is ambiguous BY SHAPE: a 422 means somebody created the
      // file between our read and our write (we lost), a 409 can mean the same
      // OR that the branch ref simply moved under the PUT (lib/_store.js's
      // measured case — 465 409s out of 532 writes that raced nothing). The
      // only honest resolution is to re-read and look, which is the next turn
      // of this loop.
      if (err && err.conflict && i < attempts - 1) continue;
      return {
        ok: false,
        reason: err && err.conflict ? "seal_claim_race_lost" : "claim_write_failed",
        detail: err && err.message,
      };
    }
  }

  return { ok: false, reason: "claim_did_not_converge", detail: lastErr && lastErr.message };
}

// Do we still hold it? Called before the root write. Fail closed in every
// direction — a claim store that cannot be read is not a claim we can prove we
// still hold, and the answer to "I cannot prove it" before publishing a root is
// no.
//
// Returns {held:true, expires_at} or {held:false, reason, ...}.
async function check(holder, { now = new Date() } = {}) {
  let cur;
  try {
    cur = await pending.readUsageDoc(CLAIM_PATH);
  } catch (err) {
    return { held: false, reason: "claim_store_unreadable", detail: err && err.message };
  }
  if (!cur) return { held: false, reason: "claim_vanished" };
  const c = cur.json || {};
  if (c.holder !== holder) return { held: false, reason: "taken_over", held_by: c.holder || null };
  if (c.state === "released") return { held: false, reason: "released" };
  const exp = Date.parse(c.expires_at);
  // Expired but still ours is still NO: the door is open to a taker from this
  // instant, and "nobody has taken it yet" is a race, not a permission.
  if (Number.isFinite(exp) && now.getTime() >= exp) {
    return { held: false, reason: "expired", expires_at: c.expires_at };
  }
  return { held: true, expires_at: c.expires_at || null };
}

// Give it back. Conditional on the file being ours and unchanged, so a release
// can never clobber a sealer that has already taken over. Best effort and it
// NEVER throws: a failed release costs one TTL of waiting, which is exactly the
// cost the expiry exists to bound.
async function release(holder, { now = new Date(), outcome = null } = {}) {
  let cur;
  try {
    cur = await pending.readUsageDoc(CLAIM_PATH);
  } catch (err) {
    return { ok: false, reason: "claim_store_unreadable", detail: err && err.message };
  }
  if (!cur) return { ok: false, reason: "claim_vanished" };
  const c = cur.json || {};
  if (c.holder !== holder) return { ok: false, reason: "not_ours", held_by: c.holder || null };
  const next = { ...c, state: "released", released_at: now.toISOString(), outcome: outcome || null };
  try {
    await pending.writeUsageDoc(CLAIM_PATH, next, cur.sha, `seal claim: ${holder} releases (${outcome || "done"})`);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err && err.conflict ? "raced" : "write_failed", detail: err && err.message };
  }
}

module.exports = {
  CLAIM_PATH,
  CLAIM_TTL_SECONDS,
  ACQUIRE_ATTEMPTS,
  scopeDigest,
  isLive,
  acquire,
  check,
  release,
};
