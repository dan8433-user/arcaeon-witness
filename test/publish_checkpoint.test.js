// test/publish_checkpoint.test.js — tools/publish_checkpoint.js against a
// fixture git repository built in a temp dir: leaf ORDER (commit order, then
// path byte order; a path-only order is the BREAK ARM and must give a
// different root), bytes from git (not the working tree), dry run writes
// nothing, --write writes only under --out and never touches the clone,
// checkpoints are create-only, --prev mints a proof follow.js accepts,
// --key-env signs, and the D8 re-add and modified-record refusals fire.
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const lt = require("../lib/_logtree.js");
const cp = require("../lib/_checkpoint.js");

const TOOL = path.join(__dirname, "..", "tools", "publish_checkpoint.js");
const FOLLOW = path.join(__dirname, "..", "tools", "follow.js");
const hex = (b) => b.toString("hex");

function git(repo, args, input) {
  const r = spawnSync(
    "git",
    ["-C", repo, "-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "-c", "core.autocrlf=false", "-c", "commit.gpgsign=false", ...args],
    { encoding: "utf8", input }
  );
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}
function commitFiles(repo, files, msg) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(repo, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", msg]);
  return git(repo, ["rev-parse", "HEAD"]).trim();
}
function run(args, env = {}) {
  return spawnSync(process.execPath, [TOOL, ...args], { encoding: "utf8", env: { ...process.env, ...env } });
}

// The fixture. Paths chosen so that path-only order differs from commit order.
function fixture() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pins-fixture-"));
  git(repo, ["init", "-q", "-b", "main"]);
  const c1 = commitFiles(repo, { "README.md": "readme\n", "pins/z/00000001.json": '{"namespace":"z","rows":1,"chain":"aa","seq":1}\n', "pins/z/latest.json": '{"seq":1}\n' }, "pin z 1");
  const c2 = commitFiles(repo, { "anchors/2026-01-01-head.txt": `${c1} 2026-01-01T03:15:00+00:00\n`, "anchors/2026-01-01-head.txt.ots": "\x00OpenTimestamps" }, "anchor");
  const c3 = commitFiles(repo, { "pins/b/00000001.json": '{"namespace":"b","rows":1,"chain":"bb","seq":1}\n', "pins/a/00000001.json": '{"namespace":"a","rows":1,"chain":"cc","seq":1}\n' }, "pins a and b");
  const c4 = commitFiles(repo, { "observations/a/2026-01-02T00-00-00-000Z.json": '{"verdict":"head-conflict"}\n', "pins/z/latest.json": '{"seq":1,"touched":true}\n' }, "observation + latest moves");
  const c5 = commitFiles(repo, { "pins/z/00000002.json": '{"namespace":"z","rows":2,"chain":"dd","seq":2}\n' }, "pin z 2");
  const expectedOrder = [
    ["pins/z/00000001.json", c1],
    ["anchors/2026-01-01-head.txt", c2],
    ["pins/a/00000001.json", c3],
    ["pins/b/00000001.json", c3],
    ["observations/a/2026-01-02T00-00-00-000Z.json", c4],
    ["pins/z/00000002.json", c5],
  ];
  return { repo, head: c5, expectedOrder };
}

function expectedTree(repo, order) {
  const envelopes = order.map(([p, c]) => {
    const bytes = spawnSync("git", ["-C", repo, "show", `${c}:${p}`], { maxBuffer: 1 << 20 }).stdout;
    return lt.makeEnvelope({ path: p, fileBytes: bytes, introducedByCommit: c });
  });
  return { envelopes, tree: lt.buildTree(envelopes.map((e) => lt.logLeafHash(e))) };
}

test("order rule: commit order then path byte order; root equals a hand-built tree; the BREAK ARM path-only order gives a different root", () => {
  const { repo, head, expectedOrder } = fixture();
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "logout-"));
  const r = run(["--clone", repo, "--out", out, "--date", "2026-01-05", "--json"]);
  assert.equal(r.status, 0, r.stderr);
  const s = JSON.parse(r.stdout);
  assert.equal(s.mode, "dry-run");
  assert.equal(s.tree_commit, head);
  assert.equal(s.size, 6);
  assert.deepEqual(s.skipped_by_design, { latest_json: 1, ots: 1, other: 1 });
  const { tree } = expectedTree(repo, expectedOrder);
  assert.equal(s.root_hex, hex(tree.root), "root equals the tree built by hand in the documented order");
  assert.equal(s.root_base64, tree.root.toString("base64"));
  assert.match(s.genesis_note, /have not changed SINCE that date/);
  // BREAK ARM: a lying enumerator that orders by path alone
  const pathOnly = expectedOrder.slice().sort((x, y) => Buffer.compare(Buffer.from(x[0]), Buffer.from(y[0])));
  assert.notDeepEqual(pathOnly.map((x) => x[0]), expectedOrder.map((x) => x[0]), "the fixture separates the two orders");
  assert.notEqual(hex(expectedTree(repo, pathOnly).tree.root), s.root_hex, "path-only order must not reproduce the root");
  // dry run wrote nothing
  assert.deepEqual(fs.readdirSync(out), []);
  assert.equal(git(repo, ["status", "--porcelain"]), "", "the clone is untouched");
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(out, { recursive: true, force: true });
});

test("--write writes checkpoint + leaves under --out only, create-only on a second run, refuses --out inside the clone; bytes come from git", () => {
  const { repo, expectedOrder } = fixture();
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "logout-"));
  // Make the working tree LIE: rewrite a checked-out record. The tool must hash git's bytes, not the file.
  fs.writeFileSync(path.join(repo, "pins/a/00000001.json"), "working tree lie\n");
  const r = run(["--clone", repo, "--out", out, "--date", "2026-01-05", "--write", "--json"]);
  assert.equal(r.status, 0, r.stderr);
  const s = JSON.parse(r.stdout);
  assert.equal(s.mode, "written");
  const ck = fs.readFileSync(path.join(out, "checkpoints", "2026-01-05.txt"), "utf8");
  const p = cp.parseCheckpoint(ck);
  assert.equal(p.ok, true);
  assert.equal(p.size, 6);
  assert.equal(hex(p.root), hex(expectedTree(repo, expectedOrder).tree.root), "git bytes, not the lying working tree");
  assert.deepEqual(p.signatures, [], "unsigned without --key-env");
  const leaves = fs.readFileSync(path.join(out, "leaves", "2026-01-05.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(leaves.length, 6);
  assert.deepEqual(leaves.map((l) => l.path), expectedOrder.map((x) => x[0]));
  assert.deepEqual(leaves.map((l) => l.introduced_by_commit), expectedOrder.map((x) => x[1]));
  leaves.forEach((l, i) => {
    assert.equal(l.index, i);
    const { index, leaf_hash, ...env } = l;
    assert.equal(hex(lt.logLeafHash(env)), leaf_hash, `leaf ${i} recomputes from its envelope`);
  });
  assert.ok(!fs.existsSync(path.join(out, "proofs")), "no proof without --prev");
  // create-only
  const again = run(["--clone", repo, "--out", out, "--date", "2026-01-05", "--write"]);
  assert.equal(again.status, 2);
  assert.match(again.stderr, /create-only/);
  // never inside the clone
  const inside = run(["--clone", repo, "--out", path.join(repo, "log"), "--write"]);
  assert.equal(inside.status, 2);
  assert.match(inside.stderr, /inside --clone/);
  assert.ok(!fs.existsSync(path.join(repo, "log")));
  // the clone: only our deliberate working-tree edit is dirty, nothing else
  assert.equal(git(repo, ["status", "--porcelain"]).trim(), "M pins/a/00000001.json");
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(out, { recursive: true, force: true });
});

test("--size and --prev: an earlier synthetic checkpoint, a proof to the full one, follow.js says VERIFIED; a tampered leaf makes follow.js say BROKEN; --key-env signs and --key verifies", () => {
  const { repo } = fixture();
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "logout-"));
  const key = cp.generateKey("fixture-log");
  const env = { FIXTURE_LOG_KEY: key.signer };
  let r = run(["--clone", repo, "--out", out, "--date", "2026-01-03", "--size", "4", "--key-env", "FIXTURE_LOG_KEY", "--write", "--json"], env);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).size, 4);
  assert.equal(JSON.parse(r.stdout).signed_by.split("+")[0], "fixture-log");
  const oldP = path.join(out, "checkpoints", "2026-01-03.txt");
  assert.equal(cp.verifyCheckpointSignature(fs.readFileSync(oldP, "utf8"), key.verifier).ok, true);

  r = run(["--clone", repo, "--out", out, "--date", "2026-01-05", "--prev", oldP, "--key-env", "FIXTURE_LOG_KEY", "--write", "--json"], env);
  assert.equal(r.status, 0, r.stderr);
  const s = JSON.parse(r.stdout);
  assert.equal(s.size, 6);
  assert.deepEqual(s.previous.size, 4);
  assert.equal(s.leaves_written, 2, "only the leaves added since --prev");
  const newP = path.join(out, "checkpoints", "2026-01-05.txt");
  const proofP = path.join(out, "proofs", "2026-01-05-consistency.json");
  const doc = JSON.parse(fs.readFileSync(proofP, "utf8"));
  assert.equal(doc.recipe, lt.CONSISTENCY_RECIPE);
  assert.equal(doc.old_size, 4);
  assert.equal(doc.new_size, 6);
  assert.equal(doc.path.length, s.proof_path_length);

  const followRun = (args) => spawnSync(process.execPath, [FOLLOW, ...args], { encoding: "utf8" });
  let f = followRun(["--old", oldP, "--new", newP, "--proof", proofP, "--key", key.verifier]);
  assert.equal(f.status, 0, f.stdout + f.stderr);
  assert.ok(f.stdout.startsWith("VERIFIED\n"));

  // Tamper: a rewritten record in history means a NEW clone (the attacker's) yields a different size-6 root.
  // Rebuild the same history with leaf 3's bytes changed, and sign with the same (leaked) key.
  const t = fs.mkdtempSync(path.join(os.tmpdir(), "pins-tamper-"));
  git(t, ["init", "-q", "-b", "main"]);
  commitFiles(t, { "README.md": "readme\n", "pins/z/00000001.json": '{"namespace":"z","rows":1,"chain":"aa","seq":1}\n', "pins/z/latest.json": '{"seq":1}\n' }, "pin z 1");
  const tc1 = git(t, ["rev-parse", "HEAD"]).trim();
  commitFiles(t, { "anchors/2026-01-01-head.txt": `${tc1} 2026-01-01T03:15:00+00:00\n`, "anchors/2026-01-01-head.txt.ots": "\x00OpenTimestamps" }, "anchor");
  commitFiles(t, { "pins/b/00000001.json": '{"namespace":"b","rows":1,"chain":"TAMPERED","seq":1}\n', "pins/a/00000001.json": '{"namespace":"a","rows":1,"chain":"cc","seq":1}\n' }, "pins a and b");
  commitFiles(t, { "observations/a/2026-01-02T00-00-00-000Z.json": '{"verdict":"head-conflict"}\n' }, "observation");
  commitFiles(t, { "pins/z/00000002.json": '{"namespace":"z","rows":2,"chain":"dd","seq":2}\n' }, "pin z 2");
  const out2 = fs.mkdtempSync(path.join(os.tmpdir(), "logout-"));
  // The tamperer cannot mint a proof from the honest old checkpoint: the tool refuses (its own history does not reproduce it).
  r = run(["--clone", t, "--out", out2, "--date", "2026-01-05", "--prev", oldP, "--key-env", "FIXTURE_LOG_KEY", "--write"], env);
  assert.equal(r.status, 2, "the publisher refuses to mint a proof its clone cannot reproduce");
  assert.match(r.stderr, /does not reproduce the previous checkpoint/);
  // So the tamperer publishes a bare checkpoint and reuses the honest proof file: follow.js must say BROKEN.
  r = run(["--clone", t, "--out", out2, "--date", "2026-01-05", "--key-env", "FIXTURE_LOG_KEY", "--write", "--json"], env);
  assert.equal(r.status, 0, r.stderr);
  const tamperedNew = path.join(out2, "checkpoints", "2026-01-05.txt");
  assert.notEqual(JSON.parse(r.stdout).root_hex, s.root_hex);
  f = followRun(["--old", oldP, "--new", tamperedNew, "--proof", proofP, "--key", key.verifier, "--json"]);
  assert.equal(f.status, 1, f.stdout + f.stderr);
  assert.equal(JSON.parse(f.stdout).verdict, "BROKEN");
  // and with a proof honestly minted over the tampered history from the tampered log's own size-4 (which differs from the honest size-4 root), the OLD checkpoint's root does not match
  const t4 = run(["--clone", t, "--out", out2, "--date", "2026-01-03", "--size", "4", "--write"]);
  assert.equal(t4.status, 0);
  const t6 = run(["--clone", t, "--out", out2, "--date", "2026-01-06", "--prev", path.join(out2, "checkpoints", "2026-01-03.txt"), "--key-env", "FIXTURE_LOG_KEY", "--write"], env);
  assert.equal(t6.status, 0, t6.stderr);
  f = followRun(["--old", oldP, "--new", path.join(out2, "checkpoints", "2026-01-06.txt"), "--proof", path.join(out2, "proofs", "2026-01-06-consistency.json"), "--key", key.verifier, "--json"]);
  assert.equal(f.status, 1);
  assert.equal(JSON.parse(f.stdout).reason, "echo_mismatch", "the tamperer's proof echoes its own old root, not the honest checkpoint's");

  for (const d of [repo, t, out, out2]) fs.rmSync(d, { recursive: true, force: true });
});

test("refusals: a path added twice on the first-parent walk (D8), and a record modified after its add; a deleted record is counted, not logged", () => {
  const { repo } = fixture();
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "logout-"));
  // delete a record, then re-add it
  fs.rmSync(path.join(repo, "pins/b/00000001.json"));
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "test cleanup"]);
  let r = run(["--clone", repo, "--out", out, "--json"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).size, 5);
  assert.equal(JSON.parse(r.stdout).eligible_paths_added_in_history_but_absent_at_commit, 1);
  commitFiles(repo, { "pins/b/00000001.json": '{"namespace":"b","rows":1,"chain":"bb","seq":1}\n' }, "re-add");
  r = run(["--clone", repo, "--out", out]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /added more than once/);
  fs.rmSync(repo, { recursive: true, force: true });

  const m = fixture();
  commitFiles(m.repo, { "pins/a/00000001.json": '{"namespace":"a","rows":1,"chain":"cc","seq":1,"edited":true}\n' }, "typo fix in a logged record");
  r = run(["--clone", m.repo, "--out", out]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /differs between its introducing commit/);
  fs.rmSync(m.repo, { recursive: true, force: true });
  fs.rmSync(out, { recursive: true, force: true });
});

test("--help restates what the log does not prove, and the sizing of --size is bounded", () => {
  const r = run(["--help"]);
  assert.equal(r.status, 0);
  for (const phrase of ["WHAT THE LOG STILL DOES NOT PROVE", "Split view", "customer's log", "UNALTERED", "genesis is retroactive", "never writes into the clone"]) {
    assert.ok(r.stdout.includes(phrase), `--help lacks "${phrase}"`);
  }
  const { repo } = fixture();
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "logout-"));
  const big = run(["--clone", repo, "--out", out, "--size", "99"]);
  assert.equal(big.status, 2);
  assert.match(big.stderr, /exceeds/);
  const zero = run(["--clone", repo, "--out", out, "--size", "0"]);
  assert.equal(zero.status, 1);
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(out, { recursive: true, force: true });
});
