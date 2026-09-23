#!/usr/bin/env node
// tools/check_and_sign.js — a STRANGER's tool: run the public-record checks
// against the pins repo and emit a signed check record per namespace, under
// a throwaway key that is yours, not ours.
//
// This is what makes CHECKED reachable by someone who is not the operator
// (design page B3/B5). Nothing in it needs a secret of ours. It does not
// import api/verify.js (that is the witness answering "is this head in my
// own store", our code over our store — not an outside look). The checks it
// runs are verifier two's: `verify.py`, a stdlib-only Python program written
// from PUBLIC_RECORD_SPEC and not from our JS. This tool calls it with
// --json, or reads a JSON file you produced yourself, and folds the results
// for ONE namespace into one signed record.
//
//   node tools/check_and_sign.js --repo https://github.com/dan8433-user/arcaeon-witness-pins \
//        --namespace acme-prod --key my.pem [--gen-key] --name "handle" \
//        --binding-url https://github.com/you/keys/blob/main/arcaeon.pub \
//        [--verify-py PATH | --from-json out.json --verify-py PATH] [--out checks_out] [--dry-run]
//
//   --all               one record per namespace present at HEAD
//   --gen-key           write a fresh Ed25519 key to --key first (PKCS#8 PEM)
//   --from-json FILE    use a saved `py verify.py <repo> --json` output
//                       instead of running verify.py (the file's checks are
//                       still yours: you ran them). --verify-py is still
//                       needed so the record can carry the tool's sha256.
//
// Verdict rule per namespace, mirroring verify.py's own `overall`, over the
// results whose subject or file is that namespace's (pins/<ns>/..., or
// observations/<ns>/..., or the bare namespace name): any BROKEN -> BROKEN;
// else any non-optional COULD NOT LOOK -> COULD_NOT_LOOK; else VERIFIED.
// Results that need the customer's own log (`needs_input`) are excluded:
// they are not a failed look at public data. A repo-level BROKEN elsewhere
// (a deleted record in some other namespace) does NOT flip this
// namespace's record; it is written into `detail` so nobody reads a
// namespace VERIFIED as a repo VERIFIED.
//
// target.digest is the sha256 of the namespace's newest numbered pin, as
// fetched from raw.githubusercontent.com by this tool (that fetch is also
// the record's public input). Output path: checks/pin/<ns>/<ts>-<keyid8>.json
// under --out, the same relative path the record would take in the pins
// repo. Every record is verified with lib/_check_record.js before it is
// written; a record that does not verify is not written.

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const cr = require("../lib/_check_record.js");

const TOOL_NAME = "arcaeon-verifier-two+check_and_sign";
const TOOL_VERSION = "0.1.0";
const DEFAULT_VERIFY_PY = process.env.ARCAEON_VERIFY_PY
  || "C:/Users/USER/velouria/projects/online_business/verifier_two/verify.py";
const TRUST_DEPENDENCIES = ["github.com", "raw.githubusercontent.com"];

function sha256hex(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function rawBaseOf(repo) {
  const m = /^(?:https?:\/\/|git@)github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(String(repo));
  if (m) return `https://raw.githubusercontent.com/${m[1]}/${m[2]}/main`;
  // A local clone: derive from its origin remote. Public inputs only, so a
  // clone with no GitHub origin is refused.
  try {
    const r = spawnSync("git", ["-C", repo, "remote", "get-url", "origin"], { encoding: "utf-8" });
    if (r.status === 0) {
      const m2 = /^(?:https?:\/\/|git@)github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?\s*$/.exec(r.stdout);
      if (m2) return `https://raw.githubusercontent.com/${m2[1]}/${m2[2]}/main`;
    }
  } catch { /* fall through */ }
  return null;
}
function repoUrlOf(repo) {
  const base = rawBaseOf(repo);
  if (!base) return null;
  const m = /^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/main$/.exec(base);
  return `https://github.com/${m[1]}/${m[2]}`;
}

// Run verify.py --json (or load a saved output). Returns the parsed object.
function runVerifier({ repo, verifyPy, fromJson, py = "py" }) {
  if (fromJson) return JSON.parse(fs.readFileSync(fromJson, "utf-8"));
  const r = spawnSync(py, [verifyPy, repo, "--json"], { encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw new Error(`could not run ${py} ${verifyPy}: ${r.error.message}`);
  if (![0, 1, 2].includes(r.status)) throw new Error(`verify.py exited ${r.status}: ${(r.stderr || "").slice(0, 500)}`);
  return JSON.parse(r.stdout);
}

function belongsTo(result, ns) {
  const s = String(result.subject || "");
  const f = String(result.file || "");
  const under = (x) => x === ns || x.startsWith(`pins/${ns}/`) || x.startsWith(`observations/${ns}/`);
  return under(s) || under(f);
}

function resultsForNamespace(verifierOutput, ns) {
  return (verifierOutput.results || []).filter((r) => belongsTo(r, ns) && !r.needs_input);
}

// Namespaces that have a numbered pin at HEAD, read from pin-record results.
function namespacesAtHead(verifierOutput) {
  const out = new Set();
  for (const r of verifierOutput.results || []) {
    if (r.check !== "pin-record") continue;
    const m = /^pins\/([^/]+)\/\d{8}\.json$/.exec(String(r.subject || ""));
    if (m) out.add(m[1]);
  }
  return [...out].sort();
}

function newestPinPath(verifierOutput, ns) {
  let best = null;
  for (const r of verifierOutput.results || []) {
    if (r.check !== "pin-record") continue;
    const m = new RegExp(`^pins/${ns.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/(\\d{8})\\.json$`).exec(String(r.subject || ""));
    if (m && (!best || m[1] > best.seq)) best = { seq: m[1], path: r.subject };
  }
  return best ? best.path : null;
}

// verify.py's `overall`, over one namespace's results.
function decide(results) {
  if (results.some((r) => r.verdict === "BROKEN")) return "BROKEN";
  if (results.some((r) => r.verdict === "COULD NOT LOOK" && !r.optional)) return "COULD_NOT_LOOK";
  if (!results.length) return "COULD_NOT_LOOK";
  return "VERIFIED";
}

function repoLevelNote(verifierOutput) {
  const all = verifierOutput.results || [];
  const broken = all.filter((r) => r.verdict === "BROKEN").length;
  const cnl = all.filter((r) => r.verdict === "COULD NOT LOOK").length;
  const ver = all.filter((r) => r.verdict === "VERIFIED").length;
  return `repo-level overall ${verifierOutput.overall || "?"} (${ver} VERIFIED, ${broken} BROKEN, ${cnl} COULD NOT LOOK across every subject)`;
}

// Build ONE unsigned record for a namespace.
//   fetchBytes(url) -> Buffer   (injected; the CLI uses global fetch)
async function buildUnsignedRecord({ verifierOutput, ns, repo, rawBase, fetchBytes, checkedAt, checker, toolSha256, verifyPyPath }) {
  const results = resultsForNamespace(verifierOutput, ns);
  if (!results.length) {
    const err = new Error(`namespace ${ns}: no public-record results (absent at HEAD, or not in this verifier output)`);
    err.reason = "namespace_absent";
    throw err;
  }
  const pinPath = newestPinPath(verifierOutput, ns);
  if (!pinPath) {
    const err = new Error(`namespace ${ns}: no numbered pin at HEAD to digest`);
    err.reason = "namespace_absent";
    throw err;
  }
  const url = `${rawBase}/${pinPath}`;
  const bytes = await fetchBytes(url);
  const digest = sha256hex(bytes);
  const result = decide(results);
  const counts = { VERIFIED: 0, BROKEN: 0, "COULD NOT LOOK": 0 };
  for (const r of results) counts[r.verdict] = (counts[r.verdict] || 0) + 1;
  const named = results
    .filter((r) => r.verdict !== "VERIFIED")
    .map((r) => `${r.check}=${r.verdict}${r.file ? ` [${r.file}]` : ""}: ${r.detail}`)
    .slice(0, 8);
  const detail = [
    `${results.length} results for ${ns}: ${counts.VERIFIED} VERIFIED, ${counts.BROKEN} BROKEN, ${counts["COULD NOT LOOK"]} COULD NOT LOOK`,
    ...named,
    repoLevelNote(verifierOutput),
  ].join(" | ");
  const repoUrl = repoUrlOf(repo) || repo;
  return {
    kind: cr.RECORD_KIND,
    v: cr.RECORD_VERSION,
    target: { type: "pin", ref: pinPath, digest: `sha256:${digest}` },
    claim_checked: "public-record-checks",
    inputs: [{ url, sha256: digest }],
    result,
    detail,
    checked_at: checkedAt,
    checker: { name: checker.name || "", binding_url: checker.binding_url || "" },
    tool: { name: TOOL_NAME, version: TOOL_VERSION, impl: "independent", source_sha256: toolSha256 },
    trust_dependencies: TRUST_DEPENDENCIES,
    rerun: `py ${verifyPyPath} ${repoUrl} --json > out.json && node tools/check_and_sign.js --from-json out.json --verify-py ${verifyPyPath} --repo ${repoUrl} --namespace ${ns} --key your.pem`,
  };
}

async function buildSignedRecord(args) {
  const unsigned = await buildUnsignedRecord(args);
  const signed = cr.signCheckRecord(unsigned, args.privateKey);
  const v = cr.verifyCheckRecord(signed, { nowSeconds: args.nowSeconds });
  if (!v.ok) throw new Error(`refusing to emit a record that does not verify: ${v.reason} ${v.field}`);
  return signed;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const a = { namespaces: [], out: "checks_out", name: "", bindingUrl: "", verifyPy: DEFAULT_VERIFY_PY, py: "py" };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const next = () => { i += 1; if (i >= argv.length) throw new Error(`${k} needs a value`); return argv[i]; };
    if (k === "--repo") a.repo = next();
    else if (k === "--namespace") a.namespaces.push(next());
    else if (k === "--all") a.all = true;
    else if (k === "--key") a.key = next();
    else if (k === "--gen-key") a.genKey = true;
    else if (k === "--name") a.name = next();
    else if (k === "--binding-url") a.bindingUrl = next();
    else if (k === "--verify-py") a.verifyPy = next();
    else if (k === "--py") a.py = next();
    else if (k === "--from-json") a.fromJson = next();
    else if (k === "--out") a.out = next();
    else if (k === "--now") a.now = next();
    else if (k === "--dry-run") a.dryRun = true;
    else if (k === "--help" || k === "-h") a.help = true;
    else throw new Error(`unknown argument ${k}`);
  }
  return a;
}

async function main(argv) {
  const a = parseArgs(argv);
  if (a.help) {
    process.stdout.write(fs.readFileSync(__filename, "utf-8").split("\n").filter((l) => l.startsWith("//")).slice(0, 40).map((l) => l.replace(/^\/\/ ?/, "")).join("\n") + "\n");
    return 0;
  }
  if (!a.repo) throw new Error("--repo is required");
  if (!a.key) throw new Error("--key PEM path is required (add --gen-key to mint one)");
  if (!a.namespaces.length && !a.all) throw new Error("--namespace <ns> (repeatable) or --all");
  if (!fs.existsSync(a.verifyPy)) throw new Error(`verify.py not found at ${a.verifyPy} (--verify-py or ARCAEON_VERIFY_PY)`);

  let privateKey;
  if (a.genKey) {
    if (fs.existsSync(a.key)) throw new Error(`--gen-key refuses to overwrite ${a.key}`);
    const kp = cr.generateKeyPair();
    fs.writeFileSync(a.key, cr.privateKeyToPem(kp.privateKey), { mode: 0o600 });
    process.stderr.write(`new key ${kp.keyId} written to ${a.key}\n`);
    privateKey = kp.privateKey;
  } else {
    privateKey = cr.privateKeyFromPem(fs.readFileSync(a.key, "utf-8"));
  }
  const keyId = cr.keyIdOf(cr.publicKeyOfPrivate(privateKey));

  const rawBase = rawBaseOf(a.repo);
  if (!rawBase) throw new Error("public inputs only: --repo must be a GitHub URL or a clone whose origin is one");
  const toolSha256 = sha256hex(fs.readFileSync(a.verifyPy));
  const verifierOutput = runVerifier({ repo: a.repo, verifyPy: a.verifyPy, fromJson: a.fromJson, py: a.py });
  const checkedAt = a.now || new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const nowSeconds = Math.floor(Date.now() / 1000);
  const fetchBytes = async (url) => {
    const r = await fetch(url, { headers: { "user-agent": TOOL_NAME } });
    if (!r.ok) throw new Error(`fetch ${url} -> ${r.status}`);
    return Buffer.from(await r.arrayBuffer());
  };

  const targets = a.all ? namespacesAtHead(verifierOutput) : a.namespaces;
  let failures = 0;
  for (const ns of targets) {
    try {
      const rec = await buildSignedRecord({
        verifierOutput, ns, repo: a.repo, rawBase, fetchBytes, checkedAt,
        checker: { name: a.name, binding_url: a.bindingUrl }, toolSha256, verifyPyPath: a.verifyPy,
        privateKey, nowSeconds,
      });
      const rel = cr.checkRecordPath(rec);
      const dest = path.join(a.out, rel);
      if (!a.dryRun) {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        if (fs.existsSync(dest)) throw new Error(`create-only: ${dest} exists`);
        fs.writeFileSync(dest, JSON.stringify(rec, null, 1) + "\n");
      }
      process.stdout.write(`${rec.result.padEnd(15)} ${ns}  ${a.dryRun ? "(dry run) " : ""}${rel}\n`);
    } catch (err) {
      failures += 1;
      process.stderr.write(`SKIPPED         ${ns}  ${err.message}\n`);
    }
  }
  process.stderr.write(`key ${keyId}${a.name ? ` (${a.name})` : ""}; ${targets.length - failures} record(s) ${a.dryRun ? "built" : "written"}, ${failures} skipped. ${repoLevelNote(verifierOutput)}\n`);
  return failures ? 2 : 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (err) => {
    process.stderr.write(`error: ${err.message}\n`);
    process.exit(2);
  });
}

module.exports = {
  TOOL_NAME, TOOL_VERSION, TRUST_DEPENDENCIES,
  rawBaseOf, repoUrlOf, runVerifier, resultsForNamespace, namespacesAtHead, newestPinPath, decide,
  buildUnsignedRecord, buildSignedRecord, parseArgs, main,
};
