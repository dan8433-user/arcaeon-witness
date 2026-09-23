// test/publish_self_checks.test.js — tools/publish_self_checks.js: record
// shape validation (every refusal names its reason), the dry run (exact
// paths and bytes, no token, no network), idempotence against a fake
// contents API (a second run with the same records makes no PUT), the
// create-only conflict refusal, the published-declaration fence, and the
// BREAK ARM: a record with a bad signature is refused before anything is
// sent. The last test feeds what the stub received into the status page's
// reader (lib/_audit_status.js), because the reader is the contract.
"use strict";

process.env.GITHUB_PIN_REPO = "test-owner/test-pins";
process.env.GITHUB_PIN_BRANCH = "main";
process.env.GITHUB_PIN_TOKEN = "test-token";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const cr = require("../lib/_check_record.js");
const { unsignedRecord } = require("./helpers/check_fixtures.js");
const pub = require("../tools/publish_self_checks.js");

const ours = cr.generateKeyPair();
const stranger = cr.generateKeyPair();
const DAY = "2026-09-23";
const AT = `${DAY}T13:40:45Z`;
const NOW = `${DAY}T14:00:00Z`;
const NOW_S = Math.floor(Date.parse(NOW) / 1000);

function selfCheck(ns, result = "VERIFIED", keyPair = ours, over = {}) {
  return cr.signCheckRecord(unsignedRecord({
    target: { type: "pin", ref: `pins/${ns}/00000004.json` },
    inputs: [{ url: `https://raw.githubusercontent.com/o/r/main/pins/${ns}/00000004.json`, sha256: "ab".repeat(32) }],
    result, checked_at: AT,
    checker: { name: "arcaeon operator daily self-check", binding_url: "https://github.com/o/r/blob/main/checks/OPERATOR_KEYS.json" },
    ...over,
  }), keyPair.privateKey);
}

// Lay records out the way tools/self_check_daily.js --write does.
function outDir(records, { raw = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pubsc-"));
  for (const rec of records) {
    const dest = path.join(dir, cr.checkRecordPath(rec));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, JSON.stringify(rec, null, 1) + "\n");
  }
  for (const [rel, bytes] of Object.entries(raw)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), bytes);
  }
  const keys = path.join(dir, "OPERATOR_KEYS.json");
  fs.writeFileSync(keys, JSON.stringify({ keys: [{ key: ours.keyId, name: "self-check" }] }));
  return { dir, keys };
}

// A fake GitHub contents API: path -> bytes. Records every call.
function fakeContents({ published = new Map([[pub.OPERATOR_KEYS_REL, Buffer.from(JSON.stringify({ keys: [{ key: ours.keyId }] }))]]), putStatus = 201 } = {}) {
  const files = new Map(published);
  const calls = [];
  let commitN = 0;
  const ghImpl = async (method, url, tok, body) => {
    calls.push({ method, url, tok, body });
    assert.equal(tok, "stub-token");
    const rel = decodeURIComponent(url.replace(`${pub.API}/contents/`, "").replace(/\?ref=main$/, ""));
    if (method === "GET") {
      if (!files.has(rel)) return { status: 404, body: { message: "Not Found" } };
      const b = files.get(rel);
      return { status: 200, body: { sha: pub.gitBlobSha(b), content: b.toString("base64") } };
    }
    if (method === "PUT") {
      assert.equal(body.branch, "main");
      if (files.has(rel)) return { status: 422, body: { message: "sha wasn't supplied" } };
      if (putStatus !== 201) return { status: putStatus, body: { message: "boom" } };
      files.set(rel, Buffer.from(body.content, "base64"));
      commitN += 1;
      return { status: 201, body: { commit: { sha: `c${commitN}` } } };
    }
    throw new Error(`unexpected ${method}`);
  };
  return { files, calls, ghImpl, puts: () => calls.filter((c) => c.method === "PUT") };
}

function io() {
  const o = { out: "", err: "" };
  return { o, w: { out: (s) => { o.out += s; }, err: (s) => { o.err += s; } } };
}
const base = (d) => ["--dir", d.dir, "--operator-keys", d.keys, "--date", DAY, "--now", NOW];

// ---------------------------------------------------------------- shape
test("validateRecordFile: a well-formed self-check at its own path passes", () => {
  const rec = selfCheck("acme-prod");
  const r = pub.validateRecordFile({ rel: cr.checkRecordPath(rec), bytes: Buffer.from(JSON.stringify(rec)) }, { ownKeys: new Set([ours.keyId]), nowSeconds: NOW_S });
  assert.equal(r.ok, true, JSON.stringify(r));
});

test("validateRecordFile: each defect is refused with its own reason", () => {
  const own = { ownKeys: new Set([ours.keyId]), nowSeconds: NOW_S };
  const rec = selfCheck("acme-prod");
  const rel = cr.checkRecordPath(rec);
  const cases = [
    ["not_json", rel, Buffer.from("{not json")],
    ["byte_order_mark", rel, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify(rec))])],
    ["unsigned", rel, Buffer.from(JSON.stringify({ ...rec, sig: "" }))],
    ["unknown_field", rel, Buffer.from(JSON.stringify({ ...rec, extra: 1 }))],
    ["malformed_field", rel, Buffer.from(JSON.stringify({ ...rec, result: "FINE" }))],
    ["input_not_public", rel, Buffer.from(JSON.stringify({ ...rec, inputs: [{ url: "file:///c/x", sha256: "ab".repeat(32) }] }))],
    ["path_mismatch", "checks/pin/other-ns/" + path.posix.basename(rel), Buffer.from(JSON.stringify(rec))],
  ];
  for (const [reason, r, bytes] of cases) {
    const got = pub.validateRecordFile({ rel: r, bytes }, own);
    assert.equal(got.ok, false, reason);
    assert.equal(got.reason, reason, `${reason}: ${JSON.stringify(got)}`);
  }
  const future = selfCheck("acme-prod", "VERIFIED", ours, { checked_at: `${DAY}T23:00:00Z` });
  assert.equal(pub.validateRecordFile({ rel: cr.checkRecordPath(future), bytes: Buffer.from(JSON.stringify(future)) }, own).reason, "future_dated");
  const theirs = selfCheck("acme-prod", "VERIFIED", stranger);
  assert.equal(pub.validateRecordFile({ rel: cr.checkRecordPath(theirs), bytes: Buffer.from(JSON.stringify(theirs)) }, own).reason, "key_not_declared");
});

test("D22 pre-flight: a file whose name-result disagrees with its signed body is refused as path_result_mismatch, and the run publishes nothing", async () => {
  const own = { ownKeys: new Set([ours.keyId]), nowSeconds: NOW_S };
  const broken = selfCheck("acme-prod", "BROKEN");
  const asGreen = cr.checkRecordPath(broken).replace(/-broken\.json$/, "-verified.json");
  const r1 = pub.validateRecordFile({ rel: asGreen, bytes: Buffer.from(JSON.stringify(broken)) }, own);
  assert.equal(r1.reason, "path_result_mismatch", JSON.stringify(r1));
  assert.match(r1.field, /name says VERIFIED, record says BROKEN/);
  const green = selfCheck("acme-prod", "VERIFIED");
  const asRed = cr.checkRecordPath(green).replace(/-verified\.json$/, "-broken.json");
  assert.equal(pub.validateRecordFile({ rel: asRed, bytes: Buffer.from(JSON.stringify(green)) }, own).reason, "path_result_mismatch");
  // Through the CLI: one mismatched file refuses the whole day.
  const d = outDir([green], { raw: { [asGreen]: JSON.stringify(broken) } });
  const { o, w } = io();
  assert.equal(await pub.main([...base(d), "--dry-run"], w), 2);
  assert.ok(o.err.includes(`REFUSED  ${asGreen}  path_result_mismatch`), o.err);
  assert.ok(!o.out.includes("WOULD PUT"), "nothing is listed to publish");
});

test("collectRecords takes only the asked days, in path order", () => {
  const a = selfCheck("b-ns");
  const b = selfCheck("a-ns");
  const old = selfCheck("a-ns", "VERIFIED", ours, { checked_at: "2026-09-20T10:00:00Z" });
  const d = outDir([a, b, old]);
  assert.deepEqual(pub.collectRecords(d.dir, [DAY]).map((f) => f.rel), [cr.checkRecordPath(b), cr.checkRecordPath(a)]);
  assert.equal(pub.collectRecords(d.dir, pub.datesFor(DAY, 4)).length, 3);
  assert.deepEqual(pub.datesFor(DAY, 3), ["2026-09-23", "2026-09-22", "2026-09-21"]);
});

// ---------------------------------------------------------------- dry run
test("dry run prints every path with the exact bytes and never reads a token or calls the network", async () => {
  const recs = [selfCheck("acme-prod"), selfCheck("velouria-selftest", "BROKEN")];
  const d = outDir(recs);
  const stub = fakeContents();
  let tokenRead = false;
  const { o, w } = io();
  const origFetch = global.fetch;
  global.fetch = () => { throw new Error("network touched"); };
  try {
    const code = await pub.main([...base(d), "--dry-run", "--show-bytes"], w, { ghImpl: stub.ghImpl, token: () => { tokenRead = true; return "stub-token"; } });
    assert.equal(code, 0, o.err);
  } finally {
    global.fetch = origFetch;
  }
  assert.equal(stub.calls.length, 0);
  assert.equal(tokenRead, false);
  for (const rec of recs) {
    const rel = cr.checkRecordPath(rec);
    const bytes = fs.readFileSync(path.join(d.dir, rel));
    assert.match(o.out, new RegExp(`WOULD PUT  main:${rel.replace(/[.]/g, "\\.")}  ${bytes.length} bytes  sha256 ${pub.sha256hex(bytes)}  blob ${pub.gitBlobSha(bytes)}  ${rec.result}`));
    assert.ok(o.out.includes(bytes.toString("utf-8")), "the exact bytes are printed");
  }
  assert.match(o.err, /dry run: 2 record\(s\) for 2026-09-23, \d+ bytes.*No token read, no network\./);
});

test("exactly one of --dry-run / --publish, and no records for the day is exit 2", async () => {
  const d = outDir([selfCheck("acme-prod")]);
  await assert.rejects(pub.main(base(d), io().w), /exactly one of --dry-run or --publish/);
  await assert.rejects(pub.main([...base(d), "--dry-run", "--publish"], io().w), /exactly one/);
  const { o, w } = io();
  assert.equal(await pub.main([...base(d).slice(0, 4), "--date", "2026-09-01", "--now", NOW, "--dry-run"], w), 2);
  assert.match(o.err, /no self-check records for 2026-09-01/);
});

// ---------------------------------------------------------------- live, against the stub
test("publish creates each record once; a second run with the same records makes no commit", async () => {
  const recs = ["acme-prod", "beta-ns", "velouria-selftest"].map((ns, i) => selfCheck(ns, i === 2 ? "BROKEN" : "VERIFIED"));
  const d = outDir(recs);
  const stub = fakeContents();
  const deps = { ghImpl: stub.ghImpl, token: () => "stub-token" };

  const first = io();
  assert.equal(await pub.main([...base(d), "--publish"], first.w, deps), 0, first.o.err);
  assert.equal(stub.puts().length, 3);
  for (const rec of recs) {
    const rel = cr.checkRecordPath(rec);
    assert.ok(stub.files.get(rel).equals(fs.readFileSync(path.join(d.dir, rel))), "published bytes are the written bytes");
  }
  assert.match(stub.puts()[0].body.message, /^checks: VERIFIED acme-prod \(self-check 2026-09-23T13:40:45Z, key [0-9a-f]{8}\)$/);
  // every GET came before the first PUT
  const firstPut = stub.calls.findIndex((c) => c.method === "PUT");
  assert.equal(stub.calls.slice(firstPut).filter((c) => c.method === "GET").length, 0);
  assert.match(first.o.err, /3 created, 0 already published/);

  const second = io();
  assert.equal(await pub.main([...base(d), "--publish"], second.w, deps), 0);
  assert.equal(stub.puts().length, 3, "no new PUT on the second run");
  assert.match(second.o.err, /0 created, 3 already published/);
});

test("a run that died mid-way resumes: only the missing record is PUT", async () => {
  const recs = [selfCheck("acme-prod"), selfCheck("beta-ns")];
  const d = outDir(recs);
  const rel0 = cr.checkRecordPath(recs[0]);
  const stub = fakeContents();
  stub.files.set(rel0, fs.readFileSync(path.join(d.dir, rel0)));
  const { o, w } = io();
  assert.equal(await pub.main([...base(d), "--publish"], w, { ghImpl: stub.ghImpl, token: () => "stub-token" }), 0);
  assert.deepEqual(stub.puts().map((c) => c.url), [`${pub.API}/contents/${cr.checkRecordPath(recs[1])}`]);
  assert.match(o.out, new RegExp(`ALREADY    ${rel0.replace(/[.]/g, "\\.")}`));
});

test("create-only: a path already there with different bytes refuses the whole run before any PUT", async () => {
  const recs = [selfCheck("acme-prod"), selfCheck("beta-ns")];
  const d = outDir(recs);
  const stub = fakeContents();
  stub.files.set(cr.checkRecordPath(recs[1]), Buffer.from("{\"someone\":\"else\"}\n"));
  const { o, w } = io();
  assert.equal(await pub.main([...base(d), "--publish"], w, { ghImpl: stub.ghImpl, token: () => "stub-token" }), 2);
  assert.equal(stub.puts().length, 0);
  assert.match(o.err, /^REFUSED: .*already exists in the pins repo with different bytes/m);
});

test("the published declaration is a fence: absent, or missing the key, refuses before any record GET or PUT", async () => {
  const d = outDir([selfCheck("acme-prod")]);
  const absent = fakeContents({ published: new Map() });
  const a = io();
  assert.equal(await pub.main([...base(d), "--publish"], a.w, { ghImpl: absent.ghImpl, token: () => "stub-token" }), 2);
  assert.equal(absent.calls.length, 1);
  assert.match(a.o.err, /OPERATOR_KEYS\.json is not published/);

  const other = fakeContents({ published: new Map([[pub.OPERATOR_KEYS_REL, Buffer.from(JSON.stringify({ keys: [{ key: stranger.keyId }] }))]]) });
  const b = io();
  assert.equal(await pub.main([...base(d), "--publish"], b.w, { ghImpl: other.ghImpl, token: () => "stub-token" }), 2);
  assert.equal(other.puts().length, 0);
  assert.match(b.o.err, /would read as an outside check/);
});

test("a failed PUT is reported with what was already committed, exit 2", async () => {
  const d = outDir([selfCheck("acme-prod")]);
  const stub = fakeContents({ putStatus: 500 });
  const { o, w } = io();
  assert.equal(await pub.main([...base(d), "--publish"], w, { ghImpl: stub.ghImpl, token: () => "stub-token" }), 2);
  assert.match(o.err, /^ERROR: PUT checks\/pin\/acme-prod\/.* -> 500/m);
});

// ---------------------------------------------------------------- BREAK ARM
test("BREAK ARM: a record with a bad signature is refused before publish (no token, no GET, no PUT; the good ones wait too)", async () => {
  const good = selfCheck("acme-prod");
  const tampered = selfCheck("velouria-selftest", "BROKEN");
  tampered.result = "VERIFIED"; // flipped after signing: the sig no longer covers it
  const d = outDir([good, tampered]);
  const stub = fakeContents();
  let tokenRead = false;
  for (const mode of ["--dry-run", "--publish"]) {
    const { o, w } = io();
    const code = await pub.main([...base(d), mode], w, { ghImpl: stub.ghImpl, token: () => { tokenRead = true; return "stub-token"; } });
    assert.equal(code, 2, mode);
    assert.match(o.err, new RegExp(`REFUSED  ${cr.checkRecordPath(tampered).replace(/[.]/g, "\\.")}  bad_signature \\(sig\\)`));
    assert.match(o.err, /1 record\(s\) for 2026-09-23 failed validation; nothing published\./);
    assert.equal(o.out, "", mode);
  }
  assert.equal(stub.calls.length, 0);
  assert.equal(tokenRead, false);
});

// ---------------------------------------------------------------- the reader is the contract
test("what the publisher PUTs is what the status page reads: the namespace moves BLIND -> SELF-CHECKED", async () => {
  const { MockGitHubStore, install } = require("./helpers/mock_store.js");
  const auditStatus = require("../lib/_audit_status.js");
  const recs = [selfCheck("acme-prod"), selfCheck("velouria-selftest", "BROKEN")];
  const d = outDir(recs);
  const stub = fakeContents();
  assert.equal(await pub.main([...base(d), "--publish"], io().w, { ghImpl: stub.ghImpl, token: () => "stub-token" }), 0);

  const store = new MockGitHubStore();
  const restore = install(store);
  try {
    const repo = process.env.GITHUB_PIN_REPO;
    store.seed(repo, "checks/OPERATOR_KEYS.json", { keys: [{ key: ours.keyId }] });
    const before = await auditStatus.gatherAuditStates(["acme-prod", "velouria-selftest"], { nowSeconds: NOW_S, env: {} });
    assert.equal(before.byNs["acme-prod"].state, "BLIND");
    for (const [rel, bytes] of stub.files) {
      if (rel === pub.OPERATOR_KEYS_REL) continue;
      // lib/_audit_status.js CHECK_PATH (not exported), copied verbatim.
      assert.match(rel, /^checks\/(pin|observation)\/([^/]+)\/[^/]+\.json$/);
      store.seed(repo, rel, JSON.parse(bytes.toString("utf-8")));
    }
    const after = await auditStatus.gatherAuditStates(["acme-prod", "velouria-selftest"], { nowSeconds: NOW_S, env: {} });
    assert.equal(after.byNs["acme-prod"].state, "SELF-CHECKED");
    assert.equal(after.byNs["velouria-selftest"].state, "BROKEN");
    assert.equal(after.byNs["acme-prod"].records_listed, 1);
  } finally {
    restore();
  }
});
