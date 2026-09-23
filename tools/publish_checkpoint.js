#!/usr/bin/env node
// tools/publish_checkpoint.js — build the cumulative log tree from a LOCAL
// CLONE of the public pins repo and write a checkpoint (plus the consistency
// proof from a previous checkpoint) into an OUTPUT DIRECTORY you name.
// DESIGN_CONSISTENCY_AND_NEVER_LOOKED_2026-09-22.md A2 (leaf, order), A3
// (files), A4 (formats), A7 (genesis wording), A10 day 2 ("dry-run a local
// genesis").
//
// WHAT IT NEVER DOES: it never writes into the clone, never commits, never
// pushes, never deploys, never reads a private key from a command line. It
// runs read-only git commands against the clone (rev-parse, log, ls-tree,
// cat-file) and writes files ONLY under --out, and only with --write. Without
// --write it is a dry run: it computes everything and prints what it would
// write. Publishing the output into the real repo is a separate, human step
// (design A10 day 5: "Only with Daniel's go").
//
// USAGE
//
//   node tools/publish_checkpoint.js --clone <path> --out <dir> [options]
//
//   --clone <path>     a git clone of dan8433-user/arcaeon-witness-pins (read only)
//   --out <dir>        where checkpoints/, proofs/, leaves/ are written; must not be inside --clone
//   --branch <name>    branch to walk (default: main)
//   --commit <sha>     enumerate at this commit instead of the branch tip (must be on the branch)
//   --date <YYYY-MM-DD> file date (default: today, UTC)
//   --size <n>         truncate the log to its first n leaves (for a synthetic earlier checkpoint)
//   --prev <file>      the previous checkpoint text; writes proofs/<date>-consistency.json from it
//   --key-env <NAME>   NAME of an environment variable holding a signer key
//                      ("PRIVATE+KEY+<name>+<hash>+<base64>", lib/_checkpoint.js); unsigned if absent
//   --write            actually write the files (default: dry run)
//   --json             machine-readable summary only
//   --help             this text, including what the log does NOT prove
//
// EXIT CODES
//   0  built (dry run or written)
//   1  usage error
//   2  REFUSED — a finding about the clone or the output, and nothing was written:
//      a path added more than once on the first-parent walk (DISAGREEMENTS D8),
//      a record whose bytes at the tree commit differ from its introducing commit,
//      a previous checkpoint the clone's history does not reproduce,
//      an output file that already exists (checkpoints are create-only),
//      --out inside --clone.
//
// THE ORDER RULE (lib/_logtree.js header, restated): leaves are ordered by
// the commit that introduced each path, oldest first along the branch's
// first-parent history, ties broken by path in byte order. Recompute it with
//   git log --first-parent --reverse --diff-filter=A --name-only --format=%H <commit>
//
// WHAT THE LOG STILL DOES NOT PROVE (design A9, the page's own words — printed
// by --help because a tool that hides its limits is the failure mode this
// whole design is about):
//   1. The operator inside the pin gap: a record accepted but not yet in a
//      checkpoint rests on our word alone (up to ~24h plus ~34h for the Bitcoin
//      attestation). Anything changed or dropped before a checkpoint covers
//      it, and any pin refused at the door, the log cannot show.
//   2. Split view, without witnesses: one operator on one host could serve
//      checkpoint A to one checker and A' to another; each passes alone. OTS
//      does not close this. Only checkers comparing notes, or a cosigning
//      second witness, catches it.
//   3. That a customer's log at head N extends its log at head M. The log
//      proves the witness's list of accepted heads was not rewritten, not
//      that the heads describe one continuous customer log.
//   4. Completeness of the customer's record — a property of the adapter
//      outside the agent, not of any file here.
//   5. That the checker is right: one implementation until verifier two.
//   6. That anything recorded is true. A stamp of UNALTERED, never of truth.
//   And genesis is retroactive: leaves logged from records already in the
//   repository prove only that they have not changed SINCE the genesis date.
"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const logtree = require("../lib/_logtree.js");
const checkpoint = require("../lib/_checkpoint.js");

function helpText() {
  const src = fs.readFileSync(__filename, "utf8").split("\n");
  const out = [];
  for (const line of src.slice(1)) {
    if (!line.startsWith("//")) break;
    out.push(line.replace(/^\/\/ ?/, ""));
  }
  return out.join("\n");
}

function parseArgs(argv) {
  const a = { branch: "main", write: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`${t} needs a value`);
      return argv[++i];
    };
    if (t === "--help" || t === "-h") a.help = true;
    else if (t === "--clone") a.clone = next();
    else if (t === "--out") a.out = next();
    else if (t === "--branch") a.branch = next();
    else if (t === "--commit") a.commit = next();
    else if (t === "--date") a.date = next();
    else if (t === "--size") a.size = Number(next());
    else if (t === "--prev") a.prev = next();
    else if (t === "--key-env") a.keyEnv = next();
    else if (t === "--write") a.write = true;
    else if (t === "--json") a.json = true;
    else throw new Error(`unknown argument ${t}`);
  }
  return a;
}

// Read-only git. Every call is one of rev-parse / log / ls-tree / cat-file /
// merge-base; nothing here mutates a repository.
function git(clone, args, { input, binary = false } = {}) {
  const opts = { maxBuffer: 1 << 28 };
  if (input !== undefined) opts.input = Buffer.from(input, "utf8");
  if (!binary) opts.encoding = "utf8";
  const r = spawnSync("git", ["-C", clone, "-c", "core.quotePath=false", ...args], opts);
  if (r.error) throw new Error(`git ${args[0]}: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${String(r.stderr).trim()}`);
  return r.stdout;
}

// Walk first-parent history oldest-first and return, for each eligible path,
// the commit that ADDED it. Refuses a path added twice.
function introducingCommits(clone, commit) {
  const out = git(clone, ["log", "--first-parent", "--reverse", "--diff-filter=A", "--name-only", "--format=%x01%H", commit]);
  const intro = new Map(); // path -> commit
  const dup = [];
  const order = []; // [{commit, paths:[...]}] oldest first
  let cur = null;
  for (const raw of out.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (line.startsWith("\x01")) {
      cur = { commit: line.slice(1), paths: [] };
      order.push(cur);
      continue;
    }
    if (line === "" || !cur) continue;
    if (!logtree.kindOfPath(line)) continue;
    if (intro.has(line)) dup.push({ path: line, first: intro.get(line), again: cur.commit });
    else {
      intro.set(line, cur.commit);
      cur.paths.push(line);
    }
  }
  for (const c of order) c.paths.sort((x, y) => Buffer.compare(Buffer.from(x, "utf8"), Buffer.from(y, "utf8")));
  return { intro, order, dup };
}

// Every blob's bytes in one git spawn: cat-file --batch over "<commit>:<path>" lines.
function blobBytes(clone, refs) {
  if (refs.length === 0) return new Map();
  const out = git(clone, ["cat-file", "--batch"], { input: refs.join("\n") + "\n", binary: true });
  const res = new Map();
  let pos = 0;
  for (const ref of refs) {
    const nl = out.indexOf(0x0a, pos);
    if (nl < 0) throw new Error(`cat-file: truncated output at ${ref}`);
    const header = out.subarray(pos, nl).toString("utf8");
    pos = nl + 1;
    const m = /^([0-9a-f]{40}) blob (\d+)$/.exec(header);
    if (!m) throw new Error(`cat-file: "${ref}" is not a blob (${header})`);
    const size = Number(m[2]);
    res.set(ref, out.subarray(pos, pos + size));
    pos += size + 1; // trailing LF after the content
  }
  return res;
}

function main() {
  let a;
  try {
    a = parseArgs(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`usage: ${e.message}\n`);
    return 1;
  }
  if (a.help) {
    process.stdout.write(helpText() + "\n");
    return 0;
  }
  if (!a.clone || !a.out) {
    process.stderr.write("usage: --clone <path> and --out <dir> are required (--help for the rest)\n");
    return 1;
  }
  if (a.size !== undefined && (!Number.isInteger(a.size) || a.size < 1)) {
    process.stderr.write("usage: --size must be a positive integer\n");
    return 1;
  }
  const date = a.date || new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    process.stderr.write("usage: --date must be YYYY-MM-DD\n");
    return 1;
  }

  const cloneAbs = path.resolve(a.clone);
  const outAbs = path.resolve(a.out);
  const rel = path.relative(cloneAbs, outAbs);
  if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) {
    process.stderr.write(`REFUSED: --out (${outAbs}) is inside --clone (${cloneAbs}); this tool never writes into the record repository\n`);
    return 2;
  }

  // --- the tree commit ---
  let commit;
  try {
    commit = git(cloneAbs, ["rev-parse", "--verify", `${a.commit || a.branch}^{commit}`]).trim();
    if (a.commit) {
      const tip = git(cloneAbs, ["rev-parse", "--verify", `${a.branch}^{commit}`]).trim();
      const anc = spawnSync("git", ["-C", cloneAbs, "merge-base", "--is-ancestor", commit, tip]);
      if (anc.status !== 0) {
        process.stderr.write(`REFUSED: ${commit} is not an ancestor of ${a.branch} (${tip})\n`);
        return 2;
      }
    }
  } catch (e) {
    process.stderr.write(`COULD NOT LOOK: ${e.message}\n`);
    return 2;
  }

  // --- enumerate ---
  const present = git(cloneAbs, ["ls-tree", "-r", "--name-only", commit]).split("\n").map((s) => s.replace(/\r$/, "")).filter(Boolean);
  const skipped = { latest_json: 0, ots: 0, other: 0 };
  const presentEligible = new Set();
  for (const p of present) {
    if (logtree.kindOfPath(p)) presentEligible.add(p);
    else if (/\/latest\.json$/.test(p)) skipped.latest_json += 1;
    else if (/\.ots$/.test(p)) skipped.ots += 1;
    else skipped.other += 1;
  }
  const { intro, order, dup } = introducingCommits(cloneAbs, commit);
  if (dup.length) {
    process.stderr.write(`REFUSED: ${dup.length} path(s) added more than once on the first-parent walk (D8); first: ${JSON.stringify(dup[0])}\n`);
    return 2;
  }
  const orphan = [...presentEligible].filter((p) => !intro.has(p));
  if (orphan.length) {
    process.stderr.write(`REFUSED: ${orphan.length} eligible path(s) present at ${commit} with no introducing commit on the walk; first: ${orphan[0]}\n`);
    return 2;
  }
  let absentInHistory = 0;
  const ordered = [];
  for (const c of order) {
    for (const p of c.paths) {
      if (presentEligible.has(p)) ordered.push({ path: p, commit: c.commit });
      else absentInHistory += 1;
    }
  }

  // --- bytes, from git, never from the working tree (spec §8(e)) ---
  const refsIntro = ordered.map((l) => `${l.commit}:${l.path}`);
  const refsNow = ordered.map((l) => `${commit}:${l.path}`);
  let bytesIntro;
  let bytesNow;
  try {
    bytesIntro = blobBytes(cloneAbs, refsIntro);
    bytesNow = blobBytes(cloneAbs, refsNow);
  } catch (e) {
    process.stderr.write(`COULD NOT LOOK: ${e.message}\n`);
    return 2;
  }
  const envelopes = [];
  for (let i = 0; i < ordered.length; i++) {
    const bi = bytesIntro.get(refsIntro[i]);
    const bn = bytesNow.get(refsNow[i]);
    if (!bi.equals(bn)) {
      process.stderr.write(`REFUSED: ${ordered[i].path} differs between its introducing commit ${ordered[i].commit} and ${commit}; a modified record is a finding, not a leaf\n`);
      return 2;
    }
    envelopes.push(logtree.makeEnvelope({ path: ordered[i].path, fileBytes: bi, introducedByCommit: ordered[i].commit }));
  }

  const fullSize = envelopes.length;
  if (fullSize === 0) {
    process.stderr.write("REFUSED: zero eligible records; an empty log commits no root\n");
    return 2;
  }
  const size = a.size !== undefined ? Math.min(a.size, fullSize) : fullSize;
  if (a.size !== undefined && a.size > fullSize) {
    process.stderr.write(`REFUSED: --size ${a.size} exceeds the ${fullSize} eligible records\n`);
    return 2;
  }
  const leafHashes = envelopes.map((e) => logtree.logLeafHash(e));
  const tree = logtree.buildTree(leafHashes);
  const root = tree.rootAt(size);

  // --- checkpoint text, optionally signed ---
  let text = checkpoint.formatCheckpoint({ origin: logtree.LOG_ORIGIN, size, root });
  let signedBy = null;
  if (a.keyEnv) {
    const k = process.env[a.keyEnv];
    if (!k) {
      process.stderr.write(`usage: environment variable ${a.keyEnv} is empty or unset\n`);
      return 1;
    }
    try {
      text = checkpoint.signCheckpoint(text, k);
      const pk = checkpoint.parseSignerKey(k);
      signedBy = `${pk.name}+${pk.hash}`;
    } catch (e) {
      process.stderr.write(`usage: ${e.message}\n`);
      return 1;
    }
  }

  // --- consistency proof from --prev ---
  let proofDoc = null;
  let prevInfo = null;
  if (a.prev) {
    let prevText;
    try {
      prevText = fs.readFileSync(a.prev, "utf8");
    } catch (e) {
      process.stderr.write(`COULD NOT LOOK: --prev ${a.prev}: ${e.message}\n`);
      return 2;
    }
    const p = checkpoint.parseCheckpoint(prevText);
    if (!p.ok) {
      process.stderr.write(`REFUSED: --prev does not parse as a checkpoint (${p.reason}${p.detail ? `: ${p.detail}` : ""})\n`);
      return 2;
    }
    if (p.origin !== logtree.LOG_ORIGIN) {
      process.stderr.write(`REFUSED: --prev origin "${p.origin}" is not this log's origin\n`);
      return 2;
    }
    if (p.size < 1 || p.size > size) {
      process.stderr.write(`REFUSED: --prev size ${p.size} is not within 1..${size}\n`);
      return 2;
    }
    const oldRoot = tree.rootAt(p.size);
    if (!oldRoot.equals(p.root)) {
      process.stderr.write(
        `REFUSED: the clone's history does not reproduce the previous checkpoint (size ${p.size}: clone gives ${oldRoot.toString("hex")}, checkpoint says ${p.root.toString("hex")}). A proof from it would be BROKEN, and that is a finding about our own record, not something to publish around.\n`
      );
      return 2;
    }
    const pathHashes = tree.consistencyProof(p.size, size);
    proofDoc = logtree.consistencyProofDocument({ origin: logtree.LOG_ORIGIN, old_size: p.size, old_root: oldRoot, new_size: size, new_root: root, path: pathHashes });
    // Self-check before anything is written: the proof we mint must verify.
    const v = logtree.verifyConsistency({ old_size: p.size, new_size: size, old_root: oldRoot, new_root: root, path: pathHashes });
    if (!v.ok) {
      process.stderr.write(`REFUSED: minted proof does not verify (${v.reason}); refusing to write it\n`);
      return 2;
    }
    prevInfo = { file: a.prev, size: p.size, root_hex: p.root.toString("hex") };
  }

  // --- leaves file: the envelopes this checkpoint adds ---
  const from = prevInfo ? prevInfo.size : 0;
  const leafLines = [];
  for (let i = from; i < size; i++) {
    leafLines.push(JSON.stringify({ index: i, leaf_hash: leafHashes[i].toString("hex"), ...envelopes[i] }));
  }

  const files = {
    [`checkpoints/${date}.txt`]: text,
    [`leaves/${date}.jsonl`]: leafLines.map((l) => l + "\n").join(""),
  };
  if (proofDoc) files[`proofs/${date}-consistency.json`] = JSON.stringify(proofDoc, null, 1) + "\n";

  // create-only
  for (const rel of Object.keys(files)) {
    const abs = path.join(outAbs, rel);
    if (fs.existsSync(abs)) {
      process.stderr.write(`REFUSED: ${abs} already exists; checkpoints are create-only, pick another --date or --out\n`);
      return 2;
    }
  }

  const summary = {
    mode: a.write ? "written" : "dry-run",
    clone: cloneAbs,
    branch: a.branch,
    tree_commit: commit,
    date,
    origin: logtree.LOG_ORIGIN,
    size,
    eligible_records_at_commit: fullSize,
    root_hex: root.toString("hex"),
    root_base64: root.toString("base64"),
    signed_by: signedBy,
    previous: prevInfo,
    proof_path_length: proofDoc ? proofDoc.path.length : null,
    leaves_written: leafLines.length,
    skipped_by_design: skipped,
    eligible_paths_added_in_history_but_absent_at_commit: absentInHistory,
    files: Object.keys(files).map((rel) => path.join(outAbs, rel)),
    genesis_note:
      from === 0
        ? `Leaves 0 to ${size - 1} were logged on ${date} from records already in the repository. The log proves they have not changed SINCE that date. For their earlier history, rely on the git commit that introduced each file and on the daily anchors.`
        : null,
  };

  if (a.write) {
    for (const [rel, content] of Object.entries(files)) {
      const abs = path.join(outAbs, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content, { encoding: "utf8", flag: "wx" });
    }
  }

  if (a.json) {
    process.stdout.write(JSON.stringify(summary) + "\n");
  } else {
    process.stdout.write(`${summary.mode.toUpperCase()}  ${logtree.LOG_ORIGIN}  size=${size}  commit=${commit}\n`);
    process.stdout.write(`root sha256 ${summary.root_hex}\n`);
    process.stdout.write(`checkpoint:\n${text}`);
    if (prevInfo) process.stdout.write(`proof from size ${prevInfo.size} -> ${size}: ${proofDoc.path.length} hashes\n`);
    process.stdout.write(`skipped by design: latest.json=${skipped.latest_json} .ots=${skipped.ots} other=${skipped.other}; eligible paths in history but absent at commit: ${absentInHistory}\n`);
    for (const f of summary.files) process.stdout.write(`${a.write ? "wrote" : "would write"} ${f}\n`);
    if (summary.genesis_note) process.stdout.write(`${summary.genesis_note}\n`);
  }
  return 0;
}

if (require.main === module) process.exit(main());
module.exports = { introducingCommits, blobBytes, main };
