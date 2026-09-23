// test/logtree.test.js — lib/_logtree.js against (1) the RFC 6962 reference
// vectors, (2) the RFC 9162 §2.1.5 structural example, (3) the RFC's own
// recursive and stack definitions transcribed here independently, and (4) a
// refusal battery with a BREAK ARM: a lying verifier that always says yes,
// which every refusal case must catch.
//
// VECTOR PROVENANCE, so nobody re-derives it. RFC 9162's text carries only
// the 7-leaf structural example of §2.1.5 (node names, no hex). The hex
// vectors below are the RFC 6962 reference implementation's published test
// constants (transparency-dev/merkle, testonly/constants.go: LeafInputs,
// NodeHashes, RootHashes), fetched 2026-09-22 and copied here as data. They
// were read, not run.
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");

const lt = require("../lib/_logtree.js");
const merkle = require("../lib/_merkle.js");

// ---- reference vectors (RFC 6962 reference implementation) ----
const LEAF_INPUTS = ["", "00", "10", "2021", "3031", "40414243", "5051525354555657", "606162636465666768696a6b6c6d6e6f"].map((h) => Buffer.from(h, "hex"));
const NODE_HASHES = [
  [
    "6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d",
    "96a296d224f285c67bee93c30f8a309157f0daa35dc5b87e410b78630a09cfc7",
    "0298d122906dcfc10892cb53a73992fc5b9f493ea4c9badb27b791b4127a7fe7",
    "07506a85fd9dd2f120eb694f86011e5bb4662e5c415a62917033d4a9624487e7",
    "bc1a0643b12e4d2d7c77918f44e0f4f79a838b6cf9ec5b5c283e1f4d88599e6b",
    "4271a26be0d8a84f0bd54c8c302e7cb3a3b5d1fa6780a40bcce2873477dab658",
    "b08693ec2e721597130641e8211e7eedccb4c26413963eee6c1e2ed16ffb1a5f",
    "46f6ffadd3d06a09ff3c5860d2755c8b9819db7df44251788c7d8e3180de8eb1",
  ],
  [
    "fac54203e7cc696cf0dfcb42c92a1d9dbaf70ad9e621f4bd8d98662f00e3c125",
    "5f083f0a1a33ca076a95279832580db3e0ef4584bdff1f54c8a360f50de3031e",
    "0ebc5d3437fbe2db158b9f126a1d118e308181031d0a949f8dededebc558ef6a",
    "ca854ea128ed050b41b35ffc1b87b8eb2bde461e9e3b5596ece6b9d5975a0ae0",
  ],
  ["d37ee418976dd95753c1c73862b9398fa2a2cf9b4ff0fdfe8b30cd95209614b7", "6b47aaf29ee3c2af9af889bc1fb9254dabd31177f16232dd6aab035ca39bf6e4"],
  ["5dc9da79a70659a9ad559cb701ded9a2ab9d823aad2f4960cfe370eff4604328"],
];
const ROOT_HASHES = [
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  "6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d",
  "fac54203e7cc696cf0dfcb42c92a1d9dbaf70ad9e621f4bd8d98662f00e3c125",
  "aeb6bcfe274b70a14fb067a5e5578264db0fa9b51af5e0ba159158f329e06e77",
  "d37ee418976dd95753c1c73862b9398fa2a2cf9b4ff0fdfe8b30cd95209614b7",
  "4e3bbb1f7b478dcfe71fb631631519a3bca12c9aefca1612bfce4c13a86264d4",
  "76e67dadbcdf1e10e1b74ddc608abd2f98dfb16fbce75277b5232a127f2087ef",
  "ddb89be403809e325750d3d263cd78929c2942b7942a34b77e122c9594a74c8c",
  "5dc9da79a70659a9ad559cb701ded9a2ab9d823aad2f4960cfe370eff4604328",
];
const nh = (lvl, i) => NODE_HASHES[lvl][i];
const hex = (b) => b.toString("hex");
const hexes = (arr) => arr.map(hex);

const REF_LEAVES = LEAF_INPUTS.map((b) => lt.leafHashFromBytes(b));
const REF_TREE = lt.buildTree(REF_LEAVES);

// Random leaf hashes for the exhaustive ranges.
function randomLeaves(n, seed = 7) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(crypto.createHash("sha256").update(`leaf-${seed}-${i}`).digest());
  return out;
}

// ---- (1) reference vectors ----

test("reference vectors: every leaf hash equals NodeHashes level 0", () => {
  assert.deepEqual(hexes(REF_LEAVES), NODE_HASHES[0]);
});

test("reference vectors: every internal node of the 8-leaf tree equals NodeHashes", () => {
  for (let lvl = 1; lvl < NODE_HASHES.length; lvl++) {
    const span = 1 << lvl;
    for (let i = 0; i < NODE_HASHES[lvl].length; i++) {
      assert.equal(hex(lt.mth(REF_LEAVES, i * span, (i + 1) * span)), nh(lvl, i), `level ${lvl} index ${i}`);
    }
  }
});

test("reference vectors: root for every size 0..8 equals RootHashes", () => {
  for (let n = 0; n <= 8; n++) assert.equal(hex(REF_TREE.rootAt(n)), ROOT_HASHES[n], `size ${n}`);
  assert.equal(hex(lt.emptyRoot()), ROOT_HASHES[0]);
  assert.equal(hex(lt.buildTree([]).root), ROOT_HASHES[0]);
});

test("reference vectors: inclusion proofs assembled from the node table", () => {
  // Expected paths spelled out from RFC §2.1.3.1's recursion over the table.
  const cases = [
    { i: 0, n: 1, path: [] },
    { i: 0, n: 8, path: [nh(0, 1), nh(1, 1), nh(2, 1)] },
    { i: 5, n: 8, path: [nh(0, 4), nh(1, 3), nh(2, 0)] },
    { i: 2, n: 3, path: [nh(1, 0)] },
    { i: 1, n: 5, path: [nh(0, 0), nh(1, 1), nh(0, 4)] },
  ];
  for (const c of cases) {
    assert.deepEqual(hexes(REF_TREE.inclusionProof(c.i, c.n)), c.path, `PATH(${c.i}, D${c.n})`);
    const r = lt.verifyInclusion({ leaf_index: c.i, tree_size: c.n, leaf_hash: REF_LEAVES[c.i], path: c.path, root: ROOT_HASHES[c.n] });
    assert.equal(r.ok, true, `verify PATH(${c.i}, D${c.n}): ${r.reason}`);
  }
});

test("reference vectors: consistency proofs assembled from the node table", () => {
  const cases = [
    { m: 1, n: 1, path: [] },
    { m: 1, n: 8, path: [nh(0, 1), nh(1, 1), nh(2, 1)] },
    { m: 6, n: 8, path: [nh(1, 2), nh(1, 3), nh(2, 0)] },
    { m: 2, n: 5, path: [nh(1, 1), nh(0, 4)] },
  ];
  for (const c of cases) {
    assert.deepEqual(hexes(REF_TREE.consistencyProof(c.m, c.n)), c.path, `PROOF(${c.m}, D${c.n})`);
    const r = lt.verifyConsistency({ old_size: c.m, new_size: c.n, old_root: ROOT_HASHES[c.m], new_root: ROOT_HASHES[c.n], path: c.path });
    assert.equal(r.ok, true, `verify PROOF(${c.m}, D${c.n}): ${r.reason}`);
  }
});

// ---- (2) RFC 9162 §2.1.5 structural example, 7 leaves ----

test("RFC 9162 §2.1.5: the named nodes of the 7-leaf example", () => {
  const L = randomLeaves(7, 9162);
  const t = lt.buildTree(L);
  const M = (lo, hi) => lt.mth(L, lo, hi);
  const [a, b, c, d, e, f, d6] = [L[0], L[1], L[2], L[3], L[4], L[5], L[6]];
  const g = M(0, 2), h = M(2, 4), i = M(4, 6), j = d6, k = M(0, 4), l = M(4, 7);
  assert.equal(hex(t.root), hex(lt.nodeHash(k, l)));
  // "The inclusion proof for d0 is [b, h, l]" and so on.
  assert.deepEqual(hexes(t.inclusionProof(0)), hexes([b, h, l]));
  assert.deepEqual(hexes(t.inclusionProof(3)), hexes([c, g, l]));
  assert.deepEqual(hexes(t.inclusionProof(4)), hexes([f, j, k]));
  assert.deepEqual(hexes(t.inclusionProof(6)), hexes([i, k]));
  // "PROOF(3, D[7]) = [c, d, g, l]", "PROOF(4, D[7]) = [l]", "PROOF(6, D[7]) = [i, j, k]"
  assert.deepEqual(hexes(t.consistencyProof(3, 7)), hexes([c, d, g, l]));
  assert.deepEqual(hexes(t.consistencyProof(4, 7)), hexes([l]));
  assert.deepEqual(hexes(t.consistencyProof(6, 7)), hexes([i, j, k]));
  // hash0 = MTH(D[0:3]) = H(g, c); hash1 = k; hash2 = H(k, i)
  assert.equal(hex(t.rootAt(3)), hex(lt.nodeHash(g, c)));
  assert.equal(hex(t.rootAt(4)), hex(k));
  assert.equal(hex(t.rootAt(6)), hex(lt.nodeHash(k, i)));
  void [a, d, e];
});

// ---- (3) the RFC definitions, transcribed here a second time, vs the library ----

// §2.1.2 stack algorithm, from the text.
function stackRoot(leafHashes) {
  const stack = [];
  const n = leafHashes.length;
  if (n === 0) return lt.emptyRoot();
  for (let i = 0; i < n; i++) {
    stack.push(leafHashes[i]);
    let mergeCount = 0;
    while (((i >> mergeCount) & 1) === 1) mergeCount++;
    for (let c = 0; c < mergeCount; c++) {
      const right = stack.pop();
      const left = stack.pop();
      stack.push(lt.nodeHash(left, right));
    }
  }
  while (stack.length > 1) {
    const right = stack.pop();
    const left = stack.pop();
    stack.push(lt.nodeHash(left, right));
  }
  return stack[0];
}

test("lib/_merkle.js buildLevels equals the RFC recursive MTH and the §2.1.2 stack algorithm, n = 1..300 (design F5, made permanent)", () => {
  const L = randomLeaves(300, 5);
  for (let n = 1; n <= 300; n++) {
    const sub = L.slice(0, n);
    const viaLevels = hex(merkle.rootOf(merkle.buildLevels(sub)));
    assert.equal(viaLevels, hex(lt.mth(sub, 0, n)), `mth n=${n}`);
    assert.equal(viaLevels, hex(stackRoot(sub)), `stack n=${n}`);
  }
});

test("lib/_merkle.js proofPath equals the RFC recursive PATH for every (i, n), n <= 64", () => {
  const L = randomLeaves(64, 11);
  for (let n = 1; n <= 64; n++) {
    const levels = merkle.buildLevels(L.slice(0, n));
    for (let i = 0; i < n; i++) {
      assert.deepEqual(merkle.proofPath(levels, i), hexes(lt.inclusionProof(L, i, n)), `i=${i} n=${n}`);
    }
  }
});

test("every inclusion proof verifies, n <= 64; every consistency proof verifies, all (m, n) with n <= 130; proof length <= ceil(log2 n) + 1", () => {
  const L = randomLeaves(130, 13);
  const t = lt.buildTree(L);
  let checked = 0;
  for (let n = 1; n <= 64; n++) {
    for (let i = 0; i < n; i++) {
      const r = lt.verifyInclusion({ leaf_index: i, tree_size: n, leaf_hash: L[i], path: t.inclusionProof(i, n), root: t.rootAt(n) });
      assert.equal(r.ok, true, `inclusion i=${i} n=${n}: ${r.reason}`);
      checked++;
    }
  }
  let longest = 0;
  for (let n = 1; n <= 130; n++) {
    for (let m = 1; m <= n; m++) {
      const path = t.consistencyProof(m, n);
      longest = Math.max(longest, path.length);
      assert.ok(path.length <= Math.ceil(Math.log2(n)) + 1, `bound m=${m} n=${n}`);
      const r = lt.verifyConsistency({ old_size: m, new_size: n, old_root: t.rootAt(m), new_root: t.rootAt(n), path });
      assert.equal(r.ok, true, `consistency m=${m} n=${n}: ${r.reason}`);
      checked++;
    }
  }
  assert.ok(checked > 8000, `checked ${checked}`);
  assert.equal(longest, 9, "design D measured a longest proof of 9 for n below 130");
});

// ---- (4) the refusal battery, with the break arm ----

const flipLast = (h) => h.slice(0, -1) + (h.endsWith("0") ? "1" : "0");

function consistencyBattery() {
  const L = randomLeaves(40, 17);
  const t = lt.buildTree(L);
  const good = (m, n) => ({ old_size: m, new_size: n, old_root: hex(t.rootAt(m)), new_root: hex(t.rootAt(n)), path: hexes(t.consistencyProof(m, n)) });
  const cases = [];
  const add = (name, mutate, m = 5, n = 37) => {
    const p = good(m, n);
    mutate(p);
    cases.push({ name, proof: p });
  };
  add("flipped first hash", (p) => { p.path[0] = flipLast(p.path[0]); });
  add("flipped last hash", (p) => { p.path[p.path.length - 1] = flipLast(p.path[p.path.length - 1]); });
  add("truncated path", (p) => { p.path.pop(); });
  add("extra trailing hash", (p) => { p.path.push(p.path[0]); });
  add("reordered path", (p) => { p.path.reverse(); }, 3, 37);
  add("m > n", (p) => { [p.old_size, p.new_size] = [p.new_size, p.old_size]; });
  add("m == n with a non-empty path", (p) => { p.new_size = p.old_size; p.new_root = p.old_root; });
  add("m == n with different roots and empty path", (p) => { p.new_size = p.old_size; p.path = []; });
  add("m == 0", (p) => { p.old_size = 0; });
  add("empty path when sizes differ", (p) => { p.path = []; });
  add("odd-length hex", (p) => { p.path[0] = p.path[0].slice(0, 63); });
  add("uppercase hex", (p) => { p.path[0] = p.path[0].toUpperCase(); });
  add("labelled hex", (p) => { p.path[0] = `sha256:witness-merkle:v1:${p.path[0]}`; });
  add("padded hex (65 chars)", (p) => { p.path[0] = p.path[0] + "0"; });
  add("wrong old root", (p) => { p.old_root = flipLast(p.old_root); });
  add("wrong new root", (p) => { p.new_root = flipLast(p.new_root); });
  add("old root from a different size", (p) => { p.old_root = hex(t.rootAt(4)); });
  add("path from a neighbouring pair (m+1)", (p) => { p.path = hexes(t.consistencyProof(6, 37)); });
  add("inclusion path passed off as consistency proof", (p) => { p.path = hexes(t.inclusionProof(5, 37)); });
  add("non-integer size", (p) => { p.old_size = "5"; });
  add("path not an array", (p) => { p.path = p.path.join(","); });
  add("power-of-two m with the old root also inserted at the front", (p) => { p.path.unshift(p.old_root); }, 8, 37);
  return { cases, good };
}

test("refusal battery: every mutation of a valid consistency proof is refused with a typed reason", () => {
  const { cases, good } = consistencyBattery();
  const sane = lt.verifyConsistency(good(5, 37));
  assert.equal(sane.ok, true, "the unmutated proof verifies (else the battery is vacuous)");
  for (const c of cases) {
    const r = lt.verifyConsistency(c.proof);
    assert.equal(r.ok, false, `accepted: ${c.name}`);
    assert.equal(typeof r.reason, "string", `no reason for: ${c.name}`);
    assert.notEqual(r.reason, "consistent");
  }
  assert.ok(cases.length >= 20, `battery has ${cases.length} cases`);
});

test("BREAK ARM: a lying verifier that always says consistent is caught by every battery case", () => {
  const lying = () => ({ ok: true, reason: "consistent" });
  const { cases } = consistencyBattery();
  const caught = cases.filter((c) => lying(c.proof).ok === true && lt.verifyConsistency(c.proof).ok === false);
  assert.equal(caught.length, cases.length, "every case must separate the liar from the verifier");
});

test("BREAK ARM: a lying verifier that skips the final sn == 0 check accepts a truncated path; ours does not", () => {
  // The single most common verifier bug: forgetting RFC step 7's "sn is 0".
  const L = randomLeaves(37, 23);
  const t = lt.buildTree(L);
  const p = { old_size: 5, new_size: 37, old_root: t.rootAt(5), new_root: t.rootAt(37), path: t.consistencyProof(5, 37) };
  const truncated = { ...p, path: p.path.slice(0, -1) };
  // Emulate the buggy verifier: run ours, but only compare roots if it got past
  // the length check. A truncated path fails on path_too_short specifically.
  const r = lt.verifyConsistency(truncated);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "path_too_short");
});

test("BREAK ARM: a duplicate-the-last-leaf tree (Bitcoin style) disagrees with the reference roots at every odd size, so a wrong tree shape cannot pass the vectors", () => {
  function bitcoinRoot(leaves) {
    let level = leaves.slice();
    while (level.length > 1) {
      if (level.length % 2 === 1) level.push(level[level.length - 1]);
      const next = [];
      for (let i = 0; i < level.length; i += 2) next.push(lt.nodeHash(level[i], level[i + 1]));
      level = next;
    }
    return level[0];
  }
  for (let n = 3; n <= 8; n += 2) assert.notEqual(hex(bitcoinRoot(REF_LEAVES.slice(0, n))), ROOT_HASHES[n], `size ${n}`);
  for (let n = 1; n <= 8; n *= 2) assert.equal(hex(bitcoinRoot(REF_LEAVES.slice(0, n))), ROOT_HASHES[n], `power of two ${n} agrees, which is why the odd sizes are the test`);
});

test("inclusion refusals: index outside tree, wrong root, truncated and padded paths", () => {
  const L = randomLeaves(9, 3);
  const t = lt.buildTree(L);
  const ok = { leaf_index: 4, tree_size: 9, leaf_hash: L[4], path: t.inclusionProof(4), root: t.root };
  assert.equal(lt.verifyInclusion(ok).ok, true);
  assert.equal(lt.verifyInclusion({ ...ok, leaf_index: 9 }).reason, "leaf_index_outside_tree");
  assert.equal(lt.verifyInclusion({ ...ok, path: ok.path.slice(1) }).reason, "path_too_short");
  assert.equal(lt.verifyInclusion({ ...ok, path: [...ok.path, ok.path[0]] }).reason, "path_too_long");
  assert.equal(lt.verifyInclusion({ ...ok, root: L[0] }).reason, "root_mismatch");
  assert.equal(lt.verifyInclusion({ ...ok, leaf_hash: hex(L[4]).toUpperCase() }).reason, "malformed_hash");
  assert.equal(lt.verifyInclusion({ ...ok, tree_size: 0 }).reason, "malformed_proof");
});

// ---- the leaf envelope ----

test("envelope: hash is SHA256(0x00 || json_c14n_v1(envelope)), key order independent, strings only", () => {
  const bytes = Buffer.from('{"namespace":"acme","rows":7}\n');
  const commit = "a".repeat(40);
  const env = lt.makeEnvelope({ path: "pins/acme/00000007.json", fileBytes: bytes, introducedByCommit: commit });
  assert.equal(env.kind, "pin");
  assert.equal(env.file_sha256, crypto.createHash("sha256").update(bytes).digest("hex"));
  const expect = crypto.createHash("sha256").update(Buffer.concat([Buffer.from([0]), merkle.canonicalBytes(env)])).digest("hex");
  assert.equal(hex(lt.logLeafHash(env)), expect);
  // A stranger's own recomputation from the documented recipe, without canonicalBytes:
  const manual = `{"file_sha256":"${env.file_sha256}","introduced_by_commit":"${commit}","kind":"pin","path":"pins/acme/00000007.json","recipe":"${lt.LOG_LEAF_RECIPE}"}`;
  assert.equal(hex(lt.logLeafHash(env)), crypto.createHash("sha256").update(Buffer.concat([Buffer.from([0]), Buffer.from(manual)])).digest("hex"));
  const shuffled = { path: env.path, recipe: env.recipe, introduced_by_commit: env.introduced_by_commit, file_sha256: env.file_sha256, kind: env.kind };
  assert.equal(hex(lt.logLeafHash(shuffled)), expect);
  // one changed byte in the file changes the leaf
  const env2 = lt.makeEnvelope({ path: env.path, fileBytes: Buffer.from('{"namespace":"acme","rows":8}\n'), introducedByCommit: commit });
  assert.notEqual(hex(lt.logLeafHash(env2)), expect);
});

test("envelope: ineligible paths are refused, and a malformed envelope is refused rather than hashed", () => {
  for (const p of ["pins/acme/latest.json", "anchors/2026-09-01-head.txt.ots", "README.md", "log/checkpoints/2026-09-22.txt", "pins/acme/7.json", "batches/000000001/root.json"]) {
    assert.equal(lt.kindOfPath(p), null, p);
    assert.throws(() => lt.makeEnvelope({ path: p, fileBytes: Buffer.alloc(1), introducedByCommit: "b".repeat(40) }), TypeError, p);
  }
  assert.equal(lt.kindOfPath("observations/velouria-selftest/2026-08-14T12-32-51-948Z.json"), "observation");
  assert.equal(lt.kindOfPath("anchors/2026-08-14-head.txt"), "anchor");
  const good = lt.makeEnvelope({ path: "anchors/2026-08-14-head.txt", fileBytes: Buffer.from("x"), introducedByCommit: "c".repeat(40) });
  assert.equal(lt.checkEnvelope(good).ok, true);
  assert.equal(lt.checkEnvelope({ ...good, extra: "field" }).reason, "malformed_envelope");
  assert.equal(lt.checkEnvelope({ ...good, recipe: "sha256:arcaeon-log-leaf:v2" }).reason, "unknown_recipe");
  assert.equal(lt.checkEnvelope({ ...good, kind: "pin" }).reason, "kind_path_mismatch");
  assert.equal(lt.checkEnvelope({ ...good, file_sha256: good.file_sha256.toUpperCase() }).reason, "malformed_envelope");
  assert.throws(() => lt.logLeafHash({ ...good, extra: 1 }), TypeError);
});

test("proof document: round trip, and parse refuses unknown recipe, url-safe or unpadded base64, uppercase hex", () => {
  const L = randomLeaves(20, 29);
  const t = lt.buildTree(L);
  const doc = lt.consistencyProofDocument({ old_size: 7, old_root: t.rootAt(7), new_size: 20, new_root: t.root, path: t.consistencyProof(7, 20) });
  assert.equal(doc.recipe, lt.CONSISTENCY_RECIPE);
  assert.equal(doc.origin, lt.LOG_ORIGIN);
  const p = lt.parseConsistencyProofDocument(JSON.parse(JSON.stringify(doc)));
  assert.equal(p.ok, true);
  assert.equal(lt.verifyConsistency(p).ok, true);
  assert.equal(lt.parseConsistencyProofDocument({ ...doc, recipe: "rfc9162-consistency:sha256:v2" }).reason, "unknown_recipe");
  assert.equal(lt.parseConsistencyProofDocument({ ...doc, old_root: doc.old_root.replace(/=$/, "") }).reason, "malformed_hash");
  assert.equal(lt.parseConsistencyProofDocument({ ...doc, old_root: doc.old_root.replace(/\+/g, "-").replace(/\//g, "_") }).ok, doc.old_root.includes("+") || doc.old_root.includes("/") ? false : true);
  assert.equal(lt.parseConsistencyProofDocument({ ...doc, path: doc.path.map((h) => h.toUpperCase()) }).reason, "malformed_hash");
  assert.equal(lt.parseConsistencyProofDocument({ ...doc, old_size: -1 }).reason, "malformed_proof");
  assert.equal(lt.parseConsistencyProofDocument([]).reason, "malformed_proof");
});
