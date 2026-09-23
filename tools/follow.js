#!/usr/bin/env node
// tools/follow.js — the stranger's checker. Given two published checkpoints
// of the Arcaeon witness log and the consistency proof between them, answer
// ONE of three words and exit with the matching code:
//
//   VERIFIED        exit 0   the log named by the new checkpoint extends the log
//                            named by the old one, unaltered
//   BROKEN          exit 1   the evidence contradicts that: names what failed
//   COULD NOT LOOK  exit 2   a file was unreadable, a format was unknown, or
//                            a signature could not be attributed; never folded
//                            into either of the other two
//
// This file has NO dependencies beyond Node's own modules (fs, crypto), and it
// does not require anything from lib/. Copy this one file and run it. It is a
// second implementation of the RFC 9162 §2.1.4.2 verifier, written from the
// RFC text, and test/follow.test.js cross-checks it against lib/_logtree.js
// on every tree pair it can generate: if they ever disagree, one of them is
// wrong and the disagreement is the finding.
//
// USAGE
//
//   node tools/follow.js --old <checkpoint.txt> --new <checkpoint.txt> --proof <consistency.json> \
//        --key "<name>+<8 hex>+<base64>"        the log's public verifier key
//   [--allow-unsigned]   check consistency even if no --key is given (then the
//                        checkpoints' authenticity rests only on where you got them)
//   [--json]             machine-readable result
//   --help               this text, including what a VERIFIED does NOT mean
//
// WHAT IT CHECKS, in order, stopping at the first failure
//   1. both checkpoint files and the proof file can be read (else COULD NOT LOOK)
//   2. each checkpoint parses: three lines "origin / size / base64 root", LF
//      endings, then optionally an empty line and signature lines (else COULD NOT LOOK)
//   3. the proof parses as JSON with the known recipe and origin (an unknown
//      recipe or origin is COULD NOT LOOK, never a pass with a warning)
//   4. both checkpoints name the same origin, and it is the proof's (else COULD NOT LOOK)
//   5. with --key: each checkpoint carries a valid Ed25519 signature by that key.
//      No line for the key: COULD NOT LOOK. A line that does not verify: BROKEN.
//   6. the proof's echoed sizes and roots equal what the CHECKPOINT TEXT says;
//      size and root are taken from the text, never from the JSON (else BROKEN)
//   7. the RFC 9162 consistency check. Sizes equal: roots must match and the
//      path must be empty. old_size 0, old_size > new_size, an empty path when
//      the sizes differ, any hash that is not exactly 64 lowercase hex: BROKEN,
//      never trimmed or padded.
//
// WHAT A VERIFIED DOES NOT MEAN (from the design page, its own words)
//   1. Nothing about records accepted but not yet in a checkpoint: they rest on
//      the operator's word alone until a checkpoint covers them.
//   2. Nothing about split view: one operator on one host could show you one
//      checkpoint and someone else another; each verifies alone. A Bitcoin
//      timestamp proves a checkpoint existed, not that it was the only one.
//      Compare your checkpoint with other people's.
//   3. Nothing about whether a customer's log at head N extends its log at head
//      M. This log is the witness's own list of accepted heads, not the
//      customer's log.
//   4. Nothing about completeness of any customer's record.
//   5. Nothing about whether this checker is right. It is one implementation.
//   6. Nothing about whether anything recorded is true. A stamp of UNALTERED,
//      never of truth.
//   And a checkpoint's leaves that predate the log's genesis are proven
//   unchanged only SINCE genesis.
//
// TRUST DEPENDENCIES it prints: the files you handed it, the key you handed
// it, and Node's crypto. It fetches nothing.
"use strict";

const fs = require("fs");
const crypto = require("crypto");

const CONSISTENCY_RECIPE = "rfc9162-consistency:sha256:v1";
const KNOWN_ORIGINS = new Set(["arcaeon.io/witness-pins/log/v1"]);
const HEX64 = /^[0-9a-f]{64}$/;
const SIG_PREFIX = "— ";
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function sha256(...parts) {
  const h = crypto.createHash("sha256");
  for (const p of parts) h.update(p);
  return h.digest();
}
const nodeHash = (l, r) => sha256(Buffer.from([0x01]), l, r);
const lsb = (x) => (x & 1) === 1;

function decodeRoot(s) {
  if (typeof s !== "string" || !/^[A-Za-z0-9+/]{43}=$/.test(s)) return null;
  const b = Buffer.from(s, "base64");
  return b.length === 32 && b.toString("base64") === s ? b : null;
}

// ---- checkpoint parsing (mirrors the format in lib/_checkpoint.js's header) ----
function parseCheckpoint(contents) {
  if (typeof contents !== "string" || contents.includes("\r")) return { ok: false, reason: "malformed_checkpoint" };
  const lines = contents.split("\n");
  if (lines.length < 4 || lines[lines.length - 1] !== "") return { ok: false, reason: "malformed_checkpoint" };
  lines.pop();
  const [origin, sizeStr, rootB64] = lines;
  if (!/^[!-~]+$/.test(origin)) return { ok: false, reason: "malformed_checkpoint" };
  if (!/^(0|[1-9][0-9]*)$/.test(sizeStr) || sizeStr.length > 15) return { ok: false, reason: "malformed_checkpoint" };
  const root = decodeRoot(rootB64);
  if (!root) return { ok: false, reason: "malformed_checkpoint" };
  const text = `${origin}\n${sizeStr}\n${rootB64}\n`;
  const signatures = [];
  if (lines.length > 3) {
    if (lines[3] !== "" || lines.length === 4) return { ok: false, reason: "malformed_checkpoint" };
    for (const line of lines.slice(4)) {
      if (!line.startsWith(SIG_PREFIX)) return { ok: false, reason: "malformed_checkpoint" };
      const rest = line.slice(SIG_PREFIX.length).split(" ");
      if (rest.length !== 2) return { ok: false, reason: "malformed_checkpoint" };
      const blob = Buffer.from(rest[1], "base64");
      if (blob.toString("base64") !== rest[1] || blob.length !== 68) return { ok: false, reason: "malformed_checkpoint" };
      signatures.push({ name: rest[0], hash: blob.subarray(0, 4).toString("hex"), sig: blob.subarray(4) });
    }
  }
  return { ok: true, origin, size: Number(sizeStr), root, text, signatures };
}

function parseVerifierKey(str) {
  if (typeof str !== "string") return { ok: false, reason: "malformed_key" };
  // chop at the first two "+" only: the base64 tail may contain "+"
  const i1 = str.indexOf("+");
  const i2 = i1 < 0 ? -1 : str.indexOf("+", i1 + 1);
  if (i2 < 0) return { ok: false, reason: "malformed_key" };
  const parts = [str.slice(0, i1), str.slice(i1 + 1, i2), str.slice(i2 + 1)];
  if (!/^[!-*,-~]+$/.test(parts[0]) || !/^[0-9a-f]{8}$/.test(parts[1])) return { ok: false, reason: "malformed_key" };
  const raw = Buffer.from(parts[2], "base64");
  if (raw.toString("base64") !== parts[2] || raw.length !== 33 || raw[0] !== 0x01) return { ok: false, reason: "malformed_key" };
  const pub = raw.subarray(1);
  const h = sha256(Buffer.from(parts[0], "utf8"), Buffer.from("\n"), Buffer.from([0x01]), pub).subarray(0, 4).toString("hex");
  if (h !== parts[1]) return { ok: false, reason: "key_hash_mismatch" };
  return { ok: true, name: parts[0], hash: parts[1], publicKey: crypto.createPublicKey({ key: Buffer.concat([SPKI_PREFIX, pub]), format: "der", type: "spki" }) };
}

function checkSignature(parsed, key) {
  const mine = parsed.signatures.filter((s) => s.name === key.name && s.hash === key.hash);
  if (mine.length === 0) return { ok: false, reason: "no_signature_for_key" };
  for (const s of mine) {
    let good = false;
    try {
      good = crypto.verify(null, Buffer.from(parsed.text, "utf8"), key.publicKey, s.sig);
    } catch {
      good = false;
    }
    if (good) return { ok: true, reason: "signed" };
  }
  return { ok: false, reason: "bad_signature" };
}

// ---- RFC 9162 §2.1.4.2, from the text ----
function verifyConsistency(first, second, firstHash, secondHash, pathHex) {
  if (!Number.isInteger(first) || !Number.isInteger(second) || !Array.isArray(pathHex)) return { ok: false, reason: "malformed_proof" };
  const path = [];
  for (const p of pathHex) {
    if (typeof p !== "string" || !HEX64.test(p)) return { ok: false, reason: "malformed_hash" };
    path.push(Buffer.from(p, "hex"));
  }
  if (first < 1) return { ok: false, reason: "old_size_zero" };
  if (first > second) return { ok: false, reason: "old_size_greater_than_new" };
  if (first === second) {
    if (path.length !== 0) return { ok: false, reason: "equal_sizes_nonempty_path" };
    return firstHash.equals(secondHash) ? { ok: true, reason: "consistent" } : { ok: false, reason: "equal_sizes_root_mismatch" };
  }
  if (path.length === 0) return { ok: false, reason: "empty_path" }; // step 1
  const cp = (first & (first - 1)) === 0 ? [firstHash, ...path] : path; // step 2
  let fn = first - 1; // step 3
  let sn = second - 1;
  while (lsb(fn)) { fn >>= 1; sn >>= 1; } // step 4
  let fr = cp[0]; // step 5
  let sr = cp[0];
  for (let i = 1; i < cp.length; i++) { // step 6
    const c = cp[i];
    if (sn === 0) return { ok: false, reason: "path_too_long" };
    if (lsb(fn) || fn === sn) {
      fr = nodeHash(c, fr);
      sr = nodeHash(c, sr);
      if (!lsb(fn)) while (!(lsb(fn) || fn === 0)) { fn >>= 1; sn >>= 1; }
    } else {
      sr = nodeHash(sr, c);
    }
    fn >>= 1; sn >>= 1;
  }
  if (sn !== 0) return { ok: false, reason: "path_too_short" }; // step 7
  if (!fr.equals(firstHash)) return { ok: false, reason: "old_root_mismatch" };
  if (!sr.equals(secondHash)) return { ok: false, reason: "new_root_mismatch" };
  return { ok: true, reason: "consistent" };
}

// ---- the verdict ----
// Takes file CONTENTS (strings), so tests can drive it without a filesystem.
// Returns { verdict: "VERIFIED"|"BROKEN"|"COULD NOT LOOK", code, reason, detail, trusted }.
function follow({ oldText, newText, proofText, key = null, allowUnsigned = false }) {
  const trusted = ["the checkpoint files handed to this checker", "the proof file handed to this checker", "node:crypto"];
  const cnl = (reason, detail) => ({ verdict: "COULD NOT LOOK", code: 2, reason, detail, trusted });
  const broken = (reason, detail) => ({ verdict: "BROKEN", code: 1, reason, detail, trusted });

  const oldC = parseCheckpoint(oldText);
  if (!oldC.ok) return cnl("old_checkpoint_malformed");
  const newC = parseCheckpoint(newText);
  if (!newC.ok) return cnl("new_checkpoint_malformed");

  let doc;
  try {
    doc = JSON.parse(proofText);
  } catch {
    return cnl("proof_not_json");
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return cnl("proof_not_object");
  if (doc.recipe !== CONSISTENCY_RECIPE) return cnl("unknown_recipe", String(doc.recipe));
  if (!KNOWN_ORIGINS.has(doc.origin)) return cnl("unknown_origin", String(doc.origin));
  if (oldC.origin !== newC.origin) return cnl("origin_mismatch", `${oldC.origin} vs ${newC.origin}`);
  if (oldC.origin !== doc.origin) return cnl("origin_mismatch", `checkpoints ${oldC.origin} vs proof ${doc.origin}`);

  if (key) {
    const k = parseVerifierKey(key);
    if (!k.ok) return cnl(k.reason);
    trusted.push(`verifier key ${k.name}+${k.hash} (handed to this checker)`);
    for (const [label, c] of [["old", oldC], ["new", newC]]) {
      const s = checkSignature(c, k);
      if (!s.ok) {
        if (s.reason === "no_signature_for_key") return cnl("no_signature_for_key", `${label} checkpoint carries no signature by ${k.name}+${k.hash}`);
        return broken("bad_signature", `${label} checkpoint: a signature line claims ${k.name}+${k.hash} and does not verify over the note text`);
      }
    }
  } else if (!allowUnsigned) {
    return cnl("no_key_given", "pass --key <verifier key>, or --allow-unsigned to check consistency alone");
  } else {
    trusted.push("UNSIGNED: the checkpoints' authenticity rests only on where you fetched them");
  }

  // design A4: size and root come from the checkpoint TEXT; the JSON echo must agree
  if (doc.old_size !== oldC.size) return broken("echo_mismatch", `proof says old_size ${doc.old_size}, old checkpoint says ${oldC.size}`);
  if (doc.new_size !== newC.size) return broken("echo_mismatch", `proof says new_size ${doc.new_size}, new checkpoint says ${newC.size}`);
  const oldEcho = decodeRoot(doc.old_root);
  const newEcho = decodeRoot(doc.new_root);
  if (!oldEcho || !oldEcho.equals(oldC.root)) return broken("echo_mismatch", "proof's old_root is not the old checkpoint's root");
  if (!newEcho || !newEcho.equals(newC.root)) return broken("echo_mismatch", "proof's new_root is not the new checkpoint's root");

  const v = verifyConsistency(oldC.size, newC.size, oldC.root, newC.root, doc.path);
  if (!v.ok) return broken(v.reason, `hop ${oldC.size} -> ${newC.size}`);
  return {
    verdict: "VERIFIED",
    code: 0,
    reason: "consistent",
    detail: `the log at size ${oldC.size} is an unaltered prefix of the log at size ${newC.size} (${Array.isArray(doc.path) ? doc.path.length : 0} proof hashes)`,
    trusted,
  };
}

function helpText() {
  const src = fs.readFileSync(__filename, "utf8").split("\n");
  const out = [];
  for (const line of src.slice(1)) {
    if (!line.startsWith("//")) break;
    out.push(line.replace(/^\/\/ ?/, ""));
  }
  return out.join("\n");
}

function main(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    const next = () => argv[++i];
    if (t === "--help" || t === "-h") a.help = true;
    else if (t === "--old") a.old = next();
    else if (t === "--new") a.new = next();
    else if (t === "--proof") a.proof = next();
    else if (t === "--key") a.key = next();
    else if (t === "--allow-unsigned") a.allowUnsigned = true;
    else if (t === "--json") a.json = true;
    else {
      process.stderr.write(`usage: unknown argument ${t}\n`);
      return 2;
    }
  }
  if (a.help) {
    process.stdout.write(helpText() + "\n");
    return 0;
  }
  if (!a.old || !a.new || !a.proof) {
    process.stderr.write("usage: --old <checkpoint> --new <checkpoint> --proof <json> [--key <verifier key> | --allow-unsigned]\n");
    return 2;
  }
  const read = (p) => {
    try {
      return fs.readFileSync(p, "utf8");
    } catch (e) {
      return { err: e.message };
    }
  };
  const texts = { oldText: read(a.old), newText: read(a.new), proofText: read(a.proof) };
  for (const [k, v] of Object.entries(texts)) {
    if (v && typeof v === "object" && v.err) {
      const r = { verdict: "COULD NOT LOOK", code: 2, reason: "unreadable", detail: `${k}: ${v.err}`, trusted: [] };
      process.stdout.write(a.json ? JSON.stringify(r) + "\n" : `${r.verdict}\n  ${r.reason}: ${r.detail}\n`);
      return 2;
    }
  }
  const r = follow({ ...texts, key: a.key || null, allowUnsigned: !!a.allowUnsigned });
  if (a.json) process.stdout.write(JSON.stringify(r) + "\n");
  else {
    process.stdout.write(`${r.verdict}\n  ${r.reason}${r.detail ? `: ${r.detail}` : ""}\n  trusted:\n`);
    for (const t of r.trusted) process.stdout.write(`    - ${t}\n`);
  }
  return r.code;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { follow, verifyConsistency, parseCheckpoint, parseVerifierKey, main };
