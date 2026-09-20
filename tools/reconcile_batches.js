#!/usr/bin/env node
// tools/reconcile_batches.js — the check MERKLE_BATCHING_DESIGN.md §9 Phase 1
// already promised and nothing implemented: "every batch root must be
// recomputable from the individually-committed pins, which is only checkable
// while both exist ... Run it until a full week reconciles clean."
//
// "Reconciles clean" was a sentence with no instrument behind it. This is the
// instrument. It reads; it never writes; it exits non-zero when it finds
// something, and it exits differently again when it could not see enough to
// say.
//
// ---- IT IS A TOOL, NOT AN ENDPOINT ----
//
// Same reason as tools/seal_batch.js: api/ is at the Vercel Hobby 12-function
// cap (9e8b060), so a 13th routed file is not available; and a reconciler is an
// operator instrument run against a watched Phase 1 run, not a public surface.
// tools/ is not routed as functions.
//
// ---- THE FOUR FINDINGS ----
//
//   lost         A pin record is committed in the public repo, its leaf is in
//                no sealed batch, and it is not waiting in the pending
//                document. Audit finding #16's shape: recordAcceptedSafe drops
//                a leaf silently by design (a shadow-run bookkeeping failure
//                must never turn a committed pin into a 502), and a pending
//                head that has raced ahead refuses a legitimately committed
//                pin as `pending_head_regression`. Both are real and both are
//                invisible without this check. A `lost` finding is NOT
//                automatically a bug — a head-conflict refusal is a legitimate
//                cause — but it is always something a human must look at, which
//                is why it is reported rather than filtered.
//   duplicated   One leaf identity carried by two batches. This is the shape a
//                double-seal leaves behind, and it is why lib/_claim.js's
//                honest property is "a violation would SHOW" rather than "a
//                violation is impossible."
//   root_mismatch  A batch's published leaves.json does not hash to the root
//                its own root.json claims. Recomputed here from the published
//                leaf list through the same lib/_merkle.js an outside verifier
//                would use.
//   proof_failed A leaf's inclusion proof, rebuilt from the published leaf
//                list, does not verify against the published root. Built from
//                the DECLARED tree_size and leaf_hashes in leaves.json rather
//                than from the recomputed ones, on purpose: that is the data a
//                stranger has, and a document whose declared fields disagree
//                with its own leaf array fails here even when the array itself
//                hashes correctly.
//
// An orphan leaves.json (a leaf list with no root.json) is NOT a finding. The
// design's failure atom makes it inert — it claims nothing, nothing points at
// it, no proof can cite it — so it is counted and reported as a note. A pile of
// them means seals are failing, which is worth a human's eye, not an alarm.
//
// ---- THREE VERDICTS, NOT TWO ----
//
//   CLEAN       every record in scope was read and nothing was found.
//   FINDINGS    at least one of the four above.
//   INCOMPLETE  something could not be read, or a bound was hit. "I did not
//               look" must never be reported as "nothing is there" — that
//               failure has its own class in this system's scar list, and the
//               whole value of this tool is that its silence means something.
//
// Exit codes: 0 CLEAN, 1 FINDINGS (findings win over incompleteness — a real
// finding is not made less real by an unread file), 2 INCOMPLETE, 64 bad
// arguments, 3 unexpected throw.
//
// ---- THE BOUNDS, AND WHAT HAPPENS PAST THEM ----
//
// Every read is a GitHub contents-API call against the same shared token every
// other surface uses, so an unbounded walk of a large repo is a way to rate-
// limit the paid write path. The caps are MAX_BATCHES and MAX_PIN_RECORDS
// below, both overridable. Past either one the tool STOPS, says exactly how
// many it did not look at, and the verdict becomes INCOMPLETE.
//
// ---- SCOPE ----
//
// A pin committed before batching ever ran legitimately has no leaf, and
// calling it "lost" would bury the real findings in noise. Scope therefore
// starts at the earliest `opened_at` of any batch read, or at --since if given.
// Pins older than that are counted `out_of_scope` and never reported lost.
//
// OPERATOR COMMAND
//
//   GITHUB_PIN_TOKEN=... \
//   GITHUB_PIN_REPO=dan8433-user/arcaeon-witness-pins \
//   GITHUB_USAGE_REPO=dan8433-user/arcaeon-witness-usage \
//   node tools/reconcile_batches.js [--since=<iso>] [--max-batches=N]
//                                   [--max-pins=N] [--json] [--quiet]

"use strict";

const store = require("../lib/_store.js");
const batch = require("../lib/_batch.js");
const merkle = require("../lib/_merkle.js");
const pending = require("../lib/_pending.js");

const MAX_BATCHES = 512;
const MAX_PIN_RECORDS = 5000;

// pins/<namespace>/<zero-padded seq>.json — the numbered record. latest.json is
// a pointer to one of these, never a record of its own, so it is skipped.
const PIN_RECORD_RE = /^pins\/([^/]+)\/(\d+)\.json$/;
const BATCH_FILE_RE = /^batches\/(\d+)\/(root|leaves)\.json$/;

// (namespace, rows, chain, seq) — the same tuple lib/_claim.js digests and the
// one the audit named. Deliberately NOT the leaf hash: an identity that
// required reproducing the tree recipe could not be computed for a pin record
// that predates the leaf shape, and those are exactly the records this tool has
// to be able to place in or out of scope.
function identity(o) {
  return [
    String(o.namespace),
    String(o.rows),
    String(o.chain).toLowerCase(),
    String(o.seq),
  ].join("|");
}

function finding(kind, path, detail) {
  return { kind, path, detail };
}

// Read-only. Returns a report; throws only on a programming error.
async function reconcile({
  since = null,
  maxBatches = MAX_BATCHES,
  maxPins = MAX_PIN_RECORDS,
} = {}) {
  const findings = [];
  const couldNotLook = [];
  const notes = [];

  // ---- the file listing. One call, and its truncation flag is load-bearing.
  let tree;
  try {
    tree = await store.getTreeMeta();
  } catch (err) {
    // Nothing else can be trusted without the listing, so this ends the run as
    // INCOMPLETE rather than as a clean sheet over zero files.
    return report({
      findings,
      couldNotLook: [{ what: "repository listing", detail: err && err.message }],
      notes,
      counts: { batches: 0, pins_seen: 0, pins_in_scope: 0, leaves_in_batches: 0, pending_leaves: 0 },
      scope_start: since,
    });
  }
  if (tree.truncated) {
    couldNotLook.push({
      what: "repository listing",
      detail: "GitHub truncated the recursive tree — an unknown number of files were never listed",
    });
  }

  const batchIds = new Set();
  const pinPaths = [];
  for (const e of tree.entries) {
    if (e.type !== "blob") continue;
    const bm = BATCH_FILE_RE.exec(e.path);
    if (bm) {
      batchIds.add(Number(bm[1]));
      continue;
    }
    if (PIN_RECORD_RE.test(e.path)) pinPaths.push(e.path);
  }

  const sortedBatchIds = Array.from(batchIds).sort((a, b) => a - b);
  const batchesToRead = sortedBatchIds.slice(0, maxBatches);
  if (sortedBatchIds.length > batchesToRead.length) {
    couldNotLook.push({
      what: "batches",
      detail: `${sortedBatchIds.length - batchesToRead.length} of ${sortedBatchIds.length} batches were not read (--max-batches=${maxBatches})`,
    });
  }

  // ---- walk the batches ----
  const leafOwners = new Map(); // identity -> [batch_id, ...]
  let earliestOpened = null;
  let orphanLeafLists = 0;
  let batchesRead = 0;
  let leavesInBatches = 0;

  for (const id of batchesToRead) {
    const rootP = batch.rootPath(id);
    const leavesP = batch.leavesPath(id);

    let rootRec = null;
    let leavesRec = null;
    try {
      rootRec = await store.getFile(rootP);
    } catch (err) {
      couldNotLook.push({ what: rootP, detail: err && err.message });
      continue;
    }
    try {
      leavesRec = await store.getFile(leavesP);
    } catch (err) {
      couldNotLook.push({ what: leavesP, detail: err && err.message });
      continue;
    }

    if (!rootRec) {
      // The designed inert orphan: a leaf list whose seal died before the root
      // write. It claims nothing. Counted, not reported as a finding.
      if (leavesRec) orphanLeafLists += 1;
      continue;
    }
    batchesRead += 1;

    if (!leavesRec) {
      // A root with no published leaf list is the inverse and IS a finding: the
      // root makes a claim nobody can recompute, which §10 T3 exists to prevent.
      findings.push(
        finding("root_mismatch", rootP, "the root is published but its leaves file is missing — nothing can recompute this root")
      );
      continue;
    }

    const doc = leavesRec.json || {};
    const leaves = Array.isArray(doc.leaves) ? doc.leaves : null;
    if (!leaves || leaves.length === 0) {
      findings.push(finding("root_mismatch", leavesP, "the published leaf list is empty or malformed"));
      continue;
    }
    leavesInBatches += leaves.length;

    const openedMs = Date.parse(rootRec.json && rootRec.json.opened_at);
    if (Number.isFinite(openedMs) && (earliestOpened === null || openedMs < earliestOpened)) {
      earliestOpened = openedMs;
    }

    // ownership, for the duplicate check
    for (const leaf of leaves) {
      const key = identity(leaf);
      const owners = leafOwners.get(key) || [];
      owners.push(batch.batchName(id));
      leafOwners.set(key, owners);
    }

    // --- recompute the root from the published leaf list ---
    let recomputed = null;
    try {
      const hashes = leaves.map((l) => merkle.leafHash(l));
      recomputed = merkle.labelled(merkle.MERKLE_RECIPE, merkle.rootOf(merkle.buildLevels(hashes)));
    } catch (err) {
      findings.push(finding("root_mismatch", leavesP, `the leaf list could not be hashed: ${err && err.message}`));
      continue;
    }
    const storedRoot = rootRec.json && rootRec.json.root;
    if (recomputed !== storedRoot) {
      findings.push(
        finding("root_mismatch", rootP, `root.json says ${storedRoot}, the published leaves hash to ${recomputed}`)
      );
      // Keep going: the proofs below will not verify either, and saying so
      // names the blast radius instead of stopping at the first symptom.
    }
    if (doc.root !== undefined && doc.root !== storedRoot) {
      findings.push(
        finding("root_mismatch", leavesP, `leaves.json's own root field (${doc.root}) disagrees with root.json (${storedRoot})`)
      );
    }

    // --- rebuild every proof from the PUBLISHED document and verify it ---
    // The stranger's path: declared tree_size, declared leaf_hashes, the leaf
    // list as published. A document that is internally inconsistent fails here
    // even when its leaf array alone would have hashed fine.
    const declaredSize = Number.isInteger(doc.tree_size) ? doc.tree_size : leaves.length;
    let levels = null;
    try {
      levels = merkle.buildLevels(leaves.map((l) => merkle.leafHash(l)));
    } catch {
      levels = null;
    }
    if (levels) {
      for (let i = 0; i < leaves.length; i++) {
        let path;
        try {
          path = merkle.proofPath(levels, i);
        } catch (err) {
          findings.push(finding("proof_failed", leavesP, `leaf ${i}: no proof path (${err && err.message})`));
          continue;
        }
        const declaredLeafHash =
          Array.isArray(doc.leaf_hashes) && typeof doc.leaf_hashes[i] === "string"
            ? merkle.labelled(merkle.LEAF_RECIPE, Buffer.from(doc.leaf_hashes[i], "hex"))
            : undefined;
        const v = merkle.verifyInclusion({
          leaf: leaves[i],
          leaf_hash: declaredLeafHash,
          leaf_index: i,
          tree_size: declaredSize,
          path,
          root: storedRoot,
          recipe: merkle.MERKLE_RECIPE,
        });
        if (!v.ok) {
          findings.push(
            finding("proof_failed", leavesP, `leaf ${i} (${identity(leaves[i])}) does not verify against the published root: ${v.reason}`)
          );
        }
      }
    }
  }

  // --- duplicates ---
  for (const [key, owners] of leafOwners) {
    if (owners.length > 1) {
      findings.push(
        finding("duplicated", `batches/{${owners.join(",")}}`, `leaf ${key} is carried by ${owners.length} batches: ${owners.join(", ")}`)
      );
    }
  }

  // ---- the pending document: a leaf still waiting is not lost ----
  const pendingIds = new Set();
  let pendingLeaves = 0;
  let pendingState = null;
  try {
    const cur = await pending.readPending();
    pendingState = cur ? cur.json : null;
  } catch (err) {
    // Without it, "not in a batch" cannot be turned into "lost" — a waiting
    // leaf and a dropped one look the same. That is an unknown, not a clean
    // sheet.
    couldNotLook.push({ what: pending.PENDING_PATH, detail: err && err.message });
  }
  if (pendingState) {
    for (const slot of ["open", "sealing"]) {
      const s = pendingState[slot];
      if (!s || !Array.isArray(s.leaves)) continue;
      for (const leaf of s.leaves) {
        pendingIds.add(identity(leaf));
        pendingLeaves += 1;
      }
    }
  }
  const pendingKnown = pendingState !== null || couldNotLook.every((c) => c.what !== pending.PENDING_PATH);

  // ---- walk the pins ----
  const scopeStartMs = since ? Date.parse(since) : earliestOpened;
  const pinsToRead = pinPaths.slice(0, maxPins);
  if (pinPaths.length > pinsToRead.length) {
    couldNotLook.push({
      what: "pin records",
      detail: `${pinPaths.length - pinsToRead.length} of ${pinPaths.length} pin records were not read (--max-pins=${maxPins})`,
    });
  }

  let pinsSeen = 0;
  let pinsInScope = 0;
  let outOfScope = 0;

  for (const p of pinsToRead) {
    let rec;
    try {
      rec = await store.getFile(p);
    } catch (err) {
      couldNotLook.push({ what: p, detail: err && err.message });
      continue;
    }
    if (!rec) {
      couldNotLook.push({ what: p, detail: "listed in the tree but not readable as a file" });
      continue;
    }
    pinsSeen += 1;
    const pin = rec.json || {};
    const pinnedMs = Date.parse(pin.pinned_at);
    if (Number.isFinite(scopeStartMs) && Number.isFinite(pinnedMs) && pinnedMs < scopeStartMs) {
      outOfScope += 1;
      continue;
    }
    if (!Number.isFinite(scopeStartMs)) {
      // Nothing has ever sealed and no --since was given: there is no window in
      // which a leaf was expected, so nothing here can be called lost.
      outOfScope += 1;
      continue;
    }
    pinsInScope += 1;
    const key = identity(pin);
    if (leafOwners.has(key)) continue;
    if (pendingIds.has(key)) continue;
    if (!pendingKnown) continue; // already recorded as an unknown above
    findings.push(
      finding(
        "lost",
        p,
        `committed pin ${key} appears in no sealed batch and is not pending — a dropped leaf, a pending-head refusal, or a seal that never covered it`
      )
    );
  }

  if (orphanLeafLists) {
    notes.push(
      `${orphanLeafLists} orphan leaf list(s): a published leaves.json with no root.json. Inert by design (nothing cites it), but a growing count means seals are failing.`
    );
  }

  return report({
    findings,
    couldNotLook,
    notes,
    counts: {
      batches: batchesRead,
      pins_seen: pinsSeen,
      pins_in_scope: pinsInScope,
      pins_out_of_scope: outOfScope,
      leaves_in_batches: leavesInBatches,
      pending_leaves: pendingLeaves,
      orphan_leaf_lists: orphanLeafLists,
    },
    scope_start: Number.isFinite(scopeStartMs) ? new Date(scopeStartMs).toISOString() : null,
  });
}

function report({ findings, couldNotLook, notes, counts, scope_start }) {
  const verdict = findings.length ? "FINDINGS" : couldNotLook.length ? "INCOMPLETE" : "CLEAN";
  return {
    verdict,
    exit_code: findings.length ? 1 : couldNotLook.length ? 2 : 0,
    findings,
    could_not_look: couldNotLook,
    notes,
    counts,
    scope_start,
    // Said out loud in the output rather than only in this file's header,
    // because the one way this tool can lie is by being read as a clean bill
    // when it simply did not look.
    reading:
      findings.length
        ? "at least one finding — every one names its path; none of them is self-healing"
        : couldNotLook.length
        ? "NOT a clean bill: something could not be read or a bound was hit, so absence here is not evidence of absence"
        : "every record in scope was read and nothing was found",
    read_only: true,
  };
}

function parseArgs(argv) {
  const out = { json: false, quiet: false };
  for (const a of argv) {
    if (a === "--json") out.json = true;
    else if (a === "--quiet") out.quiet = true;
    else if (a === "--help" || a === "-h") out.help = true;
    else if (a.startsWith("--since=")) out.since = a.slice(8);
    else if (a.startsWith("--max-batches=")) out.maxBatches = Number(a.slice(14));
    else if (a.startsWith("--max-pins=")) out.maxPins = Number(a.slice(11));
    else {
      process.stderr.write(`reconcile_batches: unknown argument ${a}\n`);
      return { bad: true };
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.bad) return 64;
  if (args.help) {
    process.stdout.write(require("fs").readFileSync(__filename, "utf-8").split("\n").slice(1, 96).join("\n") + "\n");
    return 0;
  }
  if (!process.env.GITHUB_PIN_TOKEN) {
    process.stderr.write("reconcile_batches: GITHUB_PIN_TOKEN is not set — refusing to report on a repo it cannot read\n");
    return 2;
  }
  if (args.since && !Number.isFinite(Date.parse(args.since))) {
    process.stderr.write("reconcile_batches: --since must be an ISO 8601 timestamp\n");
    return 64;
  }
  for (const k of ["maxBatches", "maxPins"]) {
    if (args[k] !== undefined && (!Number.isFinite(args[k]) || args[k] < 1)) {
      process.stderr.write(`reconcile_batches: --${k === "maxBatches" ? "max-batches" : "max-pins"} must be a positive number\n`);
      return 64;
    }
  }

  const out = await reconcile({
    since: args.since || null,
    maxBatches: args.maxBatches || MAX_BATCHES,
    maxPins: args.maxPins || MAX_PIN_RECORDS,
  });

  if (!args.quiet) {
    if (args.json) {
      process.stdout.write(JSON.stringify(out, null, 2) + "\n");
    } else {
      process.stdout.write(`${out.verdict} — ${out.reading}\n`);
      for (const f of out.findings) process.stdout.write(`  ${f.kind.toUpperCase()}  ${f.path}\n    ${f.detail}\n`);
      for (const c of out.could_not_look) process.stdout.write(`  COULD NOT LOOK  ${c.what}\n    ${c.detail}\n`);
      for (const n of out.notes) process.stdout.write(`  note: ${n}\n`);
      process.stdout.write(`  counts: ${JSON.stringify(out.counts)}\n`);
      process.stdout.write(`  scope starts: ${out.scope_start || "(nothing sealed yet — no pin is in scope)"}\n`);
    }
  }
  return out.exit_code;
}

module.exports = { reconcile, identity, MAX_BATCHES, MAX_PIN_RECORDS };

if (require.main === module) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(`reconcile_batches: UNEXPECTED ${err && err.stack ? err.stack : err}\n`);
      process.exit(3);
    });
}
