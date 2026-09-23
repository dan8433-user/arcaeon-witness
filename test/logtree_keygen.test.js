// test/logtree_keygen.test.js — tools/logtree_keygen.js: the signer goes to
// the named file and NOWHERE else (not stdout, not stderr, not --json), the
// printed verifier is the one that verifies the file's signatures (through
// lib/_checkpoint.js AND the dependency-free tools/follow.js), an existing
// file is refused and left untouched, a path that .gitignore would not cover
// is refused, and the env var name printed is the one --key-env is given.
// BREAK ARMS: a keygen that echoed the signer would be caught by the
// no-leak scan; a verifier that ignored the key would be caught by the
// wrong-key case.
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const cp = require("../lib/_checkpoint.js");
const lt = require("../lib/_logtree.js");
const follow = require("../tools/follow.js");

const TOOL = path.join(__dirname, "..", "tools", "logtree_keygen.js");
const run = (args) => spawnSync(process.execPath, [TOOL, ...args], { encoding: "utf8" });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "logtree-keygen-"));

test("writes the signer only to --out, prints only the verifier and the env var name", () => {
  const dir = tmp();
  const out = path.join(dir, "witness-log.signer.key");
  const r = run(["--out", out, "--name", "test.example/log-k1", "--json"]);
  assert.equal(r.status, 0, r.stderr);
  const s = JSON.parse(r.stdout);
  const signer = fs.readFileSync(out, "utf8");
  assert.match(signer, /^PRIVATE\+KEY\+test\.example\/log-k1\+[0-9a-f]{8}\+/);
  assert.equal(signer.includes("\n"), false, "no trailing newline: the file IS the env value");
  assert.equal(s.signer_env, "WITNESS_LOG_SIGNER_KEY");
  assert.equal(s.key_name, "test.example/log-k1");
  // No leak anywhere the operator's terminal or a log could catch it.
  const seedB64 = signer.split("+").slice(4).join("+");
  for (const stream of [r.stdout, r.stderr]) {
    assert.equal(stream.includes("PRIVATE"), false);
    assert.equal(stream.includes(seedB64), false);
  }
  // Human mode leaks nothing either.
  const out2 = path.join(dir, "second.signer.key");
  const r2 = run(["--out", out2]);
  assert.equal(r2.status, 0, r2.stderr);
  const signer2 = fs.readFileSync(out2, "utf8");
  assert.equal(r2.stdout.includes(signer2.split("+").slice(4).join("+")), false);
  assert.equal(r2.stdout.includes("PRIVATE"), false);
  assert.match(r2.stdout, /WITNESS_LOG_SIGNER_KEY/);
  assert.match(r2.stdout, /arcaeon\.io\/witness-log\/\d{4}-\d{2}-\d{2}\+[0-9a-f]{8}\+/);
});

test("the printed verifier verifies the file's signatures, in the lib and in follow.js; another key does not", () => {
  const dir = tmp();
  const out = path.join(dir, "k.signer.key");
  const s = JSON.parse(run(["--out", out, "--json"]).stdout);
  const signer = fs.readFileSync(out, "utf8");
  const root = Buffer.alloc(32, 3);
  const note = cp.signCheckpoint(cp.formatCheckpoint({ origin: lt.LOG_ORIGIN, size: 5, root }), signer);
  assert.equal(cp.verifyCheckpointSignature(note, s.verifier_key).ok, true);
  const proof = JSON.stringify(lt.consistencyProofDocument({ old_size: 5, old_root: root, new_size: 5, new_root: root, path: [] }));
  const v = follow.follow({ oldText: note, newText: note, proofText: proof, key: s.verifier_key });
  assert.equal(v.verdict, "VERIFIED", JSON.stringify(v));
  // Break arm: a different key must not pass.
  const other = cp.generateKey("test.example/other").verifier;
  assert.equal(follow.follow({ oldText: note, newText: note, proofText: proof, key: other }).verdict, "COULD NOT LOOK");
  assert.equal(cp.verifyCheckpointSignature(note, other).ok, false);
});

test("refuses: an existing file (left byte-identical), a path .gitignore would not cover, a bad name", () => {
  const dir = tmp();
  const out = path.join(dir, "k.signer.key");
  assert.equal(run(["--out", out]).status, 0);
  const before = fs.readFileSync(out, "utf8");
  const again = run(["--out", out]);
  assert.equal(again.status, 2);
  assert.match(again.stderr, /already exists/);
  assert.equal(fs.readFileSync(out, "utf8"), before);

  const plain = path.join(dir, "k.txt");
  const r = run(["--out", plain]);
  assert.equal(r.status, 2);
  assert.equal(fs.existsSync(plain), false);

  assert.equal(run(["--out", path.join(dir, "n.signer.key"), "--name", "has space"]).status, 1);
  assert.equal(run(["--out", path.join(dir, "p.signer.key"), "--name", "a+b"]).status, 1);
  assert.equal(run([]).status, 1);
});

test(".gitignore covers the suffix the tool insists on", () => {
  const gi = fs.readFileSync(path.join(__dirname, "..", ".gitignore"), "utf8");
  assert.ok(gi.split(/\r?\n/).includes("*.signer.key"));
  const r = spawnSync("git", ["-C", path.join(__dirname, ".."), "check-ignore", "-q", "somewhere/witness-log.signer.key"]);
  assert.equal(r.status, 0, "git must report the path as ignored");
});
