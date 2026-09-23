// test/audit_state_slice2.test.js — audit-state slice 2:
//   1. tools/operator_keys.js   the OPERATOR_KEYS.json document
//   2. tools/self_check_daily.js the operator's daily SELF-CHECKED writer
//   3. outside check sources    a stranger's records by URL, no PR
//   4. /api/status.json twin    carries the audit states behind the flag
// Every group has a BREAK ARM: a variant of the code with the fence removed
// must produce the wrong (upgraded) answer, so the fence is shown to be the
// thing holding the line and not an accident of the fixture.
"use strict";

process.env.GITHUB_PIN_REPO = "test-owner/test-pins";
process.env.GITHUB_PIN_BRANCH = "main";
process.env.GITHUB_PIN_TOKEN = "test-pin-token-never-leaves";

const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { MockGitHubStore, install } = require("./helpers/mock_store.js");
const { makeReq, makeRes } = require("./helpers/http_mocks.js");
const { signed, isoAt } = require("./helpers/check_fixtures.js");
const cr = require("../lib/_check_record.js");
const cp = require("../lib/_checkpoint.js");
const { deriveAuditState } = require("../lib/_audit_state.js");
const auditStatus = require("../lib/_audit_status.js");
const opk = require("../tools/operator_keys.js");
const daily = require("../tools/self_check_daily.js");
const statusHandler = require("../api/status.js");

const REPO = process.env.GITHUB_PIN_REPO;
const NOW = Math.floor(Date.now() / 1000);
const ours = cr.generateKeyPair();
const stranger = cr.generateKeyPair();

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
function check(kp, ns, result, agoSeconds, over = {}) {
  return signed(kp, {
    result, checked_at: isoAt(NOW - agoSeconds),
    target: { ref: `pins/${ns}/00000001.json` },
    checker: { name: kp === ours ? "operator" : "stranger" },
    ...over,
  });
}

// ===========================================================================
// 1. OPERATOR_KEYS
// ===========================================================================
test("OPERATOR_KEYS: the runbook's log verifier becomes an ed25519 key id over the RAW 32 bytes, key hash checked", () => {
  const v = opk.verifierFromRunbook();
  assert.equal(v, "arcaeon.io/witness-log/2026-09-22+09765dec+AdKhx0P0WL2jig0oBbA5OC4I/Yu7dyiA54ju7lcMgQ07");
  const e = opk.entryFromLogVerifier(v);
  const parsed = cp.parseVerifierKey(v);
  assert.equal(e.key, `ed25519:${Buffer.from(parsed.pub).toString("base64")}`);
  assert.ok(cr.publicKeyFromId(e.key), "the id must parse as a check-record key");
  assert.equal(e.name, "arcaeon.io/witness-log/2026-09-22");
  // A verifier whose name was changed no longer matches its key hash.
  assert.throws(() => opk.entryFromLogVerifier(v.replace("2026-09-22+", "2026-09-23+")), /key_hash_mismatch/);
});

test("BREAK ARM OPERATOR_KEYS: listing the verifier's 33 bytes (alg byte kept) would give a key id that matches no signature", () => {
  const parsed = cp.parseVerifierKey(opk.verifierFromRunbook());
  const wrong = `ed25519:${Buffer.concat([Buffer.from([1]), parsed.pub]).toString("base64")}`;
  assert.equal(cr.publicKeyFromId(wrong), null, "the naive conversion is not a key id at all");
});

test("OPERATOR_KEYS: a private PEM yields its PUBLIC key only; output carries no private material; --out is create-only", () => {
  const dir = tmp("opk-");
  const pemPath = path.join(dir, "op.pem");
  fs.writeFileSync(pemPath, cr.privateKeyToPem(ours.privateKey));
  const out = path.join(dir, "OPERATOR_KEYS.json");
  let stdout = "", stderr = "";
  const io = { out: (s) => { stdout += s; }, err: (s) => { stderr += s; } };
  const code = opk.main(["--check-key", pemPath, "--check-key-name", "daily self-check", "--declared-at", "2026-09-22", "--out", out], io);
  assert.equal(code, 0);
  const doc = JSON.parse(fs.readFileSync(out, "utf-8"));
  assert.equal(stdout, fs.readFileSync(out, "utf-8"));
  assert.deepEqual(doc.keys.map((k) => k.key), [opk.entryFromLogVerifier(opk.verifierFromRunbook()).key, ours.keyId]);
  assert.equal(doc.keys[1].name, "daily self-check");
  assert.equal(doc.declared_at, "2026-09-22");
  const seed = cr.privateKeyToPem(ours.privateKey).split("\n").slice(1, -2).join("");
  for (const text of [stdout, stderr]) {
    assert.ok(!/PRIVATE/.test(text), "no PEM header in output");
    assert.ok(!text.includes(seed), "no private key body in output");
  }
  assert.throws(() => opk.main(["--check-key", pemPath, "--out", out], io), /EEXIST/, "create-only");
  assert.throws(() => opk.buildDocument({ entries: [], declaredAt: "2026-09-22" }), /no keys/);
});

test("BREAK ARM OPERATOR_KEYS: the declaration is what keeps our own check from reading as outside", () => {
  const rec = check(ours, "acme-prod", "VERIFIED", 3600);
  const doc = opk.buildDocument({ entries: [opk.entryFromCheckKey(ours.keyId, "ops")], declaredAt: "2026-09-22" });
  const own = new Set(doc.keys.map((k) => k.key));
  assert.equal(deriveAuditState([rec], { ownKeys: own, nowSeconds: NOW }).state, "SELF-CHECKED");
  // Same record, declaration missing our key: it would be painted green.
  assert.equal(deriveAuditState([rec], { ownKeys: new Set(), nowSeconds: NOW }).state, "CHECKED");
  // And a stranger's record against the real declaration IS green: CHECKED is reachable.
  assert.equal(deriveAuditState([check(stranger, "acme-prod", "VERIFIED", 3600)], { ownKeys: own, nowSeconds: NOW }).state, "CHECKED");
});

// ===========================================================================
// 2. DAILY SELF-CHECK WRITER
// ===========================================================================
function verifierFixture() {
  const R = (check, subject, verdict, extra = {}) => ({ check, subject, verdict, detail: "d", file: null, field: null, optional: false, needs_input: false, ...extra });
  return {
    overall: "VERIFIED",
    results: [
      R("pin-record", "pins/alpha/00000001.json", "VERIFIED"),
      R("pin-seq-contiguous", "alpha", "VERIFIED"),
      R("pin-record", "pins/beta/00000001.json", "VERIFIED"),
      R("pin-record", "pins/beta/00000002.json", "VERIFIED"),
    ],
  };
}
const fetchBytes = async (url) => Buffer.from(`bytes of ${url}`);

test("DAILY: every namespace at HEAD gets one verifying record under our declared key, and it derives SELF-CHECKED", async () => {
  const built = await daily.buildDailyRecords({
    verifierOutput: verifierFixture(), repo: "https://github.com/o/r", rawBase: "https://raw.githubusercontent.com/o/r/main",
    fetchBytes, checkedAt: "2026-09-22T06:00:00Z", privateKey: ours.privateKey, ownKeys: new Set([ours.keyId]),
    toolSha256: "ab".repeat(32), verifyPyPath: "verify.py", nowSeconds: NOW,
  });
  assert.deepEqual(built.map((b) => b.ns), ["alpha", "beta"]);
  for (const b of built) {
    assert.equal(cr.verifyCheckRecord(b.record, { nowSeconds: NOW }).ok, true);
    assert.equal(b.record.checker.key, ours.keyId);
    assert.equal(b.record.checker.binding_url, "https://github.com/o/r/blob/main/checks/OPERATOR_KEYS.json");
    assert.match(b.rel, new RegExp(`^checks/pin/${b.ns}/2026-09-22T06-00-00Z-${cr.keyIdShort(ours.keyId)}\\.json$`));
    assert.equal(deriveAuditState([b.record], { ownKeys: new Set([ours.keyId]), nowSeconds: NOW }).state, "SELF-CHECKED");
  }
  assert.equal(built[1].record.target.ref, "pins/beta/00000002.json", "digests the newest pin");
});

test("DAILY FENCE: a key not in the OPERATOR_KEYS declaration is refused before anything is built", async () => {
  await assert.rejects(daily.buildDailyRecords({
    verifierOutput: verifierFixture(), repo: "https://github.com/o/r", rawBase: "https://raw.githubusercontent.com/o/r/main",
    fetchBytes, checkedAt: "2026-09-22T06:00:00Z", privateKey: stranger.privateKey, ownKeys: new Set([ours.keyId]),
    toolSha256: "ab".repeat(32), verifyPyPath: "verify.py", nowSeconds: NOW,
  }), (err) => err.reason === "key_not_declared");
  assert.throws(() => daily.declaredKeys({ nokeys: true }), /no keys array/);
});

test("BREAK ARM DAILY: without the fence, an undeclared operator key's self-check reads as an OUTSIDE check (green)", async () => {
  const cas = require("../tools/check_and_sign.js");
  const rec = await cas.buildSignedRecord({
    verifierOutput: verifierFixture(), ns: "alpha", repo: "https://github.com/o/r", rawBase: "https://raw.githubusercontent.com/o/r/main",
    fetchBytes, checkedAt: isoAt(NOW - 60), checker: { name: daily.CHECKER_NAME, binding_url: "" },
    toolSha256: "ab".repeat(32), verifyPyPath: "verify.py", privateKey: stranger.privateKey, nowSeconds: NOW,
  });
  assert.equal(deriveAuditState([rec], { ownKeys: new Set([ours.keyId]), nowSeconds: NOW }).state, "CHECKED",
    "this is the sock-puppet green the fence exists to refuse");
});

test("DAILY CLI: dry run by default writes nothing; --write writes create-only; a second --write is refused", async () => {
  const dir = tmp("daily-");
  const fx = path.join(dir, "out.json");
  fs.writeFileSync(fx, JSON.stringify(verifierFixture()));
  const vpy = path.join(dir, "verify.py");
  fs.writeFileSync(vpy, "# stand-in\n");
  const pem = path.join(dir, "op.pem");
  fs.writeFileSync(pem, cr.privateKeyToPem(ours.privateKey));
  const keysDoc = path.join(dir, "OPERATOR_KEYS.json");
  fs.writeFileSync(keysDoc, JSON.stringify({ keys: [{ key: ours.keyId }] }));
  const outDir = path.join(dir, "out");
  const origFetch = global.fetch, origOut = process.stdout.write.bind(process.stdout), origErr = process.stderr.write.bind(process.stderr);
  let out = "", err = "";
  global.fetch = async (url) => ({ ok: true, arrayBuffer: async () => Buffer.from(`bytes of ${url}`) });
  process.stdout.write = (s) => { out += s; return true; };
  process.stderr.write = (s) => { err += s; return true; };
  try {
    const base = ["--repo", "https://github.com/o/r", "--key", pem, "--operator-keys", keysDoc, "--from-json", fx, "--verify-py", vpy, "--out", outDir, "--now", "2026-09-22T06:00:00Z"];
    assert.equal(await daily.main(base), 0, err);
    assert.equal(fs.existsSync(outDir), false, "dry run must not create the out dir");
    assert.ok(out.includes("(dry run)"));
    assert.equal(await daily.main([...base, "--write"]), 0, err);
    const short = cr.keyIdShort(ours.keyId);
    for (const ns of ["alpha", "beta"]) {
      const f = path.join(outDir, "checks", "pin", ns, `2026-09-22T06-00-00Z-${short}.json`);
      assert.equal(cr.verifyCheckRecord(JSON.parse(fs.readFileSync(f, "utf-8"))).ok, true, f);
    }
    assert.equal(await daily.main([...base, "--write"]), 2, "create-only");
    assert.ok(err.includes("exists"));
    // Undeclared key through the CLI: refused, exit via throw.
    fs.writeFileSync(keysDoc + ".other", JSON.stringify({ keys: [{ key: stranger.keyId }] }));
    await assert.rejects(daily.main(base.map((a) => (a === keysDoc ? keysDoc + ".other" : a))), /not in the OPERATOR_KEYS declaration/);
  } finally {
    global.fetch = origFetch;
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
});

// ===========================================================================
// 3. OUTSIDE SOURCES
// ===========================================================================
const SRC = "https://github.com/stranger/checks";
const SRC_TREE = "https://api.github.com/repos/stranger/checks/git/trees/main?recursive=1";
const SRC_RAW = "https://raw.githubusercontent.com/stranger/checks/main";

// A mock source: files keyed by path; records every request and its headers.
function mockSource(files, { treeStatus = 200, truncated = false, extraTree = [] } = {}) {
  const log = [];
  const fetchImpl = async (url, opts = {}) => {
    log.push({ url: String(url), opts });
    const ok = (text) => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => text });
    if (url === SRC_TREE) {
      if (treeStatus !== 200) return { ok: false, status: treeStatus };
      const tree = Object.keys(files).map((p) => ({ path: p, type: "blob" })).concat(extraTree);
      return ok(JSON.stringify({ tree, truncated }));
    }
    if (String(url).startsWith(`${SRC_RAW}/`)) {
      const p = String(url).slice(SRC_RAW.length + 1);
      if (!(p in files)) return { ok: false, status: 404 };
      return ok(typeof files[p] === "string" ? files[p] : JSON.stringify(files[p]));
    }
    return { ok: false, status: 404 };
  };
  return { fetchImpl, log };
}
function filesOf(...recs) {
  const o = {};
  for (const r of recs) o[cr.checkRecordPath(r)] = r;
  return o;
}

let gh, restore;
beforeEach(() => {
  gh = new MockGitHubStore();
  restore = install(gh);
  delete process.env.WITNESS_AUDIT_STATE;
  delete process.env.WITNESS_CHECK_SOURCES;
});
afterEach(() => {
  restore();
  delete process.env.WITNESS_AUDIT_STATE;
  delete process.env.WITNESS_CHECK_SOURCES;
});

function gather(namespaces, src, extra = {}) {
  return auditStatus.gatherAuditStates(namespaces, {
    nowSeconds: NOW, env: { WITNESS_CHECK_SOURCES: SRC, ...(extra.env || {}) }, fetchImpl: src.fetchImpl, ...extra.opts,
  });
}

test("api/ is at its 12-function cap, which is why outside records arrive by URL and not through api/check.js", () => {
  const fns = fs.readdirSync(path.join(__dirname, "..", "api")).filter((f) => f.endsWith(".js") && !f.startsWith("_"));
  assert.equal(fns.length, 12, fns.join(", "));
  assert.ok(!fns.includes("check.js"));
});

test("parseSource: GitHub repo, tree ref, raw base, and an index host; http, query strings and odd GitHub URLs refused", () => {
  assert.equal(auditStatus.parseSource(SRC).listUrl, SRC_TREE);
  assert.equal(auditStatus.parseSource(`${SRC}/tree/audits`).rawBase, "https://raw.githubusercontent.com/stranger/checks/audits");
  assert.equal(auditStatus.parseSource("https://raw.githubusercontent.com/stranger/checks/v1").listUrl, "https://api.github.com/repos/stranger/checks/git/trees/v1?recursive=1");
  assert.equal(auditStatus.parseSource("https://checks.example.org/arcaeon/").listUrl, "https://checks.example.org/arcaeon/checks/INDEX.json");
  for (const bad of ["http://checks.example.org", "https://x.example.org/?a=1", "https://u:p@x.example.org", "https://github.com/stranger", "not a url", `${SRC}/tree/../x`]) {
    assert.equal(auditStatus.parseSource(bad).invalid, true, bad);
  }
});

test("SOURCES: a stranger's fresh VERIFIED fetched by URL makes the namespace CHECKED, no PR, nothing written", async () => {
  gh.seed(REPO, "checks/OPERATOR_KEYS.json", { keys: [{ key: ours.keyId }] });
  const src = mockSource(filesOf(check(stranger, "acme-prod", "VERIFIED", 2 * 86400 + 5)));
  const audit = await gather(["acme-prod", "velouria-demo"], src);
  const d = audit.byNs["acme-prod"];
  assert.equal(d.partial, false);
  assert.equal(d.state, "CHECKED");
  assert.equal(d.source_records, 1);
  assert.equal(audit.byNs["velouria-demo"].state, "BLIND");
  assert.equal(gh.putLog.length, 0, "a source read writes nothing to the store");
  assert.ok(auditStatus.renderAuditCell(d).includes("1 record read from outside check sources, judged by key like any other"));
  assert.deepEqual(audit.sources.map((s) => [s.url, s.status, s.listed, s.read]), [[SRC, "read", 1, 1]]);
});

test("SOURCES NEVER UPGRADE: our own key's record from a URL is SELF-CHECKED; with no OPERATOR_KEYS a stranger's is too", async () => {
  gh.seed(REPO, "checks/OPERATOR_KEYS.json", { keys: [{ key: ours.keyId }] });
  let audit = await gather(["acme-prod"], mockSource(filesOf(check(ours, "acme-prod", "VERIFIED", 3600))));
  assert.equal(audit.byNs["acme-prod"].state, "SELF-CHECKED", "the location does not launder our key");

  gh = new MockGitHubStore(); restore(); restore = install(gh);
  audit = await gather(["acme-prod"], mockSource(filesOf(check(stranger, "acme-prod", "VERIFIED", 3600))));
  assert.equal(audit.byNs["acme-prod"].state, "SELF-CHECKED", "an undeclared key set is not evidence of independence");
});

test("SOURCES: a tampered, misfiled, or unparseable source file is never folded in; a source BROKEN goes red", async () => {
  gh.seed(REPO, "checks/OPERATOR_KEYS.json", { keys: [{ key: ours.keyId }] });
  const tampered = check(stranger, "acme-prod", "VERIFIED", 3600); tampered.result = "VERIFIED"; tampered.detail += "!";
  const misfiled = check(stranger, "velouria-demo", "VERIFIED", 3600);
  const files = filesOf(tampered);
  files["checks/pin/acme-prod/misfiled-aaaaaaaa.json"] = misfiled;
  files["checks/pin/acme-prod/junk-bbbbbbbb.json"] = "{not json";
  let audit = await gather(["acme-prod", "velouria-demo"], mockSource(files));
  assert.equal(audit.byNs["acme-prod"].state, "BLIND");
  assert.equal(audit.byNs["acme-prod"].counts.unverifiable, 1);
  assert.equal(audit.byNs["acme-prod"].source_ignored, 2);
  assert.equal(audit.byNs["velouria-demo"].state, "BLIND", "misfiled is evidence for neither");

  audit = await gather(["acme-prod"], mockSource(filesOf(check(stranger, "acme-prod", "BROKEN", 3600))));
  assert.equal(audit.byNs["acme-prod"].state, "BROKEN");
});

test("SOURCES: the same signed record in the repo and at a URL counts once", async () => {
  gh.seed(REPO, "checks/OPERATOR_KEYS.json", { keys: [{ key: ours.keyId }] });
  const rec = check(stranger, "acme-prod", "VERIFIED", 3600);
  gh.seed(REPO, cr.checkRecordPath(rec), rec);
  const audit = await gather(["acme-prod"], mockSource(filesOf(rec)));
  assert.equal(audit.byNs["acme-prod"].counts.records, 1);
  assert.equal(audit.byNs["acme-prod"].state, "CHECKED");
});

test("SOURCES FAIL CLOSED: an unlistable, truncated, or refused source leaves EVERY namespace NOT FULLY READ", async () => {
  gh.seed(REPO, "checks/OPERATOR_KEYS.json", { keys: [{ key: ours.keyId }] });
  gh.seed(REPO, "x", {});
  const good = check(stranger, "acme-prod", "VERIFIED", 3600);
  gh.seed(REPO, cr.checkRecordPath(good), good);
  for (const [label, src, env] of [
    ["500 listing", mockSource({}, { treeStatus: 500 }), {}],
    ["truncated", mockSource({}, { truncated: true }), {}],
    ["http source", mockSource({}), { WITNESS_CHECK_SOURCES: "http://checks.example.org" }],
  ]) {
    const audit = await gather(["acme-prod", "velouria-demo"], src, { env });
    for (const ns of ["acme-prod", "velouria-demo"]) {
      assert.equal(audit.byNs[ns].partial, true, `${label}: ${ns}`);
      assert.ok(auditStatus.renderAuditCell(audit.byNs[ns]).includes("NOT FULLY READ"), label);
      assert.ok(!auditStatus.renderAuditCell(audit.byNs[ns]).includes("UNALTERED"), label);
    }
    assert.ok(audit.notes.some((n) => /could not be listed|was refused/.test(n)), label);
  }
});

test("SOURCES BUDGET: records past the fetch budget leave their namespace NOT FULLY READ; others still derive", async () => {
  gh.seed(REPO, "checks/OPERATOR_KEYS.json", { keys: [{ key: ours.keyId }] });
  const recs = [];
  for (let i = 0; i < 5; i++) recs.push(check(stranger, "acme-prod", "VERIFIED", 3600 + i * 60));
  const src = mockSource(filesOf(...recs));
  // budget 3 = 1 listing + 2 records; three acme-prod records go unread.
  const audit = await gather(["acme-prod", "velouria-demo"], src, { opts: { maxSourceFetches: 3 } });
  assert.equal(audit.byNs["acme-prod"].partial, true);
  assert.equal(audit.byNs["velouria-demo"].partial, false, "a namespace the source holds nothing about is not starved");
  assert.equal(audit.sourceFetchesUsed, 3);
  assert.equal(src.log.length, 3, "no fetch past the budget");
  assert.equal(audit.sources[0].status, "partly read: fetch budget spent");
  // A budget that fits: derived, CHECKED.
  const full = await gather(["acme-prod"], mockSource(filesOf(...recs)), { opts: { maxSourceFetches: 6 } });
  assert.equal(full.byNs["acme-prod"].state, "CHECKED");
});

test("BREAK ARM SOURCES BUDGET: deriving over the records that WERE read would hide a BROKEN listed last", async () => {
  gh.seed(REPO, "checks/OPERATOR_KEYS.json", { keys: [{ key: ours.keyId }] });
  const v = check(stranger, "acme-prod", "VERIFIED", 3600, { checked_at: "2026-09-01T00:00:00Z" });
  const b = check(stranger, "acme-prod", "BROKEN", 3600, { checked_at: "2026-09-02T00:00:00Z" });
  // Path order puts the VERIFIED first, the BROKEN second.
  const nowSept = Math.floor(Date.parse("2026-09-05T00:00:00Z") / 1000);
  const src = mockSource(filesOf(v, b));
  const partialRead = await auditStatus.gatherAuditStates(["acme-prod"], {
    nowSeconds: nowSept, env: { WITNESS_CHECK_SOURCES: SRC }, fetchImpl: src.fetchImpl, maxSourceFetches: 2,
  });
  assert.equal(partialRead.byNs["acme-prod"].partial, true);
  // What a reader without the partial fence would have shown: CHECKED.
  assert.equal(deriveAuditState([v], { ownKeys: new Set([ours.keyId]), nowSeconds: nowSept }).state, "CHECKED");
  assert.equal(deriveAuditState([v, b], { ownKeys: new Set([ours.keyId]), nowSeconds: nowSept }).state, "BROKEN");
});

test("SOURCES: an oversized body is refused (namespace NOT FULLY READ); only listed namespaces we carry are fetched", async () => {
  gh.seed(REPO, "checks/OPERATOR_KEYS.json", { keys: [{ key: ours.keyId }] });
  const rec = check(stranger, "acme-prod", "VERIFIED", 3600);
  const files = filesOf(rec);
  files[cr.checkRecordPath(rec)] = JSON.stringify(rec) + " ".repeat(auditStatus.MAX_SOURCE_BYTES);
  files["checks/pin/not-ours/2026-09-22T00-00-00Z-cccccccc.json"] = {};
  const src = mockSource(files);
  const audit = await gather(["acme-prod"], src);
  assert.equal(audit.byNs["acme-prod"].partial, true);
  assert.ok(!src.log.some((l) => l.url.includes("not-ours")), "a namespace we do not carry is never fetched");
});

test("SOURCES: a STREAMED body is cut off at the byte cap instead of being buffered whole", async () => {
  gh.seed(REPO, "checks/OPERATOR_KEYS.json", { keys: [{ key: ours.keyId }] });
  const rec = check(stranger, "acme-prod", "VERIFIED", 3600);
  const recPath = cr.checkRecordPath(rec);
  let chunksServed = 0;
  const fetchImpl = async (url) => {
    if (url === SRC_TREE) {
      return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ tree: [{ path: recPath, type: "blob" }] }) };
    }
    // An endless stream of 16 KiB chunks, no content-length.
    return { ok: true, status: 200, headers: { get: () => null }, body: { getReader: () => ({
      read: async () => { chunksServed += 1; return { done: false, value: new Uint8Array(16 * 1024) }; },
      cancel: async () => {},
    }) } };
  };
  const audit = await auditStatus.gatherAuditStates(["acme-prod"], { nowSeconds: NOW, env: { WITNESS_CHECK_SOURCES: SRC }, fetchImpl });
  assert.equal(audit.byNs["acme-prod"].partial, true);
  assert.ok(chunksServed <= auditStatus.MAX_SOURCE_BYTES / (16 * 1024) + 1, `read ${chunksServed} chunks`);
});

test("SOURCES: the pin token never goes to a source; redirects are refused; the source token is its own env var", async () => {
  gh.seed(REPO, "checks/OPERATOR_KEYS.json", { keys: [{ key: ours.keyId }] });
  const src = mockSource(filesOf(check(stranger, "acme-prod", "VERIFIED", 3600)));
  await gather(["acme-prod"], src);
  for (const l of src.log) {
    assert.equal(l.opts.redirect, "error", l.url);
    assert.ok(!JSON.stringify(l.opts.headers || {}).includes(process.env.GITHUB_PIN_TOKEN), `pin token sent to ${l.url}`);
    assert.equal((l.opts.headers || {}).authorization, undefined);
  }
  const src2 = mockSource({});
  await gather(["acme-prod"], src2, { env: { WITNESS_CHECK_SOURCES_TOKEN: "read-only-tok" } });
  assert.equal(src2.log[0].opts.headers.authorization, "Bearer read-only-tok");
});

test("SOURCES: an index-file host is read through checks/INDEX.json", async () => {
  gh.seed(REPO, "checks/OPERATOR_KEYS.json", { keys: [{ key: ours.keyId }] });
  const rec = check(stranger, "acme-prod", "VERIFIED", 3600);
  const base = "https://checks.example.org/arcaeon";
  const fetchImpl = async (url) => {
    const ok = (t) => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => t });
    if (url === `${base}/checks/INDEX.json`) return ok(JSON.stringify({ paths: [cr.checkRecordPath(rec)] }));
    if (url === `${base}/${cr.checkRecordPath(rec)}`) return ok(JSON.stringify(rec));
    return { ok: false, status: 404 };
  };
  const audit = await auditStatus.gatherAuditStates(["acme-prod"], { nowSeconds: NOW, env: { WITNESS_CHECK_SOURCES: base }, fetchImpl });
  assert.equal(audit.byNs["acme-prod"].state, "CHECKED");
});

test("SOURCES: with no sources configured nothing is fetched and slice-1 behaviour is unchanged", async () => {
  const log = [];
  const audit = await auditStatus.gatherAuditStates(["acme-prod"], { nowSeconds: NOW, env: {}, fetchImpl: async (u) => { log.push(u); return { ok: false, status: 500 }; } });
  assert.equal(log.length, 0);
  assert.equal(audit.byNs["acme-prod"].state, "BLIND");
  assert.equal(audit.byNs["acme-prod"].partial, false);
  assert.deepEqual(audit.sources, []);
});

// ===========================================================================
// 4. STATUS JSON TWIN
// ===========================================================================
function pin(ns, rows) {
  return { namespace: ns, rows, chain: "cafebabe", seq: 1, pinned_at: new Date().toISOString(),
           cadence_hours: 24, next_pin_due_by: new Date(Date.now() + 3600e3).toISOString() };
}
async function renderJson() {
  const res = makeRes();
  await statusHandler(makeReq({ method: "GET", query: { format: "json" } }), res);
  assert.equal(res._status, 200);
  return res._body;
}
function seedPins() {
  gh.seed(REPO, "pins/velouria-demo/latest.json", pin("velouria-demo", 12));
  gh.seed(REPO, "pins/acme-prod/latest.json", pin("acme-prod", 40));
}

test("JSON FLAG OFF: no audit key anywhere, and no check path is read", async () => {
  seedPins();
  gh.seed(REPO, "checks/OPERATOR_KEYS.json", { keys: [{ key: ours.keyId }] });
  const body = await renderJson();
  assert.equal("audit" in body, false);
  for (const n of body.namespaces) assert.equal("audit" in n, false, n.namespace);
  assert.ok(!gh.getLog.some((p) => String(p).includes("checks/")), "flag off must not read checks/");
});

test("JSON FLAG ON: every namespace carries its audit state; the summary counts BLIND first; CHECKED from a source", async () => {
  process.env.WITNESS_AUDIT_STATE = "1";
  seedPins();
  gh.seed(REPO, "checks/OPERATOR_KEYS.json", { keys: [{ key: ours.keyId }] });
  const own = check(ours, "velouria-demo", "VERIFIED", 3600);
  gh.seed(REPO, cr.checkRecordPath(own), own);
  // The stranger's record reaches the JSON through a source URL: route it
  // around the mock store's fetch.
  const src = mockSource(filesOf(check(stranger, "acme-prod", "VERIFIED", 86400 + 5)));
  const storeFetch = global.fetch;
  global.fetch = (url, opts) => (String(url).startsWith(SRC_TREE) || String(url).startsWith(SRC_RAW) ? src.fetchImpl(url, opts) : storeFetch(url, opts));
  process.env.WITNESS_CHECK_SOURCES = SRC;
  const body = await renderJson();
  const by = Object.fromEntries(body.namespaces.map((n) => [n.namespace, n.audit]));
  assert.equal(by["velouria-demo"].state, "SELF-CHECKED");
  assert.equal(by["velouria-demo"].badge, "SELF-CHECKED");
  assert.equal(by["acme-prod"].state, "CHECKED");
  assert.equal(by["acme-prod"].badge, "UNALTERED, checked 1 days ago");
  assert.equal(by["acme-prod"].source_records, 1);
  assert.equal(body.audit.enabled, true);
  assert.deepEqual(Object.keys(body.audit.counts).slice(0, 2), ["blind", "self_checked"]);
  assert.equal(body.audit.counts.checked, 1);
  assert.equal(body.audit.counts.self_checked, 1);
  assert.equal(body.audit.headline, "1 of 2 namespaces checked by a key not declared as ours.");
  assert.equal(body.audit.sources[0].url, SRC);
});

test("JSON FLAG ON: a NOT FULLY READ namespace carries no state word at all", async () => {
  process.env.WITNESS_AUDIT_STATE = "1";
  seedPins();
  gh.seed(REPO, "checks/OPERATOR_KEYS.json", { keys: [{ key: ours.keyId }] });
  process.env.WITNESS_CHECK_SOURCES = "http://not-https.example.org";
  const body = await renderJson();
  for (const n of body.namespaces) {
    assert.equal(n.audit.state, "NOT_FULLY_READ", n.namespace);
    for (const w of ["BLIND", "SELF-CHECKED", "CHECKED", "STALE", "BROKEN", "UNALTERED"]) {
      assert.ok(!JSON.stringify(n.audit).includes(`"${w}`), `${n.namespace} leaks ${w}`);
    }
  }
  assert.equal(body.audit.counts.not_fully_read, 2);
  assert.equal(body.audit.counts.derived, 0);
});

test("BREAK ARM JSON: the twin and the page agree row for row (both read gatherAuditStates)", async () => {
  process.env.WITNESS_AUDIT_STATE = "1";
  seedPins();
  gh.seed(REPO, "checks/OPERATOR_KEYS.json", { keys: [{ key: ours.keyId }] });
  const b = check(stranger, "acme-prod", "BROKEN", 3600, { rerun: "py verify.py Q" });
  gh.seed(REPO, cr.checkRecordPath(b), b);
  const body = await renderJson();
  const res = makeRes();
  await statusHandler(makeReq({ method: "GET", query: {} }), res);
  const html = String(res._body);
  const acme = body.namespaces.find((n) => n.namespace === "acme-prod").audit;
  assert.equal(acme.state, "BROKEN");
  assert.ok(html.includes(acme.line.replace(/'/g, "&#39;")), "the JSON line is the page's line");
  assert.equal(acme.broken_evidence.rerun, "py verify.py Q");
});
