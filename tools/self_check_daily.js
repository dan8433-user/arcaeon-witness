#!/usr/bin/env node
// tools/self_check_daily.js — the operator's DAILY SELF-CHECK writer (design
// page B8 day 2): run the same public-record checks a stranger runs
// (verifier two, through tools/check_and_sign.js's record builder) under the
// operator's DECLARED key, and write one SELF-CHECKED record per namespace.
//
// It is the stranger's tool with two fences added, because this one is ours:
//   1. The signing key MUST appear in the OPERATOR_KEYS.json document passed
//      with --operator-keys. A self-check signed by an undeclared key is a
//      record the status page would read as an OUTSIDE check, i.e. our own
//      look painted green (design B5, sock-puppet risk B10). Refused, exit 2.
//   2. Dry run by default. --write is the only way anything lands on disk,
//      and then only under --out, create-only, in the pins-repo layout
//      checks/<type>/<ns>/<checked_at>-<keyid8>.json. It never commits,
//      pushes, or writes to the store; the daily job decides what to publish.
//
//   node tools/self_check_daily.js --key op.pem --operator-keys OPERATOR_KEYS.json
//        [--repo https://github.com/dan8433-user/arcaeon-witness-pins]
//        [--from-json out.json] [--verify-py PATH] [--out DIR] [--write] [--now ISO]
//
// Every record is verified before it is written (check_and_sign does that);
// every namespace at HEAD gets one record, and a namespace the builder
// refuses is reported SKIPPED, never defaulted.

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const cr = require("../lib/_check_record.js");
const cas = require("./check_and_sign.js");

const DEFAULT_REPO = "https://github.com/dan8433-user/arcaeon-witness-pins";
const CHECKER_NAME = "arcaeon operator daily self-check";

function sha256hex(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

// The declared keys, from an OPERATOR_KEYS.json document. Throws on a
// document with no keys array: an unreadable declaration cannot vouch that
// a key is ours.
function declaredKeys(doc) {
  if (!doc || !Array.isArray(doc.keys)) throw new Error("OPERATOR_KEYS document has no keys array");
  return new Set(doc.keys.filter((k) => k && typeof k.key === "string").map((k) => k.key));
}

// The binding for our own key is the declaration itself, in the public repo.
function bindingUrlFor(repoUrl) {
  return `${repoUrl.replace(/\/+$/, "")}/blob/main/checks/OPERATOR_KEYS.json`;
}

// Build every record for the namespaces at HEAD. Pure over its inputs apart
// from the injected fetchBytes. Returns [{ns, record}|{ns, error}].
async function buildDailyRecords({ verifierOutput, repo, rawBase, fetchBytes, checkedAt, privateKey, ownKeys, toolSha256, verifyPyPath, nowSeconds }) {
  const keyId = cr.keyIdOf(cr.publicKeyOfPrivate(privateKey));
  if (!ownKeys.has(keyId)) {
    const err = new Error(`refusing: key ${keyId} is not in the OPERATOR_KEYS declaration; a self-check under an undeclared key would read as an outside check`);
    err.reason = "key_not_declared";
    throw err;
  }
  const repoUrl = cas.repoUrlOf(repo) || repo;
  const out = [];
  for (const ns of cas.namespacesAtHead(verifierOutput)) {
    try {
      const record = await cas.buildSignedRecord({
        verifierOutput, ns, repo, rawBase, fetchBytes, checkedAt,
        checker: { name: CHECKER_NAME, binding_url: bindingUrlFor(repoUrl) },
        toolSha256, verifyPyPath, privateKey, nowSeconds,
      });
      out.push({ ns, record, rel: cr.checkRecordPath(record) });
    } catch (err) {
      out.push({ ns, error: err.message });
    }
  }
  return out;
}

function parseArgs(argv) {
  const a = { repo: DEFAULT_REPO, out: "checks_out", verifyPy: undefined, py: "py" };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const next = () => { i += 1; if (i >= argv.length) throw new Error(`${k} needs a value`); return argv[i]; };
    if (k === "--repo") a.repo = next();
    else if (k === "--key") a.key = next();
    else if (k === "--operator-keys") a.operatorKeys = next();
    else if (k === "--from-json") a.fromJson = next();
    else if (k === "--verify-py") a.verifyPy = next();
    else if (k === "--py") a.py = next();
    else if (k === "--out") a.out = next();
    else if (k === "--write") a.write = true;
    else if (k === "--now") a.now = next();
    else if (k === "--help" || k === "-h") a.help = true;
    else throw new Error(`unknown argument ${k}`);
  }
  return a;
}

async function main(argv) {
  const a = parseArgs(argv);
  if (a.help) {
    process.stdout.write(fs.readFileSync(__filename, "utf-8").split("\n").filter((l) => l.startsWith("//")).slice(0, 24).map((l) => l.replace(/^\/\/ ?/, "")).join("\n") + "\n");
    return 0;
  }
  if (!a.key) throw new Error("--key PEM path is required (the operator's declared check key)");
  if (!a.operatorKeys) throw new Error("--operator-keys is required: the key must be shown to be declared as ours");
  const verifyPy = a.verifyPy || process.env.ARCAEON_VERIFY_PY || "C:/Users/USER/velouria/projects/online_business/verifier_two/verify.py";
  if (!fs.existsSync(verifyPy)) throw new Error(`verify.py not found at ${verifyPy}`);

  const privateKey = cr.privateKeyFromPem(fs.readFileSync(a.key, "utf-8"));
  const ownKeys = declaredKeys(JSON.parse(fs.readFileSync(a.operatorKeys, "utf-8")));
  const rawBase = cas.rawBaseOf(a.repo);
  if (!rawBase) throw new Error("public inputs only: --repo must be a GitHub URL or a clone whose origin is one");

  const verifierOutput = cas.runVerifier({ repo: a.repo, verifyPy, fromJson: a.fromJson, py: a.py });
  const checkedAt = a.now || new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const fetchBytes = async (url) => {
    const r = await fetch(url, { headers: { "user-agent": cas.TOOL_NAME } });
    if (!r.ok) throw new Error(`fetch ${url} -> ${r.status}`);
    return Buffer.from(await r.arrayBuffer());
  };

  const built = await buildDailyRecords({
    verifierOutput, repo: a.repo, rawBase, fetchBytes, checkedAt, privateKey, ownKeys,
    toolSha256: sha256hex(fs.readFileSync(verifyPy)), verifyPyPath: verifyPy,
    nowSeconds: Math.floor(Date.now() / 1000),
  });

  let failures = 0;
  for (const b of built) {
    if (b.error) {
      failures += 1;
      process.stderr.write(`SKIPPED         ${b.ns}  ${b.error}\n`);
      continue;
    }
    const dest = path.join(a.out, b.rel);
    if (a.write) {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      try {
        fs.writeFileSync(dest, JSON.stringify(b.record, null, 1) + "\n", { flag: "wx" });
      } catch (err) {
        failures += 1;
        process.stderr.write(`SKIPPED         ${b.ns}  create-only: ${dest} ${err.code === "EEXIST" ? "exists" : err.message}\n`);
        continue;
      }
    }
    process.stdout.write(`${b.record.result.padEnd(15)} ${b.ns}  ${a.write ? "" : "(dry run) "}${b.rel}\n`);
  }
  process.stderr.write(`${built.length - failures} self-check record(s) ${a.write ? "written" : "built (dry run; --write to write)"}, ${failures} skipped. These are SELF-CHECKED: the key is declared as ours.\n`);
  return failures ? 2 : 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (err) => {
    process.stderr.write(`error: ${err.message}\n`);
    process.exit(2);
  });
}

module.exports = { DEFAULT_REPO, CHECKER_NAME, declaredKeys, bindingUrlFor, buildDailyRecords, parseArgs, main };
