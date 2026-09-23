// test/follow.test.js — tools/follow.js, the stranger's checker.
//
// (1) Its self-contained RFC verifier must agree with lib/_logtree.js on
//     every (m, n) pair it can generate and on every refusal case: the two
//     were written separately, and a disagreement is a spec defect.
// (2) End to end through follow(): VERIFIED / BROKEN / COULD NOT LOOK, each
//     from the condition the design names for it.
// (3) The CLI: exit codes 0/1/2 and the --help limits text.
// (4) BREAK ARM: a checker that always says VERIFIED is caught by every
//     non-VERIFIED case in the battery.
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const follow = require("../tools/follow.js");
const lt = require("../lib/_logtree.js");
const cp = require("../lib/_checkpoint.js");

const FOLLOW = path.join(__dirname, "..", "tools", "follow.js");
const hex = (b) => b.toString("hex");
const leaves = (n, seed) => Array.from({ length: n }, (_, i) => crypto.createHash("sha256").update(`${seed}:${i}`).digest());

test("follow.js's verifier agrees with lib/_logtree.js on every (m, n), n <= 64, and on every mutation", () => {
  const L = leaves(64, "agree");
  const t = lt.buildTree(L);
  for (let n = 1; n <= 64; n++) {
    for (let m = 1; m <= n; m++) {
      const p = t.consistencyProof(m, n).map(hex);
      const a = lt.verifyConsistency({ old_size: m, new_size: n, old_root: t.rootAt(m), new_root: t.rootAt(n), path: p });
      const b = follow.verifyConsistency(m, n, t.rootAt(m), t.rootAt(n), p);
      assert.equal(a.ok, true, `lib m=${m} n=${n}`);
      assert.equal(b.ok, true, `follow m=${m} n=${n}`);
      // mutations: both must refuse
      if (p.length) {
        const flipped = p.slice();
        flipped[0] = flipped[0].slice(0, -1) + (flipped[0].endsWith("0") ? "1" : "0");
        assert.equal(follow.verifyConsistency(m, n, t.rootAt(m), t.rootAt(n), flipped).ok, false, `follow flipped m=${m} n=${n}`);
        assert.equal(lt.verifyConsistency({ old_size: m, new_size: n, old_root: t.rootAt(m), new_root: t.rootAt(n), path: flipped }).ok, false);
        assert.equal(follow.verifyConsistency(m, n, t.rootAt(m), t.rootAt(n), p.slice(0, -1)).ok, false, `follow truncated m=${m} n=${n}`);
        assert.equal(follow.verifyConsistency(m, n, t.rootAt(m), t.rootAt(n), [...p, p[0]]).ok, false, `follow extended m=${m} n=${n}`);
      }
      // a wrong old root: for m < n hand it the root at m+1; for m == n > 1 the root at m-1
      if (m < n) assert.equal(follow.verifyConsistency(m, n, t.rootAt(m + 1), t.rootAt(n), p).ok, false, `wrong old root m=${m} n=${n}`);
      else if (m > 1) assert.equal(follow.verifyConsistency(m, n, t.rootAt(m - 1), t.rootAt(n), p).reason, "equal_sizes_root_mismatch");
    }
  }
  assert.equal(follow.verifyConsistency(0, 5, t.rootAt(1), t.rootAt(5), []).reason, "old_size_zero");
  assert.equal(follow.verifyConsistency(6, 5, t.rootAt(5), t.rootAt(5), []).reason, "old_size_greater_than_new");
  assert.equal(follow.verifyConsistency(2, 5, t.rootAt(2), t.rootAt(5), []).reason, "empty_path");
  assert.equal(follow.verifyConsistency(5, 5, t.rootAt(5), t.rootAt(5), [hex(L[0])]).reason, "equal_sizes_nonempty_path");
  assert.equal(follow.verifyConsistency(2, 5, t.rootAt(2), t.rootAt(5), [hex(L[0]).toUpperCase()]).reason, "malformed_hash");
  assert.equal(follow.verifyConsistency(2, 5, t.rootAt(2), t.rootAt(5), [hex(L[0]).slice(1)]).reason, "malformed_hash");
});

// Build a full scenario: signed checkpoints at m and n over the same log,
// and the proof document, as strings.
function scenario({ m = 51, n = 56, seed = "live", key = cp.generateKey("arcaeon-log"), sign = true } = {}) {
  const L = leaves(n, seed);
  const t = lt.buildTree(L);
  const mk = (size) => {
    const text = cp.formatCheckpoint({ size, root: t.rootAt(size) });
    return sign ? cp.signCheckpoint(text, key.signer) : text;
  };
  const doc = lt.consistencyProofDocument({ old_size: m, old_root: t.rootAt(m), new_size: n, new_root: t.rootAt(n), path: t.consistencyProof(m, n) });
  return { key, L, t, oldText: mk(m), newText: mk(n), proofText: JSON.stringify(doc), doc };
}

function battery() {
  const s = scenario();
  const k = s.key.verifier;
  const cases = [];
  const add = (name, verdict, reason, args) => cases.push({ name, verdict, reason, args: { key: k, ...args } });
  add("genuine", "VERIFIED", "consistent", { oldText: s.oldText, newText: s.newText, proofText: s.proofText });
  // BROKEN: a tampered leaf → the new tree is a different log; the honest proof from the old log no longer matches
  const tamperedL = s.L.slice();
  tamperedL[3] = crypto.createHash("sha256").update("tampered").digest();
  const t2 = lt.buildTree(tamperedL);
  const newTampered = cp.signCheckpoint(cp.formatCheckpoint({ size: 56, root: t2.root }), s.key.signer);
  const doc2 = lt.consistencyProofDocument({ old_size: 51, old_root: s.t.rootAt(51), new_size: 56, new_root: t2.root, path: t2.consistencyProof(51, 56) });
  add("tampered leaf 3 (proof minted from the rewritten log)", "BROKEN", "old_root_mismatch", { oldText: s.oldText, newText: newTampered, proofText: JSON.stringify(doc2) });
  const doc3 = { ...s.doc, new_root: t2.root.toString("base64") };
  add("tampered leaf 3 (old proof, new root)", "BROKEN", "new_root_mismatch", { oldText: s.oldText, newText: newTampered, proofText: JSON.stringify(doc3) });
  add("proof path flipped", "BROKEN", "old_root_mismatch", { oldText: s.oldText, newText: s.newText, proofText: JSON.stringify({ ...s.doc, path: [s.doc.path[0].slice(0, -1) + (s.doc.path[0].endsWith("0") ? "1" : "0"), ...s.doc.path.slice(1)] }) });
  add("proof path truncated", "BROKEN", "path_too_short", { oldText: s.oldText, newText: s.newText, proofText: JSON.stringify({ ...s.doc, path: s.doc.path.slice(0, -1) }) });
  add("proof path uppercase hex", "BROKEN", "malformed_hash", { oldText: s.oldText, newText: s.newText, proofText: JSON.stringify({ ...s.doc, path: s.doc.path.map((h) => h.toUpperCase()) }) });
  add("proof path odd-length hex", "BROKEN", "malformed_hash", { oldText: s.oldText, newText: s.newText, proofText: JSON.stringify({ ...s.doc, path: [s.doc.path[0].slice(1), ...s.doc.path.slice(1)] }) });
  add("JSON echo disagrees with checkpoint text (old_size)", "BROKEN", "echo_mismatch", { oldText: s.oldText, newText: s.newText, proofText: JSON.stringify({ ...s.doc, old_size: 50 }) });
  add("JSON echo disagrees with checkpoint text (new_root)", "BROKEN", "echo_mismatch", { oldText: s.oldText, newText: s.newText, proofText: JSON.stringify({ ...s.doc, new_root: s.doc.old_root }) });
  add("old checkpoint newer than new (m > n)", "BROKEN", "old_size_greater_than_new", { oldText: s.newText, newText: s.oldText, proofText: JSON.stringify({ ...s.doc, old_size: 56, new_size: 51, old_root: s.doc.new_root, new_root: s.doc.old_root }) });
  add("empty path with different sizes", "BROKEN", "empty_path", { oldText: s.oldText, newText: s.newText, proofText: JSON.stringify({ ...s.doc, path: [] }) });
  const same = cp.signCheckpoint(cp.formatCheckpoint({ size: 56, root: t2.root }), s.key.signer);
  add("equal sizes, different roots", "BROKEN", "equal_sizes_root_mismatch", { oldText: s.newText, newText: same, proofText: JSON.stringify({ ...s.doc, old_size: 56, old_root: s.doc.new_root, new_size: 56, new_root: t2.root.toString("base64"), path: [] }) });
  add("equal sizes, same root, empty path", "VERIFIED", "consistent", { oldText: s.newText, newText: s.newText, proofText: JSON.stringify({ ...s.doc, old_size: 56, old_root: s.doc.new_root, path: [] }) });
  add("equal sizes, same root, non-empty path", "BROKEN", "equal_sizes_nonempty_path", { oldText: s.newText, newText: s.newText, proofText: JSON.stringify({ ...s.doc, old_size: 56, old_root: s.doc.new_root }) });
  // signatures
  const tamperedOld = s.oldText.replace("\n51\n", "\n50\n");
  add("old checkpoint body edited after signing", "BROKEN", "bad_signature", { oldText: tamperedOld, newText: s.newText, proofText: s.proofText });
  const other = cp.generateKey("arcaeon-log");
  add("signed by a different key of the same name", "COULD NOT LOOK", "no_signature_for_key", { oldText: s.oldText, newText: s.newText, proofText: s.proofText, key: other.verifier });
  const unsigned = scenario({ sign: false });
  add("unsigned checkpoints with a key expected", "COULD NOT LOOK", "no_signature_for_key", { oldText: unsigned.oldText, newText: unsigned.newText, proofText: unsigned.proofText });
  add("unsigned checkpoints, no key, not allowed", "COULD NOT LOOK", "no_key_given", { oldText: unsigned.oldText, newText: unsigned.newText, proofText: unsigned.proofText, key: null });
  add("unsigned checkpoints, explicitly allowed", "VERIFIED", "consistent", { oldText: unsigned.oldText, newText: unsigned.newText, proofText: unsigned.proofText, key: null, allowUnsigned: true });
  add("malformed key string", "COULD NOT LOOK", "malformed_key", { oldText: s.oldText, newText: s.newText, proofText: s.proofText, key: "nope" });
  // could not look
  add("unknown recipe", "COULD NOT LOOK", "unknown_recipe", { oldText: s.oldText, newText: s.newText, proofText: JSON.stringify({ ...s.doc, recipe: "rfc9162-consistency:sha512:v1" }) });
  add("unknown origin", "COULD NOT LOOK", "unknown_origin", { oldText: s.oldText, newText: s.newText, proofText: JSON.stringify({ ...s.doc, origin: "example.org/log" }) });
  add("proof is not JSON", "COULD NOT LOOK", "proof_not_json", { oldText: s.oldText, newText: s.newText, proofText: "{" });
  add("proof is a JSON array", "COULD NOT LOOK", "proof_not_object", { oldText: s.oldText, newText: s.newText, proofText: "[]" });
  add("old checkpoint malformed (CRLF)", "COULD NOT LOOK", "old_checkpoint_malformed", { oldText: s.oldText.replace(/\n/g, "\r\n"), newText: s.newText, proofText: s.proofText });
  add("new checkpoint malformed (fourth line)", "COULD NOT LOOK", "new_checkpoint_malformed", { oldText: s.oldText, newText: s.newText.replace("\n\n", "\nextra\n\n"), proofText: s.proofText });
  const otherOrigin = cp.signCheckpoint(`other.example/log/v1\n56\n${s.t.root.toString("base64")}\n`, s.key.signer);
  add("checkpoints of different origins", "COULD NOT LOOK", "origin_mismatch", { oldText: s.oldText, newText: otherOrigin, proofText: s.proofText });
  return cases;
}

test("end to end: every battery case yields the verdict and reason the design names", () => {
  const cases = battery();
  for (const c of cases) {
    const r = follow.follow(c.args);
    assert.equal(r.verdict, c.verdict, `${c.name}: got ${r.verdict} (${r.reason})`);
    assert.equal(r.reason, c.reason, `${c.name}: reason`);
    assert.equal(r.code, { VERIFIED: 0, BROKEN: 1, "COULD NOT LOOK": 2 }[c.verdict]);
    assert.ok(Array.isArray(r.trusted), "every result names what it trusted");
  }
  assert.ok(cases.length >= 25, `battery has ${cases.length} cases`);
});

test("BREAK ARM: a checker that always answers VERIFIED is caught by every non-VERIFIED case", () => {
  const lying = () => ({ verdict: "VERIFIED", code: 0 });
  const cases = battery().filter((c) => c.verdict !== "VERIFIED");
  assert.ok(cases.length >= 20);
  for (const c of cases) {
    assert.equal(lying(c.args).verdict, "VERIFIED");
    assert.notEqual(follow.follow(c.args).verdict, "VERIFIED", c.name);
  }
});

test("BREAK ARM: a checker that trusts the JSON echo instead of the checkpoint text would pass a swapped root; ours says BROKEN", () => {
  const s = scenario();
  // The attacker rewrites the NEW checkpoint (re-signs it with a leaked key) to a different root but leaves the proof JSON echoing the honest values.
  const t2 = lt.buildTree(leaves(56, "rewritten"));
  const rewrittenNew = cp.signCheckpoint(cp.formatCheckpoint({ size: 56, root: t2.root }), s.key.signer);
  const echoTruster = (doc) => lt.verifyConsistency(lt.parseConsistencyProofDocument(doc)).ok; // never looks at the checkpoint text
  assert.equal(echoTruster(s.doc), true, "the echo alone still verifies");
  const r = follow.follow({ oldText: s.oldText, newText: rewrittenNew, proofText: s.proofText, key: s.key.verifier });
  assert.equal(r.verdict, "BROKEN");
  assert.equal(r.reason, "echo_mismatch");
});

test("CLI: exit 0 VERIFIED, exit 1 BROKEN, exit 2 COULD NOT LOOK, and --help states what it does not prove", () => {
  const s = scenario();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "follow-"));
  const w = (name, text) => {
    const p = path.join(dir, name);
    fs.writeFileSync(p, text);
    return p;
  };
  const oldP = w("old.txt", s.oldText);
  const newP = w("new.txt", s.newText);
  const proofP = w("proof.json", s.proofText);
  const run = (args) => spawnSync(process.execPath, [FOLLOW, ...args], { encoding: "utf8" });

  let r = run(["--old", oldP, "--new", newP, "--proof", proofP, "--key", s.key.verifier]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(r.stdout.startsWith("VERIFIED\n"), r.stdout);
  assert.match(r.stdout, /trusted:/);

  const badProof = w("bad.json", JSON.stringify({ ...s.doc, path: s.doc.path.slice(0, -1) }));
  r = run(["--old", oldP, "--new", newP, "--proof", badProof, "--key", s.key.verifier, "--json"]);
  assert.equal(r.status, 1);
  assert.equal(JSON.parse(r.stdout).verdict, "BROKEN");

  r = run(["--old", oldP, "--new", path.join(dir, "missing.txt"), "--proof", proofP, "--key", s.key.verifier]);
  assert.equal(r.status, 2);
  assert.ok(r.stdout.startsWith("COULD NOT LOOK\n"), r.stdout);

  r = run(["--old", oldP, "--new", newP, "--proof", proofP]);
  assert.equal(r.status, 2, "no key and not --allow-unsigned");

  r = run(["--old", oldP, "--new", newP, "--proof", proofP, "--allow-unsigned"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /UNSIGNED/);

  r = run(["--help"]);
  assert.equal(r.status, 0);
  for (const phrase of ["WHAT A VERIFIED DOES NOT MEAN", "split view", "customer's log", "UNALTERED", "genesis"]) {
    assert.ok(r.stdout.includes(phrase), `--help lacks "${phrase}"`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});
