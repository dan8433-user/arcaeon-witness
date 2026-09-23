// test/merkle_failure_conformance.test.js — FAILURE conformance for lib/_merkle.js verifyInclusion.
//
// "Does the verifier FAIL when given an invalid inclusion proof?" (the exact
// sigstore-conformance phrasing). Every case starts from a proof that genuinely
// verifies against a real tree, applies ONE mutation, and asserts ok !== true.
// The break arm runs the same mutations against a verifier that always returns
// ok:true and asserts every case goes red.
//
// Findings M-1 and M-2 (formerly `todo`) are closed and asserted below.
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const merkle = require("../lib/_merkle.js");

function mkPin(i) {
  return {
    namespace: `conf-${i}`,
    rows: 10 + i,
    chain: (i.toString(16).padStart(2, "0")).repeat(16),
    seq: i + 1,
    pinned_at: `2026-09-01T00:00:${String(i).padStart(2, "0")}Z`,
    cadence_hours: 24,
    next_pin_due_by: "2026-09-02T00:00:00Z",
    record_kind: "content_head_advance",
    auth_level: "bearer-stage0",
  };
}

function tree(n) {
  const leaves = Array.from({ length: n }, (_, i) => merkle.leafObjectFromPin(mkPin(i)));
  const levels = merkle.buildLevels(leaves.map((l) => merkle.leafHash(l)));
  const root = merkle.labelled(merkle.MERKLE_RECIPE, merkle.rootOf(levels));
  return { leaves, levels, root };
}

function goodProof(n, idx) {
  const t = tree(n);
  return {
    t,
    proof: {
      leaf: t.leaves[idx],
      leaf_hash: merkle.labelled(merkle.LEAF_RECIPE, merkle.leafHash(t.leaves[idx])),
      leaf_index: idx,
      tree_size: n,
      path: merkle.proofPath(t.levels, idx),
      root: t.root,
      recipe: merkle.MERKLE_RECIPE,
    },
  };
}

const clone = (o) => JSON.parse(JSON.stringify(o));
const flipHex = (h) => {
  const bare = h.includes(":") ? h.slice(h.lastIndexOf(":") + 1) : h;
  const pre = h.slice(0, h.length - bare.length);
  const last = bare[bare.length - 1];
  return pre + bare.slice(0, -1) + (last === "0" ? "1" : "0");
};

function assertRejected(v, label) {
  assert.ok(v && typeof v === "object", `${label}: verifier returned no result object`);
  assert.notEqual(v.ok, true, `${label}: verifier ACCEPTED a bad proof (${JSON.stringify(v)})`);
}

test("PRECONDITION: the unmutated proofs verify (so each mutation below is the only cause of failure)", () => {
  for (const [n, idx] of [[1, 0], [2, 1], [5, 4], [7, 3], [8, 5]]) {
    const { proof } = goodProof(n, idx);
    assert.equal(merkle.verifyInclusion(proof).ok, true, `n=${n} idx=${idx}`);
  }
});

// [name, mutate(proof, t) -> proof]
const CASES = [
  ["flipped sibling node in the path", (p) => { p.path[0] = flipHex(p.path[0]); return p; }],
  ["flipped LAST sibling in the path", (p) => { p.path[p.path.length - 1] = flipHex(p.path[p.path.length - 1]); return p; }],
  ["flipped root", (p) => { p.root = flipHex(p.root); return p; }],
  ["root of a different tree", (p) => { p.root = tree(9).root; return p; }],
  ["wrong leaf index (neighbour)", (p) => { p.leaf_index = p.leaf_index ^ 1; return p; }],
  ["leaf index outside the tree", (p) => { p.leaf_index = p.tree_size; return p; }],
  ["negative leaf index", (p) => { p.leaf_index = -1; return p; }],
  ["fractional leaf index", (p) => { p.leaf_index = 2.5; return p; }],
  ["tree size shrunk so the index falls outside it", (p) => { p.tree_size = p.leaf_index; return p; }],
  ["tree size zero", (p) => { p.tree_size = 0; return p; }],
  ["truncated path (last sibling dropped)", (p) => { p.path = p.path.slice(0, -1); return p; }],
  ["empty path on a multi-leaf tree", (p) => { p.path = []; return p; }],
  ["extended path (extra sibling appended)", (p) => { p.path = p.path.concat([p.path[0]]); return p; }],
  ["reversed path (siblings swapped end for end)", (p) => { p.path = p.path.slice().reverse(); if (p.path.length < 2) p.path = p.path.concat([p.path[0]]); return p; }],
  ["edited leaf field (rows)", (p) => { p.leaf.rows += 1; return p; }],
  ["edited leaf field (chain)", (p) => { p.leaf.chain = flipHex(p.leaf.chain); return p; }],
  ["edited leaf field (record_kind heartbeat presented as advance)", (p) => { p.leaf.record_kind = "heartbeat"; return p; }],
  ["leaf missing a leaf field", (p) => { delete p.leaf.auth_level; return p; }],
  ["leaf of another index substituted", (p, t) => { p.leaf = t.leaves[(p.leaf_index + 1) % t.leaves.length]; return p; }],
  ["leaf_hash disagrees with the leaf", (p) => { p.leaf_hash = flipHex(p.leaf_hash); return p; }],
  ["unknown recipe", (p) => { p.recipe = "sha256:witness-merkle:v2"; return p; }],
  ["root under the wrong recipe label", (p) => { p.root = p.root.replace("witness-merkle", "witness-leaf"); return p; }],
  ["malformed sibling (odd-length hex)", (p) => { p.path[0] = p.path[0].slice(0, -1); return p; }],
  ["malformed sibling (uppercase hex)", (p) => { p.path[0] = p.path[0].toUpperCase(); return p; }],
  ["path not an array", (p) => { p.path = p.path.join(","); return p; }],
  ["root missing", (p) => { delete p.root; return p; }],
  ["no leaf and no leaf_hash", (p) => { delete p.leaf; delete p.leaf_hash; return p; }],
  ["null proof", () => null],
  ["empty object", () => ({})],
];

const SHAPES = [[2, 1], [5, 4], [7, 3], [8, 5]];

for (const [name, mutate] of CASES) {
  test(`FAILS on bad proof: ${name}`, () => {
    for (const [n, idx] of SHAPES) {
      const { t, proof } = goodProof(n, idx);
      const bad = mutate(clone(proof), t);
      assertRejected(merkle.verifyInclusion(bad), `${name} (n=${n}, idx=${idx})`);
    }
  });
}

// ---------------------------------------------------------------------------
// FORMER ACCEPT-BAD-INPUT FINDINGS, now closed (2026-09-22, branch merkle-fix).
// ---------------------------------------------------------------------------

// FINDING M-1 (closed): tree_size used to be bound to nothing. verifyInclusion
// now walks the tree shape implied by (leaf_index, tree_size), so the path must
// carry exactly the siblings that shape needs; and when the published root
// record (root.json) is supplied, its tree_size must equal the proof's. The
// smaller case below (leaf 3 of 7 re-labelled as 6) has the SAME path shape in
// both trees, so it can only be caught against publication; that is why the
// root record is passed there, and why an unbound result says so.
test("FAILS when tree_size is inflated beyond the real tree, or shrunk against the published root", () => {
  // larger: 4-leaf tree, leaf 0, claimed size 5 or 6 -> path depth no longer fits
  const { proof } = goodProof(4, 0);
  for (const fake of [5, 6]) {
    const bad = clone(proof); bad.tree_size = fake;
    const v = merkle.verifyInclusion(bad);
    assertRejected(v, `tree_size ${fake} for a 4-leaf tree`);
    assert.equal(v.reason, "path_too_short", `tree_size ${fake}`);
  }
  // smaller: 7-leaf tree, leaf 3, claimed size 6, checked against the published root record
  const g7 = goodProof(7, 3);
  const published = { root: g7.t.root, tree_size: 7 };
  const small = clone(g7.proof); small.tree_size = 6;
  const v = merkle.verifyInclusion(small, published);
  assertRejected(v, "tree_size 6 for a 7-leaf tree");
  assert.equal(v.reason, "tree_size_mismatch");
  // the honest proof against the same record is bound
  const good = merkle.verifyInclusion(g7.proof, published);
  assert.equal(good.ok, true, good.reason);
  assert.equal(good.tree_size_bound, true);
  // without the record, inclusion can pass but the size is reported as UNBOUND
  const unbound = merkle.verifyInclusion(small);
  assert.equal(unbound.tree_size_bound, false, "an unchecked tree_size must not be reported as bound");
  // a published record for a different root is refused, not ignored
  const other = merkle.verifyInclusion(g7.proof, { root: tree(9).root, tree_size: 7 });
  assertRejected(other, "published record for another root");
  assert.equal(other.reason, "published_root_mismatch");
});

test("FAILS when the path is longer or shorter than the tree shape requires", () => {
  for (const [n, idx] of SHAPES) {
    const { proof } = goodProof(n, idx);
    const long = clone(proof); long.path = long.path.concat([long.path[0]]);
    assert.equal(merkle.verifyInclusion(long).reason, "path_too_long", `n=${n} idx=${idx}`);
    const short = clone(proof); short.path = short.path.slice(0, -1);
    assert.equal(merkle.verifyInclusion(short).reason, "path_too_short", `n=${n} idx=${idx}`);
  }
});

// FINDING M-2 (closed): a leaf_hash-only proof used to take the hash on trust,
// so an interior node could be presented as a leaf. The leaf record is now
// required and its hash is always derived under the 0x00 prefix; a bare hash
// is refused with a typed reason.
test("FAILS when an interior node is presented as a leaf (leaf_hash-only proof)", () => {
  const t = tree(4);
  const n01 = t.levels[1][0].toString("hex");
  const n23 = t.levels[1][1].toString("hex");
  const bad = {
    leaf_hash: merkle.labelled(merkle.LEAF_RECIPE, Buffer.from(n01, "hex")),
    leaf_index: 0,
    tree_size: 2,
    path: [n23],
    root: t.root,
    recipe: merkle.MERKLE_RECIPE,
  };
  const v = merkle.verifyInclusion(bad);
  assertRejected(v, "interior node as leaf");
  assert.equal(v.reason, "leaf_required");
  // and a GENUINE leaf's hash without its record is refused the same way:
  // the verifier cannot tell the two apart without re-deriving, so it never tries.
  const { proof } = goodProof(4, 0);
  const bare = clone(proof); delete bare.leaf;
  assert.equal(merkle.verifyInclusion(bare).reason, "leaf_required");
});

// ---------------------------------------------------------------------------
// BREAK ARM
// ---------------------------------------------------------------------------
test("BREAK ARM: every mutation goes RED against a verifier that always returns ok:true", () => {
  const liar = () => ({ ok: true, reason: "included" });
  const survivors = [];
  for (const [name, mutate] of CASES) {
    const { t, proof } = goodProof(5, 4);
    try {
      assertRejected(liar(mutate(clone(proof), t)), name);
      survivors.push(name);
    } catch (e) {
      if (!(e instanceof assert.AssertionError)) throw e;
    }
  }
  assert.deepEqual(survivors, [], "these cases did NOT catch a lying verifier");
});
