#!/usr/bin/env node
// tools/operator_keys.js — print the checks/OPERATOR_KEYS.json document for
// every key the operator actually holds (design page B5: "Publish our own
// keys ... Any result signed by one of them is SELF-CHECKED, permanently").
//
// Why this exists: lib/_audit_status.js treats an absent OPERATOR_KEYS.json
// as "every key is ours" (DISAGREEMENTS D4), so until this document is
// published NO key can reach CHECKED, not even a stranger's. The document is
// the thing that lets the status reader tell an outside key from ours.
//
// It never publishes. It prints the document to stdout and, with --out,
// writes it create-only to a local path. It reads public halves only; given
// a private PEM it derives the public key and never prints the private one.
//
//   node tools/operator_keys.js [--no-log-key] [--log-verifier <verifier>]...
//        [--check-key <pem path | ed25519:<base64>>]... [--check-key-name NAME]...
//        [--declared-at YYYY-MM-DD] [--out PATH]
//
//   --log-verifier   a witness-log checkpoint verifier (C2SP form
//                    <name>+<8 hex>+<base64(0x01||pub)>). Default: the
//                    "current verifier" row of docs/LOGTREE_KEY_RUNBOOK.md on
//                    this tree. Its key hash is checked before it is listed.
//   --check-key      a check-and-sign key (lib/_check_record.js format): a
//                    PEM file (private or public) or an ed25519:<base64> id.
//   --check-key-name the name for the matching --check-key (same order).
//
// Key format in the document is lib/_check_record.js's key id,
// "ed25519:<canonical base64 of the raw 32-byte public key>", because that
// is what a check record's checker.key carries and what the status reader
// compares. A checkpoint key is listed in that form too, so a check record
// signed with the log key is also read as ours.

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const cr = require("../lib/_check_record.js");
const cp = require("../lib/_checkpoint.js");

const RUNBOOK = path.join(__dirname, "..", "docs", "LOGTREE_KEY_RUNBOOK.md");
const DOC_VERSION = 1;

// The runbook's table row: | current verifier | `<verifier>` |
function verifierFromRunbook(file = RUNBOOK) {
  const text = fs.readFileSync(file, "utf-8");
  const m = /^\|\s*current verifier\s*\|\s*`([^`]+)`\s*\|/m.exec(text);
  if (!m) throw new Error(`no "current verifier" row in ${file}`);
  return m[1];
}

// C2SP verifier -> one OPERATOR_KEYS entry. Throws on a bad key hash: a key
// whose name and hash disagree is not a key we can say we hold.
function entryFromLogVerifier(verifier) {
  const p = cp.parseVerifierKey(verifier);
  if (!p.ok) throw new Error(`log verifier refused: ${p.reason}`);
  const key = `ed25519:${Buffer.from(p.pub).toString("base64")}`;
  if (!cr.publicKeyFromId(key)) throw new Error("log verifier did not yield a valid ed25519 key id");
  return { key, name: p.name, role: "witness-log checkpoint signer", source: verifier };
}

// PEM path or ed25519: id -> one entry. Private PEM: public half derived.
function entryFromCheckKey(spec, name) {
  let key;
  if (typeof spec === "string" && spec.startsWith("ed25519:")) {
    if (!cr.publicKeyFromId(spec)) throw new Error(`not a canonical ed25519 key id: ${spec}`);
    key = spec;
  } else {
    const pem = fs.readFileSync(spec, "utf-8");
    let pub;
    if (/PRIVATE KEY/.test(pem)) pub = cr.publicKeyOfPrivate(cr.privateKeyFromPem(pem));
    else pub = crypto.createPublicKey({ key: pem, format: "pem" });
    if (pub.asymmetricKeyType !== "ed25519") throw new Error(`${spec}: not an Ed25519 key`);
    key = cr.keyIdOf(pub);
  }
  return { key, name: name || "operator check key", role: "check-and-sign (daily self-check)" };
}

// Build the document. Duplicate keys collapse to the first entry; a key the
// operator holds twice is still one key.
function buildDocument({ entries, declaredAt }) {
  const seen = new Set();
  const keys = [];
  for (const e of entries) {
    if (seen.has(e.key)) continue;
    seen.add(e.key);
    keys.push({ ...e, key_short: cr.keyIdShort(e.key) });
  }
  if (!keys.length) throw new Error("no keys: an empty declaration would read as 'none of these are ours'");
  return {
    v: DOC_VERSION,
    declared_at: declaredAt,
    note: "Every key the operator of this witness controls. Any check record signed by one of these keys is SELF-CHECKED, never CHECKED. This file only grows: a key is added the day it is minted and is never removed, including after rotation.",
    keys,
  };
}

function parseArgs(argv) {
  const a = { logVerifiers: [], checkKeys: [], checkKeyNames: [], logKey: true };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const next = () => { i += 1; if (i >= argv.length) throw new Error(`${k} needs a value`); return argv[i]; };
    if (k === "--log-verifier") a.logVerifiers.push(next());
    else if (k === "--no-log-key") a.logKey = false;
    else if (k === "--check-key") a.checkKeys.push(next());
    else if (k === "--check-key-name") a.checkKeyNames.push(next());
    else if (k === "--declared-at") a.declaredAt = next();
    else if (k === "--runbook") a.runbook = next();
    else if (k === "--out") a.out = next();
    else if (k === "--help" || k === "-h") a.help = true;
    else throw new Error(`unknown argument ${k}`);
  }
  return a;
}

function main(argv, io = { out: (s) => process.stdout.write(s), err: (s) => process.stderr.write(s) }) {
  const a = parseArgs(argv);
  if (a.help) {
    io.out(fs.readFileSync(__filename, "utf-8").split("\n").filter((l) => l.startsWith("//")).slice(0, 30).map((l) => l.replace(/^\/\/ ?/, "")).join("\n") + "\n");
    return 0;
  }
  if (a.declaredAt !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(a.declaredAt)) throw new Error("--declared-at must be YYYY-MM-DD");
  const entries = [];
  const verifiers = a.logVerifiers.length ? a.logVerifiers : (a.logKey ? [verifierFromRunbook(a.runbook)] : []);
  for (const v of verifiers) entries.push(entryFromLogVerifier(v));
  a.checkKeys.forEach((spec, i) => entries.push(entryFromCheckKey(spec, a.checkKeyNames[i])));
  const doc = buildDocument({ entries, declaredAt: a.declaredAt || new Date().toISOString().slice(0, 10) });
  const text = JSON.stringify(doc, null, 1) + "\n";
  if (a.out) {
    // Create-only, like every file under checks/: a declaration is added to,
    // never silently replaced.
    fs.mkdirSync(path.dirname(path.resolve(a.out)), { recursive: true });
    fs.writeFileSync(a.out, text, { flag: "wx" });
    io.err(`wrote ${a.out} (${doc.keys.length} key${doc.keys.length === 1 ? "" : "s"}); not published\n`);
  }
  io.out(text);
  return 0;
}

if (require.main === module) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (err) {
    process.stderr.write(`error: ${err.message}\n`);
    process.exit(2);
  }
}

module.exports = { verifierFromRunbook, entryFromLogVerifier, entryFromCheckKey, buildDocument, parseArgs, main };
