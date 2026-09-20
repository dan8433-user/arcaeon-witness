// _batch.js — accumulate accepted pins into one Merkle tree, commit ONE root,
// and mint a per-pin inclusion proof against it. MERKLE_BATCHING_DESIGN.md
// §3.3 (root record and the root chain), §3.4 (cadence of sealing), §5 (proof
// object), §6.3 (same-batch conflicts).
//
// THE CONTRACT, in the design's own words (§1): "Group every pin accepted in an
// interval into one Merkle tree and commit only the root. Write cost becomes
// O(1) per interval — a fixed small number of commits regardless of whether the
// interval held 1 pin or 10,000."
//
// The tree itself is lib/_merkle.js and this file does not reimplement any of
// it. What lives here is everything that touches the store or a clock.
//
// ---- WHAT THIS FILE DOES NOT DO, on purpose ----
//
// It does not change how a pin is accepted, recorded, or read. api/pin.js still
// writes its numbered seq record and its latest.json pointer per pin; api/verify
// and api/latest still read exactly those files. That is §9's Phase 1 — "Keep
// per-pin commits exactly as they are. Additionally build batches and commit
// roots. Nothing reads the roots. This is the correctness proof: every batch
// root must be recomputable from the individually-committed pins, which is only
// checkable while both exist." A receipt issued before any of this existed
// verifies by exactly the path it always did, because that path is untouched.
//
// ---- THE FAILURE ATOM ----
//
// A batch's publication atom is the SINGLE WRITE OF root.json. Everything else
// is arranged around making that true:
//
//   1. leaves.json is written FIRST. A leaf list that names no root is an inert
//      orphan — it makes no claim, nothing points at it, and no proof can cite
//      it, because a proof cites root.json's commit (§5, `root_ref`).
//   2. root.json is written SECOND and LAST. The instant it commits, every leaf
//      in the batch is covered; until it commits, none is.
//   3. Proofs are minted ONLY from a batch whose root write returned. buildProof
//      refuses on an unsealed batch and that refusal is structural, not a
//      comment — it is what makes "no pin claims a root that was never
//      published" a property of the code rather than of the ordering.
//
// So a failed seal leaves: no root file, no proofs, an unmoved chain tip, and a
// leaf set the caller hands to the next batch. That is §10's T4 — "bounded
// retry with the next batch absorbing the unsealed leaves" — and T4 is honest
// that correlated failure is a real cost of batching, not one retry logic
// erases.
//
// ---- THE 409 RETRY ----
//
// Every write here goes through store.putFile, which carries the bounded,
// jittered, re-reading 409 retry from task 093 (aaa1378). Nothing in this file
// retries a write itself; there is no second retry implementation to drift.
// No `rebuild` hook is offered on either path, and that is deliberate: both
// files are create-only within a batch id, so a 409 that survives the retry
// means the path genuinely moved under us, and the only safe answer is to fail
// the seal rather than overwrite a root somebody else published.

"use strict";

const merkle = require("./_merkle.js");

// §3.4 defaults, as proposed. They are published in every root record (§3.3)
// and on /status (§7) precisely so growing them quietly is not available to us
// — §10's T5: "Nothing in the mechanism stops us from quietly growing
// batch_interval_seconds to cut cost, degrading every customer invisibly.
// Fence: publish it in every root."
const BATCH_INTERVAL_SECONDS = 60;
const MAX_SEAL_LAG_SECONDS = 300;
// §3.4 trigger 2: "max_leaves reached (proposal: 4096 — keeps proof paths ≤ 12
// hashes and leaves files small enough to fetch whole)."
const MAX_LEAVES = 4096;

const BATCH_ID_WIDTH = 9; // "000000123" in §3.3's worked example

function batchName(batchId) {
  return String(batchId).padStart(BATCH_ID_WIDTH, "0");
}
function rootPath(batchId) {
  return `batches/${batchName(batchId)}/root.json`;
}
function leavesPath(batchId) {
  return `batches/${batchName(batchId)}/leaves.json`;
}

// Open a batch. `prev_root` is §3.3's non-optional field: "A Merkle root alone
// does not stop the witness from publishing two different trees for the same
// interval to two different audiences (equivocation / split view). Chaining the
// roots means an equivocating witness must fork the chain publicly, in a public
// repo, where the fork is the evidence."
//
// null is the legitimate value for batch 1 and ONLY for batch 1 — a later batch
// opened with a null prev_root is refused at seal time rather than committing a
// root that quietly starts a second chain.
// `chain_starts_here` is the ONLY licence to seal with a null prev_root at an
// id above 1, and it is not a caller's opinion — readPrevRoot returns it, and
// returns it only after proving by reading that no earlier root was ever
// published. It exists because a batch id is CONSUMED, not reused: a seal that
// dies before its root write retires its id (its orphan leaves.json is still
// sitting there, and rewriting it would be the one thing §9 promises never
// happens), so the id sequence legitimately has gaps and "batch_id > 1"
// stopped being the same question as "something came before me."
function openBatch({ batch_id, opened_at, prev_root = null, chain_starts_here = false, batch_interval_seconds = BATCH_INTERVAL_SECONDS, max_seal_lag_seconds = MAX_SEAL_LAG_SECONDS } = {}) {
  if (!Number.isInteger(batch_id) || batch_id < 1) {
    throw new RangeError("batch: batch_id must be a positive integer");
  }
  return {
    batch_id,
    opened_at: opened_at || new Date().toISOString(),
    prev_root,
    chain_starts_here: chain_starts_here || batch_id === 1,
    batch_interval_seconds,
    max_seal_lag_seconds,
    leaves: [], // §3.2: acceptance order, and this array IS the accept counter
    dropped: [], // §6.3 conflicts removed before sealing
    sealed: false,
    root: null,
    sealed_at: null,
    root_commit: null,
  };
}

// Add an accepted pin. Returns its leaf index — the batch's internal accept
// counter, which §3.2 names as the leaf order.
function addLeaf(batch, pin) {
  if (batch.sealed) throw new Error("batch: cannot add a leaf to a sealed batch");
  if (batch.leaves.length >= MAX_LEAVES) {
    const err = new RangeError(`batch: max_leaves (${MAX_LEAVES}) reached — seal before adding more`);
    err.seal_now = true;
    throw err;
  }
  batch.leaves.push(merkle.leafObjectFromPin(pin));
  return batch.leaves.length - 1;
}

// §3.4 trigger 3 and §4.4's consequence: a pending pin is ungradeable, so a pin
// whose own deadline is close must be sealed before it expires. Returns the
// reason the batch should seal now, or null.
function sealTrigger(batch, now = Date.now(), sealSafetyMarginSeconds = MAX_SEAL_LAG_SECONDS) {
  if (batch.leaves.length === 0) return null; // §3.2: empty interval commits no root
  if (batch.leaves.length >= MAX_LEAVES) return "max_leaves";
  const openedMs = Date.parse(batch.opened_at);
  if (Number.isFinite(openedMs) && now - openedMs >= batch.batch_interval_seconds * 1000) {
    return "interval_elapsed";
  }
  for (const leaf of batch.leaves) {
    const dueMs = Date.parse(leaf.next_pin_due_by);
    if (Number.isFinite(dueMs) && dueMs - now <= sealSafetyMarginSeconds * 1000) return "deadline_forces_seal";
  }
  return null;
}

// §6.3: "Even with §6.1, a store outage or a race could land two conflicting
// leaves in one batch. Decision: the sealer re-checks. Before sealing, scan the
// batch for duplicate (namespace, rows) leaves with differing chain. On a hit:
// drop the later leaf from the tree, write an observation immediately, and
// seal."
//
// The LATER leaf is dropped, never the earlier one — api/pin.js:183-184's rule
// is that a conflict "never advances accepted state", so the accepted state is
// whichever leaf got there first and the challenger is the one that must not
// ride into a root. Returns the conflicts; it does not mutate the batch.
function findSameBatchConflicts(batch) {
  const accepted = new Map(); // "ns|rows" -> {index, chain}
  const conflicts = [];
  batch.leaves.forEach((leaf, index) => {
    const k = `${leaf.namespace}|${leaf.rows}`;
    const prior = accepted.get(k);
    if (!prior) {
      accepted.set(k, { index, chain: String(leaf.chain).toLowerCase() });
      return;
    }
    if (String(leaf.chain).toLowerCase() === prior.chain) return; // idempotent restatement, not a conflict
    conflicts.push({
      index,
      accepted_index: prior.index,
      namespace: leaf.namespace,
      rows: leaf.rows,
      accepted_chain: prior.chain,
      claimed_chain: String(leaf.chain).toLowerCase(),
    });
  });
  return conflicts;
}

// How far back readPrevRoot will look for a published root before it refuses
// to guess. Ids are consumed by failed seals, so gaps are normal and a single
// id-1 probe would mistake one retired id for the start of the chain.
const MAX_CHAIN_LOOKBACK = 64;

// Recover the chain tip without spending a write. §3.3 publishes prev_root
// inside each root record, so the previous root is readable from the previous
// batch's own file — there is no pointer file to maintain, therefore no third
// write per batch and no pointer that can rewind.
//
// Returns { prev_root, chain_starts_here, scanned }. `chain_starts_here` is
// true ONLY when the walk reached batch id 1 and found no published root at
// all, which is the one state in which a null prev_root is a fact rather than
// an assumption. A walk that exhausts MAX_CHAIN_LOOKBACK with earlier ids still
// unread throws `chain_break` rather than reporting a chain start it did not
// establish — silently starting a second chain is the exact failure §3.3's
// prev_root exists to make impossible.
async function readPrevRoot(store, batchId, { maxLookback = MAX_CHAIN_LOOKBACK } = {}) {
  let scanned = 0;
  for (let id = batchId - 1; id >= 1; id--) {
    const rec = await store.getFile(rootPath(id));
    scanned += 1;
    if (rec) return { prev_root: rec.json.root, chain_starts_here: false, scanned };
    if (scanned >= maxLookback && id > 1) {
      const err = new Error(
        `batch: no published root in the last ${maxLookback} ids before ${batchName(batchId)}, and earlier ids are unread — refusing to assume this is the start of the chain`
      );
      err.chain_break = true;
      throw err;
    }
  }
  return { prev_root: null, chain_starts_here: true, scanned };
}

// Seal the batch: build the tree, write leaves.json, write root.json, mint the
// proofs. Two writes to the pin repo, whatever the leaf count — plus one
// unbatched observation write per §6.3 conflict, which §6.2 refuses to batch:
// "An observation is the record of a detected attack in progress. It is the one
// write in this system with a live adversary attached, and delaying its
// publication to save an API call is optimizing the wrong variable."
//
// Throws on a write failure. The throw carries `.stage` so a caller can tell an
// unpublished batch (stage "root": nothing is claimed) from an orphaned leaf
// list (stage "leaves": also nothing is claimed). In both cases batch.sealed
// stays false and no proof exists.
//
// `opts.beforeRoot` (added 2026-09-20) is an optional async gate called AFTER
// leaves.json and BEFORE root.json — the last instant at which aborting costs
// nothing. Throwing from it publishes no root, mints no proof, and leaves
// behind only the inert orphan leaf list this file's own header already
// describes as making no claim. lib/_sealer.js uses it to re-check the seal
// claim, so a sealer whose lease expired mid-run stops one write short of
// publishing a second root over somebody else's leaves. Nothing else passes it
// and the default is no gate, so every existing caller is unchanged.
async function sealBatch(store, batch, { now = new Date(), beforeRoot = null } = {}) {
  if (batch.sealed) throw new Error("batch: already sealed");
  if (batch.leaves.length === 0) {
    // §3.2: "An interval with no pins simply produces no commit." Not an error,
    // and deliberately not a manufactured empty root.
    return { sealed: false, reason: "empty_interval_commits_no_root", writes: 0, proofs: [] };
  }
  if (!batch.prev_root && !batch.chain_starts_here) {
    const err = new Error(
      "batch: prev_root is required unless readPrevRoot proved no earlier root was published (§3.3)"
    );
    err.chain_break = true;
    throw err;
  }

  // --- §6.3 re-check, BEFORE the tree is built ---
  const conflicts = findSameBatchConflicts(batch);
  let leaves = batch.leaves;
  if (conflicts.length) {
    const drop = new Set(conflicts.map((c) => c.index));
    for (const c of conflicts) {
      const observedAt = now.toISOString();
      const obs = {
        observed_at: observedAt,
        claimed: { namespace: c.namespace, rows: c.rows, chain: c.claimed_chain },
        accepted_head: { rows: c.rows, chain: c.accepted_chain },
        auth_result: "key-valid-for-namespace",
        verdict: "head-conflict: same rows, different chain (re-mint signature)",
        detected_by: "batch sealer (§6.3 same-batch re-check)",
        batch_id: batchName(batch.batch_id),
        note:
          "two conflicting leaves landed in one batch; the LATER leaf was dropped from the tree and is not covered by this batch's root — a conflict discovered at seal time is still a detection and never advances accepted state",
      };
      // Immediate and unbatched (§6.2), and through the same putFile whose 409
      // retry task 093 added — no separate retry path.
      await store.putFile(
        `observations/${c.namespace}/${observedAt.replace(/[:.]/g, "-")}.json`,
        obs,
        `OBSERVATION head-conflict ${c.namespace} rows=${c.rows} (batch ${batchName(batch.batch_id)} seal-time re-check)`
      );
    }
    leaves = batch.leaves.filter((_, i) => !drop.has(i));
    batch.dropped = conflicts;
    if (leaves.length === 0) {
      return { sealed: false, reason: "empty_interval_commits_no_root", writes: 0, proofs: [], conflicts };
    }
  }

  const leafHashes = leaves.map((l) => merkle.leafHash(l));
  const levels = merkle.buildLevels(leafHashes);
  const rootBuf = merkle.rootOf(levels);
  const rootLabel = merkle.labelled(merkle.MERKLE_RECIPE, rootBuf);
  const sealedAt = now.toISOString();
  const namespaces = Array.from(new Set(leaves.map((l) => l.namespace))).sort();

  // --- write 1 of 2: the leaf list (§10 T3 — published so any proof is
  // recomputable from public data by anyone, forever, with us gone) ---
  const leavesDoc = {
    batch_id: batchName(batch.batch_id),
    tree_size: leaves.length,
    leaf_recipe: merkle.LEAF_RECIPE,
    recipe: merkle.MERKLE_RECIPE,
    root: rootLabel,
    leaves,
    leaf_hashes: leafHashes.map((h) => h.toString("hex")),
    note:
      "the complete leaf list for this batch, in acceptance order, published so any inclusion proof against this root is recomputable from public data without asking the witness for anything",
  };
  let leavesPut;
  try {
    leavesPut = await store.putFile(
      leavesPath(batch.batch_id),
      leavesDoc,
      `batch ${batchName(batch.batch_id)} leaves tree_size=${leaves.length}`
    );
  } catch (err) {
    err.stage = "leaves";
    err.batch_id = batchName(batch.batch_id);
    throw err;
  }

  // --- the last gate before the atom (opts.beforeRoot) ---
  // Deliberately AFTER leaves.json: the leaf list is inert, so an abort here
  // costs an orphan file and nothing else, and putting the gate as late as
  // possible is what makes it a real answer to "is this still my seal?" rather
  // than a stale one taken minutes earlier.
  if (beforeRoot) {
    try {
      await beforeRoot({ batch_id: batchName(batch.batch_id), tree_size: leaves.length, root: rootLabel });
    } catch (err) {
      err.stage = err.stage || "before_root";
      err.batch_id = batchName(batch.batch_id);
      err.unsealed_leaves = leaves; // same hand-off as a failed root write (§10 T4)
      throw err;
    }
  }

  // --- write 2 of 2: THE ATOM. Nothing claims this root until this returns ---
  const rootDoc = {
    batch_id: batchName(batch.batch_id),
    root: rootLabel,
    prev_root: batch.prev_root,
    tree_size: leaves.length,
    opened_at: batch.opened_at,
    sealed_at: sealedAt,
    batch_interval_seconds: batch.batch_interval_seconds,
    max_seal_lag_seconds: batch.max_seal_lag_seconds,
    leaves_file: leavesPath(batch.batch_id),
    namespaces,
    recipe: merkle.MERKLE_RECIPE,
    leaf_recipe: merkle.LEAF_RECIPE,
    // §2 item 6: "Batched records carry the same stamp; batching does not
    // upgrade our auth story and must not appear to."
    auth_level: leaves[0].auth_level,
  };
  let rootPut;
  try {
    rootPut = await store.putFile(
      rootPath(batch.batch_id),
      rootDoc,
      `batch ${batchName(batch.batch_id)} root tree_size=${leaves.length}`
    );
  } catch (err) {
    err.stage = "root";
    err.batch_id = batchName(batch.batch_id);
    err.unsealed_leaves = leaves; // hand them to the next batch (§10 T4)
    throw err;
  }

  batch.sealed = true;
  batch.sealed_leaves = leaves;
  batch.levels = levels;
  batch.root = rootLabel;
  batch.sealed_at = sealedAt;
  batch.root_commit = (rootPut && rootPut.commit && rootPut.commit.sha) || null;

  return {
    sealed: true,
    batch_id: batchName(batch.batch_id),
    root: rootLabel,
    prev_root: batch.prev_root,
    tree_size: leaves.length,
    sealed_at: sealedAt,
    conflicts,
    // Contents-API PUT attempts actually spent, same honesty as api/pin.js's
    // write_attempts: a seal that took a 409 retry says so.
    write_attempts: (leavesPut.attempts || 1) + (rootPut.attempts || 1),
    writes: 2,
    proofs: leaves.map((_, i) => buildProof(batch, i)),
  };
}

// The §5 proof object. Refuses on an unsealed batch — see THE FAILURE ATOM
// above. This refusal is the enforcement, not the comment.
function buildProof(batch, leafIndex, { repo = null } = {}) {
  if (!batch.sealed) {
    const err = new Error(
      "batch: refusing to mint a proof against an unpublished root — the batch has not sealed"
    );
    err.unsealed = true;
    throw err;
  }
  const leaves = batch.sealed_leaves;
  if (!Number.isInteger(leafIndex) || leafIndex < 0 || leafIndex >= leaves.length) {
    throw new RangeError(`batch: leaf index ${leafIndex} is outside batch ${batchName(batch.batch_id)}`);
  }
  const leaf = leaves[leafIndex];
  const proof = {
    leaf,
    leaf_hash: merkle.labelled(merkle.LEAF_RECIPE, merkle.leafHash(leaf)),
    leaf_index: leafIndex,
    tree_size: leaves.length,
    path: merkle.proofPath(batch.levels, leafIndex),
    root: batch.root,
    root_ref: {
      batch_id: batchName(batch.batch_id),
      path: rootPath(batch.batch_id),
      commit_sha: batch.root_commit,
      sealed_at: batch.sealed_at,
    },
    leaves_file: leavesPath(batch.batch_id),
    recipe: merkle.MERKLE_RECIPE,
  };
  if (repo) {
    proof.root_ref.commit_url = batch.root_commit ? `https://github.com/${repo}/commit/${batch.root_commit}` : null;
    proof.leaves_url = `https://github.com/${repo}/blob/main/${leavesPath(batch.batch_id)}`;
  }
  return proof;
}

module.exports = {
  BATCH_INTERVAL_SECONDS,
  MAX_SEAL_LAG_SECONDS,
  MAX_LEAVES,
  MAX_CHAIN_LOOKBACK,
  batchName,
  rootPath,
  leavesPath,
  openBatch,
  addLeaf,
  sealTrigger,
  findSameBatchConflicts,
  readPrevRoot,
  sealBatch,
  buildProof,
};
