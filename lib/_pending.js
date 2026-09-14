// _pending.js — the pending batch: where an accepted pin waits between accept
// and seal, and the per-namespace pending head that guards what may enter a
// tree. MERKLE_BATCHING_DESIGN.md §6.1 (the window batching opens, the pending
// head, the fail-closed stance), §9 Phase 1, §11 Q2 (where pending state lives).
//
// lib/_batch.js builds and seals a tree. lib/_merkle.js hashes it. NEITHER of
// them holds state between two serverless invocations, and that is the whole
// reason the sealer did not exist: "A serverless request cannot reliably close
// a batch it did not open" (§11 Q3). This file is the state those two were
// missing — one JSON document, read and written under the contents API's
// compare-and-swap, holding the open batch's leaves in acceptance order plus
// the pending head per namespace.
//
// ---- WHERE IT LIVES, AND THE CORRECTION §11 Q2 WAS OWED ----
//
// §6.1 says pending state "lives in the same store" the meter and balance use,
// and describes that store as "a durable non-GitHub store." The second half is
// wrong about this repo as built: lib/_meter.js:22-24 ("Storage: one JSON file
// per key-hash per month, in a PRIVATE GitHub repo") and lib/_balance.js:64
// (`const USAGE_REPO = process.env.GITHUB_USAGE_REPO || ...`) are both the
// GitHub contents API against a private repo. So "reuse the store the meter
// uses" and "use a durable non-GitHub store" are not the same instruction, and
// only the first one is available without adding a dependency this repo does
// not have.
//
// This file reuses the meter/balance store, and the consequence §11 Q2 asked
// about is real and is not papered over: **the contents API does not give
// read-your-writes across instances.** api/pin.js already carries the scar —
// `// A wedge the proactive check missed (contents-API read lag)`. So the
// pending head is a STRONG guard, not a perfect one: a second instance reading
// a stale pending file can admit a conflicting leaf. That is precisely why
// §6.3's seal-time re-check exists, and with this file in place that re-check
// finally is what it was designed to be — a backstop behind a first guard,
// rather than the only guard there is.
//
// ---- THE PRIVACY LINE ----
//
// Leaves hold {namespace, rows, chain, seq, ...} — fingerprints, the same class
// of data the PUBLIC pin repo already publishes, and never log content. They
// sit in the private usage repo for the length of one batch interval only
// because that is where the CAS primitive is. Nothing here writes a usage count
// into the public repo or a fingerprint anywhere it was not already going.

"use strict";

const merkle = require("./_merkle.js");

const USAGE_REPO = process.env.GITHUB_USAGE_REPO || "dan8433-user/arcaeon-witness-usage";
const USAGE_BRANCH = process.env.GITHUB_USAGE_BRANCH || "main";
const API = "https://api.github.com";

// The open batch document. One path, one document, for the whole witness —
// leaf order is acceptance order across all namespaces (§3.2), so there is one
// sequence and therefore one file.
const PENDING_PATH = "pending/open_batch.json";

// Bounded, like every retry in this repo. A CAS loser re-reads and tries again;
// it never spins.
const CAS_ATTEMPTS = 3;

// §9 Phase 1 is a RUN, not a code state: "Run it until a full week reconciles
// clean." A run has an operator who starts it and watches the reconciliation.
// So accumulation is off until someone turns it on, and turning it on is the
// deliberate act of starting the shadow run — not a side effect of deploying an
// unrelated change. §9's rollback ("stop batching, resume per-pin") is this same
// switch in the other direction.
function shadowEnabled() {
  const v = String(process.env.WITNESS_BATCH_SHADOW || "").toLowerCase();
  return v === "on" || v === "1" || v === "true" || v === "yes";
}

function ghHeaders() {
  const h = {
    accept: "application/vnd.github+json",
    "user-agent": "arcaeon-witness-pending",
    "x-github-api-version": "2022-11-28",
  };
  // Same PAT the meter and balance stores already use against this same repo
  // (lib/_meter.js: "Reuses GITHUB_PIN_TOKEN"). No second secret.
  const tok = process.env.GITHUB_PIN_TOKEN;
  if (tok) h.authorization = `Bearer ${tok}`;
  return h;
}

// Returns {json, sha} or null on 404. THROWS on anything else, and that throw
// is load-bearing: it is the difference between "there is no open batch" (a
// fact, seal nothing, fine) and "I cannot see the open batch" (an unknown, and
// the sealer must refuse). A reader that collapses those two into one falsy
// answer is exactly the failure §6.1 calls fail-open.
async function readPending() {
  const r = await fetch(`${API}/repos/${USAGE_REPO}/contents/${PENDING_PATH}?ref=${USAGE_BRANCH}`, {
    headers: ghHeaders(),
  });
  if (r.status === 404) return null;
  if (!r.ok) {
    console.error(`[pending] GET ${PENDING_PATH} -> ${r.status}`);
    const err = new Error(`pending store read failed (${r.status})`);
    err.unreadable = true;
    throw err;
  }
  const body = await r.json();
  const text = Buffer.from(body.content, "base64").toString("utf-8");
  return { json: JSON.parse(text), sha: body.sha };
}

// Same conflict vocabulary as lib/_meter.js and lib/_balance.js: a 409 (update
// race) and a 422 whose message says a sha "wasn't supplied" (create race) are
// both `err.conflict = true`, so a caller re-reads instead of guessing.
async function writePending(state, sha, message) {
  const payload = {
    message,
    branch: USAGE_BRANCH,
    content: Buffer.from(JSON.stringify(state, null, 2) + "\n").toString("base64"),
  };
  if (sha) payload.sha = sha;
  const r = await fetch(`${API}/repos/${USAGE_REPO}/contents/${PENDING_PATH}`, {
    method: "PUT",
    headers: { ...ghHeaders(), "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (r.status === 409) {
    const err = new Error("pending store write conflict (concurrent writer)");
    err.conflict = true;
    throw err;
  }
  if (!r.ok) {
    const detail = await r.text().catch(() => "");
    const isCreateRace = r.status === 422 && /sha.*wasn't supplied/i.test(detail);
    console.error(`[pending] PUT ${PENDING_PATH} -> ${r.status}: ${detail.slice(0, 300)}`);
    const err = new Error(`pending store write failed (${r.status})`);
    if (isCreateRace) err.conflict = true;
    throw err;
  }
  return r.json();
}

function initialState(now) {
  return {
    // The batch being filled right now.
    open: { batch_id: 1, opened_at: (now || new Date()).toISOString(), leaves: [] },
    // A batch that has been CLOSED (its leaf set frozen) but whose root write
    // has not been confirmed. §10 T4's "next batch absorbing the unsealed
    // leaves" is implemented against this slot.
    sealing: null,
    // §6.1's pending head, per namespace. Carries across batches — it is the
    // witness's view of accepted state, not a per-batch scratchpad.
    heads: {},
    updated_at: (now || new Date()).toISOString(),
    note:
      "the open Merkle batch and the pending head per namespace (MERKLE_BATCHING_DESIGN.md §6.1, §9 Phase 1). " +
      "Fingerprints only, same class of data as the public pin repo, never log content. Transient: a leaf lives " +
      "here from accept until its root commits.",
  };
}

// Refuse to work with a leaf set we cannot hash. A pending document that has
// been truncated, hand-edited, or written by an older shape must stop a seal,
// not produce a root over a partial leaf — the same fail-closed rule
// merkle.leafObjectFromPin applies one level down ("refusing to hash a partial
// leaf").
function validateLeaves(leaves, where) {
  if (!Array.isArray(leaves)) {
    const err = new TypeError(`pending: ${where} is not an array of leaves`);
    err.corrupt = true;
    throw err;
  }
  leaves.forEach((leaf, i) => {
    if (!leaf || typeof leaf !== "object") {
      const err = new TypeError(`pending: ${where}[${i}] is not a leaf object`);
      err.corrupt = true;
      throw err;
    }
    for (const f of merkle.LEAF_FIELDS) {
      if (leaf[f] === undefined || leaf[f] === null) {
        const err = new TypeError(`pending: ${where}[${i}] is missing leaf field "${f}"`);
        err.corrupt = true;
        throw err;
      }
    }
  });
  return leaves;
}

// §6.1's guard, run against PENDING state rather than only committed state:
// "the comparison uses the later of (committed latest.json, pending head)."
//
// Returns a typed refusal or null. Same rows + different chain is the re-mint
// signature api/pin.js:683 already refuses against committed state; a leaf that
// matches it must not enter a tree, because a root is a published claim and
// api/pin.js:183-184's rule is that a conflict "never advances accepted state."
//
// Lower rows than the pending head is a regression. api/pin.js's monotonic
// guard rejects it before this is ever reached, so seeing one here means the
// committed and pending views have diverged — refuse the leaf rather than let a
// backward head into the tree or overwrite the pending head with it.
function headConflict(state, leaf) {
  const head = state.heads && state.heads[leaf.namespace];
  if (!head) return null;
  if (Number.isInteger(head.rows) && leaf.rows < head.rows) {
    return {
      reason: "pending_head_regression",
      namespace: leaf.namespace,
      pending_rows: head.rows,
      claimed_rows: leaf.rows,
    };
  }
  if (head.rows === leaf.rows && String(head.chain).toLowerCase() !== String(leaf.chain).toLowerCase()) {
    return {
      reason: "pending_head_conflict",
      namespace: leaf.namespace,
      rows: leaf.rows,
      accepted_chain: String(head.chain).toLowerCase(),
      claimed_chain: String(leaf.chain).toLowerCase(),
    };
  }
  return null;
}

function advanceHead(state, leaf) {
  state.heads[leaf.namespace] = {
    rows: leaf.rows,
    chain: String(leaf.chain).toLowerCase(),
    seq: leaf.seq,
    accepted_at: leaf.accepted_at,
    record_kind: leaf.record_kind,
  };
}

// Append one accepted pin to the open batch. CAS, bounded retry, re-reading on
// each attempt so a loser's leaf lands in whatever batch is open when it wins —
// which is the mechanism behind "a pin accepted during a seal is not lost": the
// sealer's close and this append contend for the SAME document sha, so exactly
// one of them wins each round, and the loser re-reads and lands on the other
// side of the boundary rather than vanishing.
//
// Throws. api/pin.js does not call this directly — see recordAcceptedSafe.
async function recordAccepted(pin, { attempts = CAS_ATTEMPTS, now = new Date() } = {}) {
  const leaf = merkle.leafObjectFromPin(pin);
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    const cur = await readPending();
    const state = cur ? cur.json : initialState(now);
    if (!state.open || !Array.isArray(state.open.leaves)) {
      const err = new TypeError("pending: open batch document has no leaf array");
      err.corrupt = true;
      throw err;
    }
    const conflict = headConflict(state, leaf);
    if (conflict) {
      // Refused into the tree, and NOT an error for the pin: api/pin.js already
      // decided this pin's fate against committed state and its record is
      // written. This only says the leaf does not enter a root.
      return { ok: false, refused: true, ...conflict, batch_id: state.open.batch_id };
    }
    state.open.leaves.push(leaf);
    advanceHead(state, leaf);
    state.updated_at = now.toISOString();
    try {
      await writePending(
        state,
        cur ? cur.sha : undefined,
        `pending: +1 leaf ${leaf.namespace} rows=${leaf.rows} seq=${leaf.seq} (batch ${state.open.batch_id}, ${state.open.leaves.length} leaves)`
      );
      return {
        ok: true,
        batch_id: state.open.batch_id,
        leaf_index: state.open.leaves.length - 1,
        pending_leaves: state.open.leaves.length,
        attempts: i + 1,
      };
    } catch (err) {
      lastErr = err;
      if (err && err.conflict && i < attempts - 1) continue;
      throw err;
    }
  }
  throw lastErr || new Error("pending: append did not converge");
}

// What api/pin.js calls. NEVER throws and never changes a pin's outcome.
//
// §9 Phase 1: "Keep per-pin commits exactly as they are." A pin whose record is
// already committed to the public repo has happened; a shadow-run bookkeeping
// failure must not turn it into a 502 after the fact. The miss is logged loudly
// and it is exactly what Phase 1's reconciliation is for — "every batch root
// must be recomputable from the individually-committed pins" is the check that
// catches a leaf this function dropped.
//
// This is NOT §6.1's "if the pending-head store is unavailable, refuse the pin"
// — see the sealer and the design's status block for why that refusal is a
// Phase 3/4 change and not a Phase 1 one.
async function recordAcceptedSafe(pin, opts) {
  if (!shadowEnabled()) return { ok: false, skipped: true, reason: "shadow_disabled" };
  try {
    return await recordAccepted(pin, opts);
  } catch (err) {
    console.error(
      `[pending] leaf NOT accumulated (the pin itself is committed and unaffected): ` +
        `ns=${pin && pin.namespace} seq=${pin && pin.seq} err=${err && err.message}`
    );
    return { ok: false, error: err && err.message, reason: "pending_store_error" };
  }
}

module.exports = {
  PENDING_PATH,
  USAGE_REPO,
  USAGE_BRANCH,
  CAS_ATTEMPTS,
  shadowEnabled,
  readPending,
  writePending,
  initialState,
  validateLeaves,
  headConflict,
  advanceHead,
  recordAccepted,
  recordAcceptedSafe,
};
