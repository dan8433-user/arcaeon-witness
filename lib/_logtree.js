// _logtree.js — ONE cumulative Merkle log over every create-only record file
// the witness publishes, so that a stranger can verify that today's published
// checkpoint extends last week's. DESIGN_CONSISTENCY_AND_NEVER_LOOKED_2026-09-22.md
// Part A (A2 leaf, A2 order, A4 formats, A9 limits). Pure computation: no
// store, no network, no clock, no git. What touches git is tools/publish_checkpoint.js.
//
// Why this exists beside lib/_batch.js (design F1): sealBatch builds a tree over
// ONE batch's leaves and links batches only by prev_root, which is a hash chain
// of roots. A consistency proof needs one tree that grows. This is that tree.
// The hashing is the existing RFC 6962 hashing from lib/_merkle.js (0x00 leaf,
// 0x01 node, odd node promoted), reused and not reimplemented — design F5
// checked that buildLevels already equals the RFC's recursive MTH, and
// test/logtree.test.js makes that check permanent against the reference vectors.
//
// ---- THE LEAF (design A2), stated so a stranger can recompute it ----
//
// A leaf is an ENVELOPE over a record file's exact committed bytes, not a
// re-derived object:
//
//   {"recipe":"sha256:arcaeon-log-leaf:v1",
//    "kind":"pin" | "observation" | "anchor",
//    "path":"pins/acme-prod/00000007.json",            // repo path, byte-exact
//    "file_sha256":"<64 lowercase hex of the RAW BYTES of the blob as committed>",
//    "introduced_by_commit":"<40 lowercase hex: the commit that ADDED the path>"}
//
//   leaf_hash = SHA256( 0x00 || json_c14n_v1(envelope) )
//
// json_c14n_v1 is the repo's one canonicalizer (lib/_merkle.js canonicalBytes:
// keys sorted by code point, compact separators, non-ASCII unescaped). Every
// envelope value is a STRING, so the documented 24-vs-24.0 number edge of
// canonicalBytes cannot arise here. The file bytes are the bytes `git show
// <commit>:<path>` prints, never a checked-out file (PUBLIC_RECORD_SPEC §8(e):
// core.autocrlf rewrites line endings on checkout and every hash then comes
// out wrong). Hashing the WHOLE file means no field of a record can sit
// outside the commitment, including fields added later (design A2 reason 1).
//
// ---- THE ORDER (design A2), the rule in one sentence ----
//
// Leaves are appended in the order of the commit that INTRODUCED each path,
// oldest first along the branch's first-parent history, and within one commit
// by path in byte order (unsigned byte comparison, not locale). A path counts
// as introduced by the first commit in that walk whose diff, taken against its
// first parent, ADDS the path. A path added more than once in that walk is
// refused by the builder (PUBLIC_RECORD_SPEC DISAGREEMENTS D8: re-adding is
// itself a finding), never silently ordered. Anyone can recompute the order
// from public git: `git log --first-parent --reverse --diff-filter=A
// --name-only --format=%H <branch>`. A merge commit's added files are the ones
// added relative to its FIRST parent, which is what --first-parent gives.
//
// ---- WHICH FILES (design A2) ----
//
// Eligible: numbered pin records `pins/<ns>/<8 digits>.json`, observation
// records `observations/<ns>/<name>.json`, anchor texts
// `anchors/<YYYY-MM-DD>-head.txt`. Excluded, with reasons: `pins/<ns>/latest.json`
// (a pointer, overwritten by design), `anchors/*.ots` (upgraded in place next
// day), README.md, and the log's own files under `log/`. A file that is mutable
// by design cannot be a leaf. The eligible set is part of the leaf recipe
// version: widening it (superseded/, checks/) is a v2, because it moves
// positions.
//
// ---- PROOFS ----
//
// consistencyProof / verifyConsistency and inclusionProof / verifyInclusion
// are RFC 9162 §2.1.3 and §2.1.4, transcribed from the RFC text (the
// recursive PATH / SUBPROOF generators and the iterative verifiers, with the
// RFC's variable names kept: fn, sn, fr, sr). Every verifier returns a typed
// result { ok, reason }, never a bare boolean, in the style of
// lib/_merkle.js verifyInclusion. Every refusal in the design A4 list has its
// own reason string.
"use strict";

const crypto = require("crypto");
const merkle = require("./_merkle.js");

const LOG_LEAF_RECIPE = "sha256:arcaeon-log-leaf:v1";
const CONSISTENCY_RECIPE = "rfc9162-consistency:sha256:v1";
const INCLUSION_RECIPE = "rfc9162-inclusion:sha256:v1";
const LOG_ORIGIN = "arcaeon.io/witness-pins/log/v1";

const HEX64 = /^[0-9a-f]{64}$/;
const HEX40 = /^[0-9a-f]{40}$/;

// The eligible-path table. `kind` is what goes in the envelope. Order of this
// table is NOT the leaf order (see the header); it only classifies.
const KINDS = [
  { kind: "pin", re: /^pins\/[^/]+\/[0-9]{8}\.json$/ },
  { kind: "observation", re: /^observations\/[^/]+\/[^/]+\.json$/ },
  { kind: "anchor", re: /^anchors\/[0-9]{4}-[0-9]{2}-[0-9]{2}-head\.txt$/ },
];

// Classify a repo path. Returns the kind string or null when the path is not
// a leaf (latest.json, .ots, README, log/…). A null is a classification, not
// an error: the builder skips it and says so in its summary.
function kindOfPath(path) {
  if (typeof path !== "string" || path.length === 0) return null;
  for (const k of KINDS) if (k.re.test(path)) return k.kind;
  return null;
}

// Build the envelope. Fails closed on any malformed input — a leaf built
// with a short hash or an unclassified path would hash cleanly and commit a
// statement nobody can recompute.
function makeEnvelope({ path, fileBytes, introducedByCommit }) {
  const kind = kindOfPath(path);
  if (!kind) throw new TypeError(`logtree: "${path}" is not an eligible record path`);
  if (!Buffer.isBuffer(fileBytes)) throw new TypeError("logtree: fileBytes must be a Buffer of the committed bytes");
  if (typeof introducedByCommit !== "string" || !HEX40.test(introducedByCommit)) {
    throw new TypeError("logtree: introduced_by_commit must be 40 lowercase hex");
  }
  return {
    recipe: LOG_LEAF_RECIPE,
    kind,
    path,
    file_sha256: crypto.createHash("sha256").update(fileBytes).digest("hex"),
    introduced_by_commit: introducedByCommit,
  };
}

// Validate an envelope somebody else wrote (a leaves file). Typed refusal.
function checkEnvelope(env) {
  if (!env || typeof env !== "object") return { ok: false, reason: "malformed_envelope" };
  if (env.recipe !== LOG_LEAF_RECIPE) return { ok: false, reason: "unknown_recipe", recipe: env.recipe };
  if (kindOfPath(env.path) !== env.kind) return { ok: false, reason: "kind_path_mismatch" };
  if (typeof env.file_sha256 !== "string" || !HEX64.test(env.file_sha256)) return { ok: false, reason: "malformed_envelope" };
  if (typeof env.introduced_by_commit !== "string" || !HEX40.test(env.introduced_by_commit)) {
    return { ok: false, reason: "malformed_envelope" };
  }
  const keys = Object.keys(env).sort();
  const want = ["file_sha256", "introduced_by_commit", "kind", "path", "recipe"];
  if (keys.length !== want.length || keys.some((k, i) => k !== want[i])) return { ok: false, reason: "malformed_envelope" };
  return { ok: true, reason: "well_formed" };
}

// ---- hashing: RFC 6962 / 9162 §2.1.1, via lib/_merkle.js ----

// MTH({d}) = HASH(0x00 || d), over arbitrary bytes. This is the function the
// reference vectors exercise directly (leaf inputs are raw bytes there).
function leafHashFromBytes(buf) {
  if (!Buffer.isBuffer(buf)) throw new TypeError("logtree: leaf input must be a Buffer");
  return crypto.createHash("sha256").update(Buffer.concat([Buffer.from([0x00]), buf])).digest();
}

// The log's leaf hash: the envelope's canonical bytes through the same function.
function logLeafHash(envelope) {
  const c = checkEnvelope(envelope);
  if (!c.ok) throw new TypeError(`logtree: refusing to hash an envelope: ${c.reason}`);
  return leafHashFromBytes(merkle.canonicalBytes(envelope));
}

const nodeHash = merkle.nodeHash; // SHA256(0x01 || left || right)

// MTH({}) = HASH() — the empty tree. Published for the vectors and for a
// checker; the builder never emits a size-0 checkpoint (an empty interval
// commits no root, lib/_merkle.js buildLevels).
function emptyRoot() {
  return crypto.createHash("sha256").update(Buffer.alloc(0)).digest();
}

// Largest power of two strictly smaller than n (n > 1). RFC §2.1.1 "k".
function largestPowerOfTwoBelow(n) {
  let k = 1;
  while (k * 2 < n) k *= 2;
  return k;
}

// MTH(D[lo:hi]) by the RFC's recursive definition, over leaf HASHES (the
// 0x00-prefixed hashing already applied). Used by the proof generators so
// they read like the RFC; the tree object below caches nothing because the
// log is small (56 leaves today) and correctness reads better than speed.
function mth(leafHashes, lo, hi) {
  const n = hi - lo;
  if (n === 0) return emptyRoot();
  if (n === 1) return leafHashes[lo];
  const k = largestPowerOfTwoBelow(n);
  return nodeHash(mth(leafHashes, lo, lo + k), mth(leafHashes, lo + k, hi));
}

function checkLeafHashes(leafHashes) {
  if (!Array.isArray(leafHashes)) throw new TypeError("logtree: leaf hashes must be an array");
  for (const h of leafHashes) {
    if (!Buffer.isBuffer(h) || h.length !== 32) throw new TypeError("logtree: every leaf hash must be a 32-byte Buffer");
  }
}

// buildTree(leafHashes) -> { size, root, rootAt(m), inclusionProof(i), consistencyProof(m, n) }
// The root is the RFC's MTH over all leaves. rootAt(m) is MTH over the first
// m, which is what an older checkpoint committed to.
function buildTree(leafHashes) {
  checkLeafHashes(leafHashes);
  const leaves = leafHashes.slice();
  const size = leaves.length;
  return {
    size,
    root: size === 0 ? emptyRoot() : mth(leaves, 0, size),
    rootAt(m) {
      if (!Number.isInteger(m) || m < 0 || m > size) throw new RangeError(`logtree: size ${m} is outside the tree`);
      return m === 0 ? emptyRoot() : mth(leaves, 0, m);
    },
    inclusionProof(i, n = size) {
      return inclusionProof(leaves, i, n);
    },
    consistencyProof(m, n = size) {
      return consistencyProof(leaves, m, n);
    },
  };
}

// RFC 9162 §2.1.3.1 PATH(m, D_n), recursively, exactly as written:
//   PATH(0, {d[0]}) = {}
//   PATH(m, D_n) = PATH(m, D[0:k]) : MTH(D[k:n])       for m < k
//   PATH(m, D_n) = PATH(m - k, D[k:n]) : MTH(D[0:k])   for m >= k
function inclusionProof(leafHashes, m, n = leafHashes.length) {
  checkLeafHashes(leafHashes);
  if (!Number.isInteger(n) || n < 1 || n > leafHashes.length) throw new RangeError("logtree: tree size outside the leaf list");
  if (!Number.isInteger(m) || m < 0 || m >= n) throw new RangeError(`logtree: leaf index ${m} is outside a tree of size ${n}`);
  const path = [];
  (function rec(mm, lo, hi) {
    const len = hi - lo;
    if (len === 1) return;
    const k = largestPowerOfTwoBelow(len);
    if (mm < k) {
      rec(mm, lo, lo + k);
      path.push(mth(leafHashes, lo + k, hi));
    } else {
      rec(mm - k, lo + k, hi);
      path.push(mth(leafHashes, lo, lo + k));
    }
  })(m, 0, n);
  return path;
}

// RFC 9162 §2.1.4.1 PROOF(m, D_n) = SUBPROOF(m, D_n, true), for 0 < m < n:
//   SUBPROOF(m, D_m, true)  = {}
//   SUBPROOF(m, D_m, false) = {MTH(D_m)}
//   SUBPROOF(m, D_n, b) = SUBPROOF(m, D[0:k], b) : MTH(D[k:n])           for m <= k
//   SUBPROOF(m, D_n, b) = SUBPROOF(m - k, D[k:n], false) : MTH(D[0:k])   for m > k
// m == n is the design's "roots must be identical and the path empty" case
// and is answered here with an empty proof; the VERIFIER refuses m == n with a
// non-empty path (design A4).
function consistencyProof(leafHashes, m, n = leafHashes.length) {
  checkLeafHashes(leafHashes);
  if (!Number.isInteger(n) || n < 1 || n > leafHashes.length) throw new RangeError("logtree: tree size outside the leaf list");
  if (!Number.isInteger(m) || m < 1 || m > n) throw new RangeError(`logtree: old size ${m} must satisfy 0 < m <= n (n=${n})`);
  if (m === n) return [];
  const path = [];
  (function sub(mm, lo, hi, complete) {
    const len = hi - lo;
    if (mm === len) {
      if (!complete) path.push(mth(leafHashes, lo, hi));
      return;
    }
    const k = largestPowerOfTwoBelow(len);
    if (mm <= k) {
      sub(mm, lo, lo + k, complete);
      path.push(mth(leafHashes, lo + k, hi));
    } else {
      sub(mm - k, lo + k, hi, false);
      path.push(mth(leafHashes, lo, lo + k));
    }
  })(m, 0, n, true);
  return path;
}

// Accept a path entry as a 32-byte Buffer or as EXACTLY 64 lowercase hex.
// Anything else — odd length, uppercase, a label — is refused, not trimmed or
// padded (design A4: Touchstone's verifier silently truncated odd-length hex
// and accepted a tampered proof).
function pathEntry(v) {
  if (Buffer.isBuffer(v)) return v.length === 32 ? v : null;
  if (typeof v === "string" && HEX64.test(v)) return Buffer.from(v, "hex");
  return null;
}

function rootEntry(v) {
  if (Buffer.isBuffer(v)) return v.length === 32 ? v : null;
  if (typeof v === "string" && HEX64.test(v)) return Buffer.from(v, "hex");
  return null;
}

const lsb = (x) => (x & 1) === 1;

// RFC 9162 §2.1.3.2, transcribed. Input: { leaf_index, tree_size, leaf_hash, path, root }.
function verifyInclusion({ leaf_index, tree_size, leaf_hash, path, root }) {
  if (!Number.isInteger(tree_size) || tree_size < 1) return { ok: false, reason: "malformed_proof" };
  if (!Number.isInteger(leaf_index) || leaf_index < 0) return { ok: false, reason: "malformed_proof" };
  // step 1
  if (leaf_index >= tree_size) return { ok: false, reason: "leaf_index_outside_tree" };
  const hash = rootEntry(leaf_hash);
  const want = rootEntry(root);
  if (!hash || !want) return { ok: false, reason: "malformed_hash" };
  if (!Array.isArray(path)) return { ok: false, reason: "malformed_proof" };
  // step 2, 3
  let fn = leaf_index;
  let sn = tree_size - 1;
  let r = hash;
  // step 4
  for (const pv of path) {
    const p = pathEntry(pv);
    if (!p) return { ok: false, reason: "malformed_hash" };
    if (sn === 0) return { ok: false, reason: "path_too_long" }; // 4a
    if (lsb(fn) || fn === sn) {
      r = nodeHash(p, r); // 4b.i
      if (!lsb(fn)) {
        while (!(lsb(fn) || fn === 0)) { fn >>= 1; sn >>= 1; } // 4b.ii
      }
    } else {
      r = nodeHash(r, p); // 4b otherwise
    }
    fn >>= 1; sn >>= 1; // 4c
  }
  // step 5
  if (sn !== 0) return { ok: false, reason: "path_too_short" };
  if (!r.equals(want)) return { ok: false, reason: "root_mismatch", computed_root: r.toString("hex") };
  return { ok: true, reason: "included", computed_root: r.toString("hex") };
}

// RFC 9162 §2.1.4.2, transcribed, wrapped in the design A4 refusals.
// Input: { old_size, new_size, old_root, new_root, path }.
function verifyConsistency({ old_size, new_size, old_root, new_root, path }) {
  if (!Number.isInteger(old_size) || !Number.isInteger(new_size)) return { ok: false, reason: "malformed_proof" };
  if (!Array.isArray(path)) return { ok: false, reason: "malformed_proof" };
  const first_hash = rootEntry(old_root);
  const second_hash = rootEntry(new_root);
  if (!first_hash || !second_hash) return { ok: false, reason: "malformed_hash" };
  const entries = [];
  for (const pv of path) {
    const p = pathEntry(pv);
    if (!p) return { ok: false, reason: "malformed_hash" };
    entries.push(p);
  }
  // design A4: "old_size == 0 … a malformed proof, reported as BROKEN"
  if (old_size < 1) return { ok: false, reason: "old_size_zero" };
  // design A4: "old_size > new_size … malformed"
  if (old_size > new_size) return { ok: false, reason: "old_size_greater_than_new" };
  // design A4: "old_size == new_size: the roots must be identical and the path empty; otherwise BROKEN"
  if (old_size === new_size) {
    if (entries.length !== 0) return { ok: false, reason: "equal_sizes_nonempty_path" };
    if (!first_hash.equals(second_hash)) return { ok: false, reason: "equal_sizes_root_mismatch" };
    return { ok: true, reason: "consistent", hops: 0 };
  }
  // RFC step 1: "If consistency_path is an empty array, stop and fail"
  if (entries.length === 0) return { ok: false, reason: "empty_path" };
  // step 2: if first is an exact power of 2, prepend first_hash
  const first = old_size;
  const second = new_size;
  const cp = (first & (first - 1)) === 0 ? [first_hash, ...entries] : entries.slice();
  // step 3
  let fn = first - 1;
  let sn = second - 1;
  // step 4
  while (lsb(fn)) { fn >>= 1; sn >>= 1; }
  // step 5
  let fr = cp[0];
  let sr = cp[0];
  // step 6
  for (let idx = 1; idx < cp.length; idx++) {
    const c = cp[idx];
    if (sn === 0) return { ok: false, reason: "path_too_long" }; // 6a
    if (lsb(fn) || fn === sn) {
      fr = nodeHash(c, fr); // 6b.i
      sr = nodeHash(c, sr); // 6b.ii
      if (!lsb(fn)) {
        while (!(lsb(fn) || fn === 0)) { fn >>= 1; sn >>= 1; } // 6b.iii
      }
    } else {
      sr = nodeHash(sr, c); // 6b otherwise
    }
    fn >>= 1; sn >>= 1; // 6c
  }
  // step 7
  if (sn !== 0) return { ok: false, reason: "path_too_short" };
  if (!fr.equals(first_hash)) return { ok: false, reason: "old_root_mismatch", computed_old_root: fr.toString("hex") };
  if (!sr.equals(second_hash)) return { ok: false, reason: "new_root_mismatch", computed_new_root: sr.toString("hex") };
  return { ok: true, reason: "consistent", hops: entries.length };
}

// ---- the published proof document (design A4) ----
//
// {"recipe":"rfc9162-consistency:sha256:v1","origin":"arcaeon.io/witness-pins/log/v1",
//  "old_size":56,"old_root":"<base64>","new_size":71,"new_root":"<base64>",
//  "path":["<64 lowercase hex>", ...]}
//
// The verifier reads size and root from the CHECKPOINT TEXT, never from this
// document's echo; a mismatch between the two is BROKEN (design A4). So this
// document is a convenience plus a proof path, and parse only validates shape.
function consistencyProofDocument({ origin = LOG_ORIGIN, old_size, old_root, new_size, new_root, path }) {
  return {
    recipe: CONSISTENCY_RECIPE,
    origin,
    old_size,
    old_root: Buffer.from(old_root).toString("base64"),
    new_size,
    new_root: Buffer.from(new_root).toString("base64"),
    path: path.map((p) => p.toString("hex")),
  };
}

function parseConsistencyProofDocument(doc) {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return { ok: false, reason: "malformed_proof" };
  if (doc.recipe !== CONSISTENCY_RECIPE) return { ok: false, reason: "unknown_recipe", recipe: doc.recipe };
  if (typeof doc.origin !== "string" || doc.origin.length === 0) return { ok: false, reason: "malformed_proof" };
  for (const k of ["old_size", "new_size"]) {
    if (!Number.isInteger(doc[k]) || doc[k] < 0) return { ok: false, reason: "malformed_proof", field: k };
  }
  const roots = {};
  for (const k of ["old_root", "new_root"]) {
    const b = decodeBase64Root(doc[k]);
    if (!b) return { ok: false, reason: "malformed_hash", field: k };
    roots[k] = b;
  }
  if (!Array.isArray(doc.path)) return { ok: false, reason: "malformed_proof", field: "path" };
  const path = [];
  for (const p of doc.path) {
    const b = pathEntry(p);
    if (!b) return { ok: false, reason: "malformed_hash", field: "path" };
    path.push(b);
  }
  return {
    ok: true,
    reason: "well_formed",
    origin: doc.origin,
    old_size: doc.old_size,
    new_size: doc.new_size,
    old_root: roots.old_root,
    new_root: roots.new_root,
    path,
  };
}

// A root in a checkpoint or proof document is standard base64 of exactly 32
// bytes, and it must round-trip byte for byte (no whitespace, no url-safe
// alphabet, no missing padding), or it is refused.
function decodeBase64Root(s) {
  if (typeof s !== "string" || !/^[A-Za-z0-9+/]{43}=$/.test(s)) return null;
  const b = Buffer.from(s, "base64");
  if (b.length !== 32 || b.toString("base64") !== s) return null;
  return b;
}

module.exports = {
  LOG_LEAF_RECIPE,
  CONSISTENCY_RECIPE,
  INCLUSION_RECIPE,
  LOG_ORIGIN,
  KINDS,
  kindOfPath,
  makeEnvelope,
  checkEnvelope,
  leafHashFromBytes,
  logLeafHash,
  nodeHash,
  emptyRoot,
  largestPowerOfTwoBelow,
  mth,
  buildTree,
  inclusionProof,
  consistencyProof,
  verifyInclusion,
  verifyConsistency,
  consistencyProofDocument,
  parseConsistencyProofDocument,
  decodeBase64Root,
};
