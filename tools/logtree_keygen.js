#!/usr/bin/env node
// tools/logtree_keygen.js — mint the witness log's checkpoint signing key.
//
// Generates ONE Ed25519 signer/verifier pair in lib/_checkpoint.js's own key
// format (so there is still one key format in this repo), writes the SIGNER
// key to a file the operator names, and prints ONLY:
//
//   - the VERIFIER (public) key: "<name>+<8 hex>+<base64(0x01 || pub)>"
//   - the NAME of the environment variable tools/publish_checkpoint.js expects
//     the signer in (pass it as --key-env)
//
// The signer key ("PRIVATE+KEY+<name>+<8 hex>+<base64(0x01 || seed)>") is never
// printed, never passed on a command line, and never written anywhere but
// --out. The file is created exclusively (an existing file is refused, so a
// key is never silently replaced) with mode 0600; on Windows, where the mode
// bits mean little, the tool also asks icacls to strip inherited access and
// grant only the current user, and says whether that worked.
//
// USAGE
//
//   node tools/logtree_keygen.js --out <path ending in .signer.key> [--name <key name>] [--json]
//
//   --out <path>     where the signer key is written. Must end in ".signer.key"
//                    (the pattern .gitignore refuses to track). Keep it OUTSIDE
//                    any repository anyway; the ignore rule is a second fence.
//   --name <name>    the key name that appears on every signature line. One
//                    token, no whitespace, no "+". Default: arcaeon.io/witness-log/<today UTC>.
//                    A dated name is what makes rotation readable: a new key is
//                    a new name, and old checkpoints keep naming the old one.
//   --json           machine-readable output (still no signer key in it)
//   --help           this text
//
// EXIT CODES: 0 written, 1 usage, 2 refused (file exists, bad path, self-check failed).
//
// After writing, the tool re-reads the file, parses it as a signer key, signs a
// throwaway note and verifies that signature with the printed verifier key. A
// key that cannot do that is refused (exit 2) and the file is removed, so the
// operator is never handed a public key that does not match the private one.
"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const checkpoint = require("../lib/_checkpoint.js");
const { LOG_ORIGIN } = require("../lib/_logtree.js");

// The one name the signer lives under, locally and on Vercel.
const SIGNER_ENV = "WITNESS_LOG_SIGNER_KEY";
const REQUIRED_SUFFIX = ".signer.key";

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
  const a = { json: false };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`${t} needs a value`);
      return argv[++i];
    };
    if (t === "--help" || t === "-h") a.help = true;
    else if (t === "--out") a.out = next();
    else if (t === "--name") a.name = next();
    else if (t === "--json") a.json = true;
    else throw new Error(`unknown argument ${t}`);
  }
  return a;
}

function restrictOnWindows(file) {
  if (process.platform !== "win32") return { tried: false };
  const user = process.env.USERNAME;
  if (!user) return { tried: true, ok: false, detail: "USERNAME unset" };
  const r = spawnSync("icacls", [file, "/inheritance:r", "/grant:r", `${user}:F`], { encoding: "utf8" });
  return { tried: true, ok: r.status === 0, detail: r.status === 0 ? `icacls: only ${user}` : String(r.stderr || r.stdout).trim().slice(0, 200) };
}

// Self-check: the written file must sign a note that the printed verifier accepts.
function selfCheck(signerStr, verifierStr) {
  const text = checkpoint.formatCheckpoint({ origin: LOG_ORIGIN, size: 1, root: Buffer.alloc(32, 7) });
  const signed = checkpoint.signCheckpoint(text, signerStr);
  const v = checkpoint.verifyCheckpointSignature(signed, verifierStr);
  return v.ok;
}

function main(argv) {
  let a;
  try {
    a = parseArgs(argv);
  } catch (e) {
    process.stderr.write(`usage: ${e.message}\n`);
    return 1;
  }
  if (a.help) {
    process.stdout.write(helpText() + "\n");
    return 0;
  }
  if (!a.out) {
    process.stderr.write("usage: --out <path ending in .signer.key> is required (--help for the rest)\n");
    return 1;
  }
  const out = path.resolve(a.out);
  if (!out.endsWith(REQUIRED_SUFFIX)) {
    process.stderr.write(`REFUSED: --out must end in "${REQUIRED_SUFFIX}" so the .gitignore rule covers it\n`);
    return 2;
  }
  const name = a.name || `arcaeon.io/witness-log/${new Date().toISOString().slice(0, 10)}`;
  let pair;
  try {
    pair = checkpoint.generateKey(name);
  } catch (e) {
    process.stderr.write(`usage: ${e.message} (one token, no whitespace, no "+")\n`);
    return 1;
  }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  try {
    fs.writeFileSync(out, pair.signer, { encoding: "utf8", flag: "wx", mode: 0o600 });
  } catch (e) {
    process.stderr.write(`REFUSED: ${out}: ${e.code === "EEXIST" ? "already exists; a key is never replaced in place (rotation = a new name and a new file)" : e.message}\n`);
    return 2;
  }
  const back = fs.readFileSync(out, "utf8");
  let good = false;
  try {
    good = back === pair.signer && selfCheck(back, pair.verifier);
  } catch {
    good = false;
  }
  if (!good) {
    fs.rmSync(out, { force: true });
    process.stderr.write("REFUSED: the written key did not sign a note its verifier accepts; file removed\n");
    return 2;
  }
  const acl = restrictOnWindows(out);
  const pk = checkpoint.parseVerifierKey(pair.verifier);
  const summary = {
    verifier_key: pair.verifier,
    key_name: pk.name,
    key_hash: pk.hash,
    signer_env: SIGNER_ENV,
    signer_file: out,
    windows_acl: acl.tried ? (acl.ok ? "restricted" : `NOT restricted: ${acl.detail}`) : "n/a (mode 0600)",
  };
  if (a.json) {
    process.stdout.write(JSON.stringify(summary) + "\n");
  } else {
    process.stdout.write(`verifier key (public, publish this):\n  ${pair.verifier}\n`);
    process.stdout.write(`signer env var name (--key-env):\n  ${SIGNER_ENV}\n`);
    process.stdout.write(`signer key written to ${out} (not printed; ${summary.windows_acl})\n`);
  }
  return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { main, SIGNER_ENV, REQUIRED_SUFFIX };
