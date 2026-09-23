// test/check_and_sign.test.js — the stranger's tool (tools/check_and_sign.js).
//
// Drives the module with a synthetic verify.py --json output and an
// injected byte fetcher, so no network and no Python are needed. The CLI
// path is exercised end to end with --from-json, a generated throwaway key,
// and a patched global fetch.
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const cr = require("../lib/_check_record.js");
const tool = require("../tools/check_and_sign.js");

const REPO_URL = "https://github.com/o/r";
const RAW = "https://raw.githubusercontent.com/o/r/main";

// A small verifier output in verify.py's exact shape: two live namespaces,
// one of them with a BROKEN observation, one deleted namespace (repo-level
// BROKEN), a needs_input COULD NOT LOOK, and an optional COULD NOT LOOK.
function fixture() {
  const R = (check, subject, verdict, detail, extra = {}) => ({ check, subject, verdict, detail, file: null, field: null, optional: false, needs_input: false, ...extra });
  return {
    overall: "BROKEN",
    results: [
      R("history-complete", REPO_URL, "VERIFIED", "full history, HEAD abcdef1234, 300 commits touching files"),
      R("append-only", REPO_URL, "BROKEN", "published record DELETED in commit 7fb9846ecb", { file: "pins/gone-ns/00000001.json" }),
      R("namespace-present", "gone-ns", "BROKEN", "namespace deleted from HEAD"),
      R("pin-record", "pins/alpha/00000001.json", "VERIFIED", "parses; seq matches"),
      R("pin-record", "pins/alpha/00000002.json", "VERIFIED", "parses; seq matches"),
      R("pin-seq-contiguous", "alpha", "VERIFIED", "1..2"),
      R("pin-latest", "alpha", "VERIFIED", "latest.json == 00000002.json", { file: "pins/alpha/latest.json" }),
      R("pin-chain-advances", "alpha", "COULD NOT LOOK", "placeholder chain", { optional: true }),
      R("local-log-matches", "alpha", "COULD NOT LOOK", "no --log-head supplied", { needs_input: true }),
      R("pin-record", "pins/beta/00000001.json", "VERIFIED", "parses"),
      R("pin-seq-contiguous", "beta", "VERIFIED", "1..1"),
      R("observations", "observations/beta/2026-09-01T00-00-00-000Z.json", "BROKEN", "key-holder asserted a second history"),
      R("pin-record", "pins/gamma/00000001.json", "VERIFIED", "parses"),
      R("anchor-ots", "gamma", "COULD NOT LOOK", "needs the ots tool"),
    ],
  };
}

test("namespacesAtHead reads only namespaces with a numbered pin at HEAD", () => {
  assert.deepEqual(tool.namespacesAtHead(fixture()), ["alpha", "beta", "gamma"]);
});

test("resultsForNamespace: subject or file under the namespace; needs_input excluded", () => {
  const rs = tool.resultsForNamespace(fixture(), "alpha");
  assert.deepEqual(rs.map((r) => r.check), ["pin-record", "pin-record", "pin-seq-contiguous", "pin-latest", "pin-chain-advances"]);
  assert.deepEqual(tool.resultsForNamespace(fixture(), "gone-ns").map((r) => r.check), ["append-only", "namespace-present"]);
  assert.deepEqual(tool.resultsForNamespace(fixture(), "alph"), []);
});

test("decide mirrors verify.py overall: BROKEN > non-optional COULD NOT LOOK > VERIFIED; empty is COULD_NOT_LOOK", () => {
  const f = fixture();
  assert.equal(tool.decide(tool.resultsForNamespace(f, "alpha")), "VERIFIED", "an optional CNL does not block VERIFIED");
  assert.equal(tool.decide(tool.resultsForNamespace(f, "beta")), "BROKEN");
  assert.equal(tool.decide(tool.resultsForNamespace(f, "gamma")), "COULD_NOT_LOOK");
  assert.equal(tool.decide([]), "COULD_NOT_LOOK");
});

test("BREAK ARM: a decide that always says VERIFIED is caught by the BROKEN and COULD_NOT_LOOK cases", () => {
  const liar = () => "VERIFIED";
  const f = fixture();
  const caught = ["beta", "gamma"].filter((ns) => liar(tool.resultsForNamespace(f, ns)) !== tool.decide(tool.resultsForNamespace(f, ns)));
  assert.deepEqual(caught, ["beta", "gamma"]);
});

test("rawBaseOf / repoUrlOf accept GitHub URLs only", () => {
  assert.equal(tool.rawBaseOf("https://github.com/o/r"), RAW);
  assert.equal(tool.rawBaseOf("https://github.com/o/r.git"), RAW);
  assert.equal(tool.rawBaseOf("git@github.com:o/r.git"), RAW);
  assert.equal(tool.repoUrlOf("git@github.com:o/r.git"), REPO_URL);
  assert.equal(tool.rawBaseOf("https://example.org/o/r"), null);
  assert.equal(tool.rawBaseOf(os.tmpdir()), null, "a directory with no GitHub origin is refused");
});

test("buildSignedRecord: the record verifies, digests the newest pin it fetched, and carries the repo-level verdict", async () => {
  const kp = cr.generateKeyPair();
  const bytes = Buffer.from('{"namespace":"alpha","seq":2}\n');
  const fetched = [];
  const rec = await tool.buildSignedRecord({
    verifierOutput: fixture(), ns: "alpha", repo: REPO_URL, rawBase: RAW,
    fetchBytes: async (url) => { fetched.push(url); return bytes; },
    checkedAt: "2026-09-22T14:02:11Z", checker: { name: "s", binding_url: "https://example.org/s.pub" },
    toolSha256: "ab".repeat(32), verifyPyPath: "verify.py", privateKey: kp.privateKey,
    nowSeconds: Math.floor(Date.parse("2026-09-22T14:05:00Z") / 1000),
  });
  assert.equal(cr.verifyCheckRecord(rec, { nowSeconds: Math.floor(Date.parse("2026-09-22T14:05:00Z") / 1000) }).ok, true);
  assert.deepEqual(fetched, [`${RAW}/pins/alpha/00000002.json`]);
  const digest = crypto.createHash("sha256").update(bytes).digest("hex");
  assert.equal(rec.target.ref, "pins/alpha/00000002.json");
  assert.equal(rec.target.digest, `sha256:${digest}`);
  assert.deepEqual(rec.inputs, [{ url: `${RAW}/pins/alpha/00000002.json`, sha256: digest }]);
  assert.equal(rec.result, "VERIFIED");
  assert.ok(rec.detail.includes("repo-level overall BROKEN ("), "a namespace VERIFIED must not read as a repo VERIFIED");
  assert.ok(rec.detail.includes("pin-chain-advances=COULD NOT LOOK"));
  assert.equal(rec.tool.impl, "independent");
  assert.equal(rec.checker.key, kp.keyId);
  assert.ok(rec.rerun.includes(`--namespace alpha`));
  assert.equal(cr.checkRecordPath(rec), `checks/pin/alpha/2026-09-22T14-02-11Z-${cr.keyIdShort(kp.keyId)}.json`);
});

test("buildSignedRecord: BROKEN observation makes the namespace BROKEN; an absent namespace is refused, not defaulted", async () => {
  const kp = cr.generateKeyPair();
  const common = {
    verifierOutput: fixture(), repo: REPO_URL, rawBase: RAW, fetchBytes: async () => Buffer.from("x"),
    checkedAt: "2026-09-22T14:02:11Z", checker: {}, toolSha256: "ab".repeat(32), verifyPyPath: "verify.py",
    privateKey: kp.privateKey, nowSeconds: Math.floor(Date.parse("2026-09-22T14:05:00Z") / 1000),
  };
  const beta = await tool.buildSignedRecord({ ...common, ns: "beta" });
  assert.equal(beta.result, "BROKEN");
  assert.ok(beta.detail.includes("observations=BROKEN"));
  await assert.rejects(tool.buildSignedRecord({ ...common, ns: "nope" }), (e) => e.reason === "namespace_absent");
  await assert.rejects(tool.buildSignedRecord({ ...common, ns: "gone-ns" }), (e) => e.reason === "namespace_absent", "deleted at HEAD: nothing to digest");
});

test("CLI end to end: --gen-key, --from-json, --all writes create-only records that verify; a second run is refused", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cas-"));
  const fx = path.join(dir, "out.json");
  fs.writeFileSync(fx, JSON.stringify(fixture()));
  const fakeVerifyPy = path.join(dir, "verify.py");
  fs.writeFileSync(fakeVerifyPy, "# stand-in, hashed only\n");
  const keyPath = path.join(dir, "k.pem");
  const outDir = path.join(dir, "checks_out");
  const origFetch = global.fetch;
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  let out = "", err = "";
  global.fetch = async (url) => ({ ok: true, arrayBuffer: async () => Buffer.from(`bytes of ${url}`) });
  process.stdout.write = (s) => { out += s; return true; };
  process.stderr.write = (s) => { err += s; return true; };
  try {
    const args = ["--repo", REPO_URL, "--all", "--key", keyPath, "--gen-key", "--name", "s", "--binding-url", "https://example.org/s.pub",
      "--from-json", fx, "--verify-py", fakeVerifyPy, "--out", outDir, "--now", "2026-09-22T14:02:11Z"];
    const code = await tool.main(args);
    assert.equal(code, 0, err);
    const pem = fs.readFileSync(keyPath, "utf-8");
    const keyId = cr.keyIdOf(cr.publicKeyOfPrivate(cr.privateKeyFromPem(pem)));
    const short = cr.keyIdShort(keyId);
    const files = ["alpha", "beta", "gamma"].map((ns) => path.join(outDir, "checks", "pin", ns, `2026-09-22T14-02-11Z-${short}.json`));
    for (const f of files) assert.ok(fs.existsSync(f), `missing ${f}`);
    const recs = files.map((f) => JSON.parse(fs.readFileSync(f, "utf-8")));
    assert.deepEqual(recs.map((r) => r.result), ["VERIFIED", "BROKEN", "COULD_NOT_LOOK"]);
    for (const r of recs) assert.equal(cr.verifyCheckRecord(r).ok, true);
    assert.equal(recs[0].tool.source_sha256, crypto.createHash("sha256").update(fs.readFileSync(fakeVerifyPy)).digest("hex"));
    assert.ok(out.includes("VERIFIED        alpha"));
    assert.ok(err.includes("repo-level overall BROKEN"));

    const code2 = await tool.main(args.filter((a) => a !== "--gen-key"));
    assert.equal(code2, 2, "create-only: existing files must be refused");
    assert.ok(err.includes("create-only"));
  } finally {
    global.fetch = origFetch;
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
});
