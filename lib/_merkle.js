// _merkle.js — the tree construction and inclusion proofs of
// MERKLE_BATCHING_DESIGN.md §3 and §5. Pure computation: no store, no network,
// no clock. Underscore prefix = not routed as a serverless function by Vercel.
//
// This file implements §3.1 (leaf definition), §3.2 (internal nodes, domain
// separation, odd-node promotion, leaf order), and §5 (proof format and the
// verification algorithm). It implements NOTHING about when a batch seals or
// where it is written — that is lib/_batch.js.
//
// Why a separate file from _batch.js: §5's first claim is "Inclusion — the leaf
// is in the tree with that root. Pure computation, offline, no network, no trust
// in us." A verifier that has to require a module which reaches for a store is
// not that, and the design is explicit one level up (§8): "verify_inclusion must
// be pure and dependency-free. If proving inclusion requires calling us, the
// proof is not a proof." Keeping the two apart is what makes that checkable by
// reading the require list.

"use strict";

const crypto = require("crypto");
const { jdump, PyInt, PyFloat } = require("./_distill_core.js");

// ---- recipe labels (§5, "The recipe strings are load-bearing") ----
// Self-describing, versioned, and never minted for a shape the shipped
// verifier cannot reproduce. A proof carrying an unknown label fails TYPED
// (see verifyInclusion's `unknown_recipe`), never passes with a warning.
const LEAF_RECIPE = "sha256:witness-leaf:v1";
const MERKLE_RECIPE = "sha256:witness-merkle:v1";

// ---- domain separation (§3.2) ----
// "Without it a leaf whose bytes happen to be two concatenated hashes can be
// presented as an internal node. Cheap to do, impossible to retrofit once roots
// are public." RFC-6962 shape: 0x00 prefixes a leaf, 0x01 prefixes a node.
const LEAF_DOMAIN = Buffer.from([0x00]);
const NODE_DOMAIN = Buffer.from([0x01]);

// The leaf field list of §3.1, frozen and ordered here only for validation —
// the canonical bytes sort keys themselves (json-c14n:v1), so this array's
// order is not load-bearing and cannot become a second source of truth about
// the hash. What IS load-bearing: a leaf missing any of these is refused
// rather than hashed with the field absent. §3.1 on `record_kind`: "a proof
// that omits it would let a heartbeat be presented as an advance."
const LEAF_FIELDS = [
  "namespace",
  "rows",
  "chain",
  "seq",
  "accepted_at",
  "cadence_hours",
  "next_pin_due_by",
  "record_kind",
  "auth_level",
];

// ---- canonicalization: the repo's ONE canonicalizer, not a second one ----
//
// §3.1: the leaf reuses "arcaeon-ledger's frozen json-c14n:v1 recipe ... so the
// client can recompute a leaf with digest_json() and we introduce no second
// canonicalizer and therefore no second drift surface."
//
// lib/_distill_core.js already carries the JS side of that exact recipe —
// `jdump(value, /* sortKeys */ true)` is the serializer whose bytes
// _distill_core's own digestJsonC14n hashes under the label
// "sha256:json-c14n:v1". So this file calls THAT function rather than writing
// a sorted-key stringify of its own. The only work here is the value model:
// jdump speaks Python's types (Map / PyInt / PyFloat), because it exists to
// reproduce CPython's json.dumps byte-for-byte, so a plain JS object has to be
// lifted into that model first.
//
// Integers become PyInt (json.dumps(24) -> "24"); a non-integral number becomes
// PyFloat, which jdump renders through CPython's float repr. JS cannot tell
// 24.0 from 24, so an integral cadence_hours canonicalizes as "24" — stated
// here because a Python client holding a genuine 24.0 float would produce
// "24.0" and a different leaf hash. Cadence hours are configured as JSON
// numbers in WITNESS_CADENCE and resolveCadenceHours returns whatever was
// written there, so this is a real edge and it is documented rather than
// discovered.
function pyValue(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return v;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) {
      throw new TypeError("merkle: a non-finite number cannot be canonicalized");
    }
    return Number.isInteger(v) ? new PyInt(String(v)) : new PyFloat(v, String(v));
  }
  throw new TypeError(`merkle: unhandled leaf value type ${typeof v}`);
}

// The canonical bytes of a leaf object: json-c14n:v1, keys sorted by code
// point, compact separators, non-ASCII unescaped.
function canonicalBytes(obj) {
  const m = new Map();
  for (const k of Object.keys(obj)) m.set(k, pyValue(obj[k]));
  return Buffer.from(jdump(m, true), "utf-8");
}

// Build the §3.1 leaf_object from a stored pin record. `accepted_at` carries
// forward exactly what `pinned_at` means today (api/pin.js:729, "the witness's
// OWN clock") — renamed in the leaf only so the accept-vs-seal distinction of
// §4 cannot be blurred. The stored record keeps `pinned_at`; nothing about the
// record's own shape changes.
//
// Deliberately NOT lifted into the leaf (§3.1): `intervals` and
// `missed_deadlines`. They are derived and truncated at MAX_INLINE_HISTORY, so
// "including a truncated derived history in a hash commitment would make the
// commitment depend on a window size we intend to change."
function leafObjectFromPin(pin) {
  if (!pin || typeof pin !== "object") throw new TypeError("merkle: pin must be an object");
  const leaf = {
    namespace: pin.namespace,
    rows: pin.rows,
    chain: typeof pin.chain === "string" ? pin.chain.toLowerCase() : pin.chain,
    seq: pin.seq,
    accepted_at: pin.pinned_at,
    cadence_hours: pin.cadence_hours,
    next_pin_due_by: pin.next_pin_due_by,
    record_kind: pin.record_kind,
    auth_level: pin.auth_level,
  };
  for (const f of LEAF_FIELDS) {
    if (leaf[f] === undefined || leaf[f] === null) {
      // Fail closed. A leaf built with a missing field would hash cleanly and
      // commit a statement weaker than the one the proof appears to make.
      const err = new TypeError(`merkle: pin is missing leaf field "${f}" — refusing to hash a partial leaf`);
      err.missing_field = f;
      throw err;
    }
  }
  return leaf;
}

function leafHash(leafObject) {
  return crypto
    .createHash("sha256")
    .update(Buffer.concat([LEAF_DOMAIN, canonicalBytes(leafObject)]))
    .digest();
}

// §3.2: node_hash = SHA256( 0x01 || left_hash || right_hash ). Order is part of
// the commitment — H(0x01||A||B) and H(0x01||B||A) are different nodes, which
// is exactly what makes a proof's sibling PLACEMENT checkable rather than
// decorative. See verifyInclusion.
function nodeHash(left, right) {
  return crypto
    .createHash("sha256")
    .update(Buffer.concat([NODE_DOMAIN, left, right]))
    .digest();
}

// Build every level of the tree, bottom-up, from leaf hashes in ACCEPTANCE
// ORDER (§3.2: "Leaf order = acceptance order ... Deterministic and
// independently recomputable from the published leaf list."). levels[0] is the
// leaves; the last level is a single node, the root.
//
// Odd node: PROMOTE, do not duplicate (§3.2). "Bitcoin-style
// duplicate-the-last-leaf makes distinct trees collide to the same root, which
// is a known ambiguity class (CVE-2012-2459 lineage) and is not worth
// inheriting for the sake of a tidier diagram."
//
// A single leaf is the degenerate tree and it is a real tree: levels === [[h]],
// root === h, proof path empty. §3.2's "Empty interval commits no root" is the
// zero case and is refused here rather than answered with a manufactured root.
function buildLevels(leafHashes) {
  if (!Array.isArray(leafHashes) || leafHashes.length === 0) {
    throw new RangeError(
      "merkle: a root over zero leaves is not a meaningful statement — an empty interval commits no root (§3.2)"
    );
  }
  const levels = [leafHashes.slice()];
  while (levels[levels.length - 1].length > 1) {
    const cur = levels[levels.length - 1];
    const next = [];
    for (let i = 0; i < cur.length; i += 2) {
      if (i + 1 < cur.length) next.push(nodeHash(cur[i], cur[i + 1]));
      else next.push(cur[i]); // promoted, unchanged
    }
    levels.push(next);
  }
  return levels;
}

function rootOf(levels) {
  return levels[levels.length - 1][0];
}

// The sibling hashes on the path from leaf `index` to the root, bottom-up.
// A promoted node contributes NO entry: it has no sibling at that level. The
// verifier reconstructs direction from the index and the tree size (§5, "Path
// direction is derived, not encoded"), so nothing about left/right is written
// into the path itself — "Encoding an explicit left/right array would be a
// second source of truth that can disagree with the index, and a verifier that
// trusts the flags over the index is exploitable."
function proofPath(levels, index) {
  if (!Number.isInteger(index) || index < 0 || index >= levels[0].length) {
    throw new RangeError(`merkle: leaf index ${index} is outside the tree`);
  }
  const path = [];
  let i = index;
  for (let l = 0; l < levels.length - 1; l++) {
    const level = levels[l];
    const isPromoted = i === level.length - 1 && level.length % 2 === 1;
    if (!isPromoted) path.push((i % 2 === 0 ? level[i + 1] : level[i - 1]).toString("hex"));
    i >>= 1;
  }
  return path;
}

function labelled(recipe, buf) {
  return `${recipe}:${buf.toString("hex")}`;
}

// Split "sha256:witness-merkle:v1:<hex>" into its label and its hex. A bare hex
// string is accepted too (the design's `path` entries are bare hex); a label
// that is present but WRONG is a typed failure, never a shrug.
function splitLabelled(value, expectedRecipe) {
  if (typeof value !== "string") return { err: "malformed" };
  const hexOnly = /^[0-9a-f]{64}$/;
  if (hexOnly.test(value)) return { hex: value };
  const idx = value.lastIndexOf(":");
  if (idx < 0) return { err: "malformed" };
  const recipe = value.slice(0, idx);
  const hex = value.slice(idx + 1);
  if (!hexOnly.test(hex)) return { err: "malformed" };
  if (recipe !== expectedRecipe) return { err: "unknown_recipe", recipe };
  return { hex, recipe };
}

// §5's verification algorithm, TIGHTENED (2026-09-22, failure-conformance
// findings M-1 and M-2). The published pseudocode was:
//
//   h = SHA256(0x00 || json_c14n_v1(leaf))
//   i = leaf_index ; n = tree_size
//   for sib in path:
//       if i is odd or i + 1 == n:   # right child, or promoted-left pairing
//           h = SHA256(0x01 || sib || h)
//       else:
//           h = SHA256(0x01 || h || sib)
//       i >>= 1 ; n = (n + 1) >> 1
//   assert h == root
//
// That loop is driven by the PATH, not by the tree: it consumes whatever
// siblings it is handed and never asks how many a leaf at (index, size) must
// have. Two false yeses fell out of that:
//
//   M-1  tree_size was bound to nothing. A 4-leaf proof for leaf 0 re-labelled
//        tree_size 5 or 6 still verified, so the caller was told "included in a
//        tree of size N" for an N the tree does not have.
//   M-2  a proof carrying only `leaf_hash` took that hash on trust, so an
//        INTERIOR node could be presented as a leaf (shorter path, smaller
//        tree_size) and verify. Domain separation (0x00 / 0x01) only protects
//        a verifier that derives the leaf hash itself.
//
// The algorithm now walks the TREE SHAPE implied by (leaf_index, tree_size):
//
//   h = SHA256(0x00 || json_c14n_v1(leaf))      # always derived, never taken
//   i = leaf_index ; n = tree_size ; k = 0
//   while n > 1:
//       if i == n - 1 and n is odd:             # promoted: no sibling here
//           pass
//       else:
//           sib = path[k] ; k += 1              # missing -> path_too_short
//           h = SHA256(0x01 || sib || h) if i is odd else SHA256(0x01 || h || sib)
//       i >>= 1 ; n = (n + 1) >> 1
//   assert k == len(path)                       # leftover -> path_too_long
//   assert h == root
//   if the published root record is supplied:
//       assert its root == root and its tree_size == tree_size
//
// This is exactly the inverse of proofPath below, so every honest proof
// verifies unchanged; what it adds is that the number AND placement of
// siblings are fixed by the claimed tree_size, not by the proof.
//
// The root does not commit to the leaf count on its own (a leaf can have the
// same path shape in trees of two sizes: leaf 3 of 7 and leaf 3 of 6 both take
// three siblings on the same sides). The count IS committed by the published
// root.json (§3.3, `tree_size`), so the second argument takes that record and
// cross-checks it. Without it the result says so in `tree_size_bound` rather
// than implying the size was confirmed: `ok` is still the inclusion claim
// alone ("this leaf is under this root"), which is true, and the size is
// reported as the proof's claim until it is checked against publication.
//
// Leaf/node domain separation is enforced by construction: the leaf hash is
// ALWAYS recomputed from the leaf record's canonical bytes under the 0x00
// prefix. A bare `leaf_hash` without the record is refused (`leaf_required`);
// when both are present, `leaf_hash` must equal the derived value. There is no
// "pre-hashed leaf" mode, because a verifier that cannot re-derive the leaf
// cannot tell a leaf from an interior node.
//
// Returns a typed result, never a bare boolean: §5 requires inclusion and
// publication to stay "Two separate claims, never merged into one boolean",
// and a reason string is what lets a caller keep them apart.
function verifyInclusion(proof, published) {
  if (!proof || typeof proof !== "object") return { ok: false, reason: "malformed_proof" };

  const recipe = proof.recipe;
  if (recipe !== undefined && recipe !== MERKLE_RECIPE) {
    return { ok: false, reason: "unknown_recipe", recipe };
  }

  const n = proof.tree_size;
  const i0 = proof.leaf_index;
  if (!Number.isInteger(n) || n < 1) return { ok: false, reason: "malformed_proof" };
  if (!Number.isInteger(i0) || i0 < 0 || i0 >= n) return { ok: false, reason: "leaf_index_outside_tree" };
  if (!Array.isArray(proof.path)) return { ok: false, reason: "malformed_proof" };

  // M-2: the leaf record is required; its hash is derived, never accepted.
  if (proof.leaf === undefined || proof.leaf === null) {
    return { ok: false, reason: "leaf_required" };
  }
  let h;
  try {
    h = leafHash(proof.leaf);
  } catch {
    return { ok: false, reason: "malformed_leaf" };
  }
  if (proof.leaf_hash !== undefined) {
    const lh = splitLabelled(proof.leaf_hash, LEAF_RECIPE);
    if (lh.err) return { ok: false, reason: lh.err === "unknown_recipe" ? "unknown_recipe" : "malformed_proof" };
    if (lh.hex !== h.toString("hex")) return { ok: false, reason: "leaf_hash_mismatch" };
  }

  // M-1: walk the tree shape fixed by (leaf_index, tree_size).
  let i = i0;
  let size = n;
  let k = 0;
  while (size > 1) {
    const promoted = i === size - 1 && size % 2 === 1;
    if (!promoted) {
      if (k >= proof.path.length) return { ok: false, reason: "path_too_short" };
      const s = splitLabelled(proof.path[k], MERKLE_RECIPE);
      if (s.err) return { ok: false, reason: s.err === "unknown_recipe" ? "unknown_recipe" : "malformed_proof" };
      const sib = Buffer.from(s.hex, "hex");
      h = i % 2 === 1 ? nodeHash(sib, h) : nodeHash(h, sib);
      k++;
    }
    i >>= 1;
    size = (size + 1) >> 1;
  }
  if (k !== proof.path.length) return { ok: false, reason: "path_too_long" };

  const r = splitLabelled(proof.root, MERKLE_RECIPE);
  if (r.err) return { ok: false, reason: r.err === "unknown_recipe" ? "unknown_recipe" : "malformed_proof" };

  const computed = h.toString("hex");
  if (computed !== r.hex) {
    return { ok: false, reason: "root_mismatch", computed_root: labelled(MERKLE_RECIPE, h) };
  }

  // M-1, second half: bind tree_size to the published root record.
  let treeSizeBound = false;
  if (published !== undefined && published !== null) {
    if (typeof published !== "object") return { ok: false, reason: "malformed_published_root" };
    const pr = splitLabelled(published.root, MERKLE_RECIPE);
    if (pr.err) return { ok: false, reason: pr.err === "unknown_recipe" ? "unknown_recipe" : "malformed_published_root" };
    if (pr.hex !== r.hex) {
      return { ok: false, reason: "published_root_mismatch", computed_root: labelled(MERKLE_RECIPE, h) };
    }
    if (!Number.isInteger(published.tree_size) || published.tree_size < 1) {
      return { ok: false, reason: "malformed_published_root" };
    }
    if (published.tree_size !== n) {
      return {
        ok: false,
        reason: "tree_size_mismatch",
        claimed_tree_size: n,
        published_tree_size: published.tree_size,
        computed_root: labelled(MERKLE_RECIPE, h),
      };
    }
    treeSizeBound = true;
  }
  return {
    ok: true,
    reason: "included",
    computed_root: labelled(MERKLE_RECIPE, h),
    tree_size_bound: treeSizeBound,
  };
}

module.exports = {
  LEAF_RECIPE,
  MERKLE_RECIPE,
  LEAF_FIELDS,
  canonicalBytes,
  leafObjectFromPin,
  leafHash,
  nodeHash,
  buildLevels,
  rootOf,
  proofPath,
  labelled,
  verifyInclusion,
};
