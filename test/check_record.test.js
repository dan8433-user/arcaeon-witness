// test/check_record.test.js — the signed check record (lib/_check_record.js).
//
// Refusal-shaped: unsigned, malformed, tampered, future-dated, non-public
// input, non-canonical key id — every one must be refused with a named
// reason. The field-mutation test is the design page's B4 rule made
// executable: flip each field in turn and the signature must fail. The
// break arm runs the same mutations against a verifier that always says
// ok:true and asserts every case goes red.
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const cr = require("../lib/_check_record.js");
const { unsignedRecord, signed, HEX64 } = require("./helpers/check_fixtures.js");

const NOW = Math.floor(Date.parse("2026-09-22T15:00:00Z") / 1000);
const kp = cr.generateKeyPair();
const clone = (o) => JSON.parse(JSON.stringify(o));

test("a well-formed record signs, verifies, and names its key", () => {
  const rec = signed(kp);
  const v = cr.verifyCheckRecord(rec, { nowSeconds: NOW });
  assert.equal(v.ok, true, JSON.stringify(v));
  assert.equal(v.key_id, kp.keyId);
  assert.equal(rec.checker.key, kp.keyId);
  assert.match(kp.keyId, /^ed25519:[A-Za-z0-9+/]{43}=$/);
});

test("REFUSE: unsigned, empty sig, not an object", () => {
  const rec = signed(kp);
  const unsigned = clone(rec); delete unsigned.sig;
  assert.equal(cr.verifyCheckRecord(unsigned, { nowSeconds: NOW }).reason, "unsigned");
  assert.equal(cr.verifyCheckRecord({ ...rec, sig: "" }, { nowSeconds: NOW }).reason, "unsigned");
  assert.equal(cr.verifyCheckRecord(null, { nowSeconds: NOW }).reason, "not_an_object");
  assert.equal(cr.verifyCheckRecord("x", { nowSeconds: NOW }).reason, "not_an_object");
  assert.equal(cr.verifyCheckRecord([rec], { nowSeconds: NOW }).reason, "not_an_object");
});

// Every top-level field, mutated one at a time. Each must break the signature
// (or be refused as malformed before the signature is even checked — either
// way, ok !== true). This is the /vow preimage lesson applied before shipping.
const MUTATIONS = [
  ["kind", (r) => { r.kind = "checked"; }],
  ["v", (r) => { r.v = 2; }],
  ["target.type", (r) => { r.target.type = "observation"; }],
  ["target.ref", (r) => { r.target.ref = "pins/acme-prod/00000008.json"; }],
  ["target.digest", (r) => { r.target.digest = `sha256:${"cd".repeat(32)}`; }],
  ["claim_checked", (r) => { r.claim_checked = "inclusion"; }],
  ["inputs[0].url", (r) => { r.inputs[0].url += "?x"; }],
  ["inputs[0].sha256", (r) => { r.inputs[0].sha256 = "cd".repeat(32); }],
  ["inputs (append)", (r) => { r.inputs.push({ url: "https://example.org/x", sha256: HEX64 }); }],
  ["result", (r) => { r.result = "BROKEN"; }],
  ["detail", (r) => { r.detail += "."; }],
  ["checked_at", (r) => { r.checked_at = "2026-09-22T14:02:12Z"; }],
  ["checker.name", (r) => { r.checker.name = "operator"; }],
  ["checker.binding_url", (r) => { r.checker.binding_url = "https://example.org/other"; }],
  ["checker.key (another real key)", (r) => { r.checker.key = cr.generateKeyPair().keyId; }],
  ["tool.name", (r) => { r.tool.name = "other"; }],
  ["tool.version", (r) => { r.tool.version = "0.1.1"; }],
  ["tool.impl", (r) => { r.tool.impl = "reference"; }],
  ["tool.source_sha256", (r) => { r.tool.source_sha256 = "cd".repeat(32); }],
  ["trust_dependencies", (r) => { r.trust_dependencies.push("example.org"); }],
  ["rerun", (r) => { r.rerun += " --x"; }],
  ["sig (flip a byte)", (r) => { const b = Buffer.from(r.sig, "base64"); b[0] ^= 1; r.sig = b.toString("base64"); }],
  ["sig (truncate)", (r) => { r.sig = Buffer.from(r.sig, "base64").subarray(0, 63).toString("base64"); }],
  ["unknown top-level field", (r) => { r.note = "harmless"; }],
  ["unknown nested field", (r) => { r.checker.extra = 1; }],
];

function runMutations(verify) {
  const survivors = [];
  for (const [name, mutate] of MUTATIONS) {
    const rec = clone(signed(kp));
    mutate(rec);
    const v = verify(rec, { nowSeconds: NOW });
    if (v.ok === true) survivors.push(name);
  }
  return survivors;
}

test("SIGNATURE COVERS EVERY FIELD: each mutation is refused", () => {
  assert.deepEqual(runMutations(cr.verifyCheckRecord), []);
});

test("BREAK ARM: every mutation goes RED against a verifier that always returns ok:true", () => {
  const liar = () => ({ ok: true });
  const survivors = runMutations(liar);
  assert.equal(survivors.length, MUTATIONS.length, "the liar must be caught by every case");
});

test("REFUSE: future-dated beyond skew; accepted inside skew", () => {
  const ahead = (s) => new Date((NOW + s) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
  const far = signed(kp, { checked_at: ahead(301) });
  assert.equal(cr.verifyCheckRecord(far, { nowSeconds: NOW }).reason, "future_dated");
  const near = signed(kp, { checked_at: ahead(299) });
  assert.equal(cr.verifyCheckRecord(near, { nowSeconds: NOW }).ok, true);
  assert.equal(cr.verifyCheckRecord(near, { nowSeconds: NOW, skewSeconds: 0 }).reason, "future_dated");
});

test("REFUSE at sign time: malformed records never get a signature", () => {
  const cases = [
    ["input_not_public", { inputs: [{ url: "http://example.org/x", sha256: HEX64 }] }],
    ["input_not_public", { inputs: [{ url: "file:///C:/x.json", sha256: HEX64 }] }],
    ["malformed_field", { inputs: [] }],
    ["malformed_field", { target: { digest: HEX64 } }],
    ["malformed_field", { target: { digest: `sha256:${HEX64.toUpperCase()}` } }],
    ["malformed_field", { target: { ref: "../pins/x.json" } }],
    ["malformed_field", { target: { type: "namespace" } }],
    ["malformed_field", { result: "PASS" }],
    ["malformed_field", { checked_at: "2026-09-22 14:02:11" }],
    ["malformed_field", { checked_at: "2026-09-22T14:02:11+00:00" }],
    ["malformed_field", { tool: { impl: "ours" } }],
    ["malformed_field", { tool: { source_sha256: "abc" } }],
    ["malformed_field", { rerun: "" }],
    ["unknown_version", { v: 2 }],
    ["missing_field", { detail: undefined }],
  ];
  for (const [reason, over] of cases) {
    const u = unsignedRecord(over);
    if (over.detail === undefined && "detail" in over) delete u.detail;
    assert.throws(() => cr.signCheckRecord(u, kp.privateKey), (e) => e.reason === reason, `${reason} ${JSON.stringify(over)}`);
  }
});

test("REFUSE: a non-canonical or wrong-length key id, even with a valid signature shape", () => {
  const rec = clone(signed(kp));
  const raw = Buffer.from(rec.checker.key.slice("ed25519:".length), "base64");
  rec.checker.key = `ed25519:${raw.subarray(0, 31).toString("base64")}`;
  assert.equal(cr.verifyCheckRecord(rec, { nowSeconds: NOW }).reason, "bad_key_id");
  const rec2 = clone(signed(kp));
  rec2.checker.key = rec2.checker.key.replace(/=$/, "");
  assert.equal(cr.verifyCheckRecord(rec2, { nowSeconds: NOW }).reason, "bad_key_id");
  // 43 base64 chars carry 258 bits for a 256-bit key; the last two bits must
  // be zero or the id has two spellings. "A"*42+"B=" sets them, so it must
  // be refused even though it decodes to 32 bytes.
  assert.equal(cr.publicKeyFromId("ed25519:" + "A".repeat(42) + "B="), null, "non-canonical trailing bits must not round-trip");
  assert.equal(Buffer.from("A".repeat(42) + "B=", "base64").length, 32, "the case is a real 32-byte decode");
});

test("sign: refuses a checker.key that is not the signing key, and refuses to re-sign", () => {
  const other = cr.generateKeyPair();
  assert.throws(() => cr.signCheckRecord(unsignedRecord({ checker: { key: other.keyId } }), kp.privateKey), /does not match/);
  const rec = signed(kp);
  assert.throws(() => cr.signCheckRecord(rec, kp.privateKey), /already carries sig/);
});

test("canonicalization: field order does not matter, whitespace does not matter", () => {
  const rec = signed(kp);
  const reordered = {};
  for (const k of Object.keys(rec).reverse()) reordered[k] = rec[k];
  reordered.target = { digest: rec.target.digest, ref: rec.target.ref, type: rec.target.type };
  assert.equal(cr.verifyCheckRecord(reordered, { nowSeconds: NOW }).ok, true);
  assert.equal(cr.verifyCheckRecord(JSON.parse(JSON.stringify(rec, null, 4)), { nowSeconds: NOW }).ok, true);
  assert.equal(cr.preimage(rec).toString("utf-8"), cr.preimage(reordered).toString("utf-8"));
  assert.ok(!cr.preimage(rec).toString("utf-8").includes('"sig"'));
});

test("key round-trip through PEM; a stranger's openssl-shaped key works", () => {
  const pem = cr.privateKeyToPem(kp.privateKey);
  assert.match(pem, /BEGIN PRIVATE KEY/);
  const back = cr.privateKeyFromPem(pem);
  assert.equal(cr.keyIdOf(cr.publicKeyOfPrivate(back)), kp.keyId);
  const rec = cr.signCheckRecord(unsignedRecord(), back);
  assert.equal(cr.verifyCheckRecord(rec, { nowSeconds: NOW }).ok, true);
});

test("path and namespace: checks/<type>/<ns>/<ts>-<keyid8>.json", () => {
  const rec = signed(kp);
  assert.equal(cr.targetNamespace(rec), "acme-prod");
  const p = cr.checkRecordPath(rec);
  assert.match(p, /^checks\/pin\/acme-prod\/2026-09-22T14-02-11Z-[0-9a-f]{8}\.json$/);
  assert.equal(p, `checks/pin/acme-prod/2026-09-22T14-02-11Z-${cr.keyIdShort(kp.keyId)}.json`);
  const obs = signed(kp, { target: { type: "observation", ref: "observations/acme-prod/2026-09-01T00-00-00-000Z.json" } });
  assert.equal(cr.targetNamespace(obs), "acme-prod");
  assert.match(cr.checkRecordPath(obs), /^checks\/observation\/acme-prod\//);
  const stamp = signed(kp, { target: { type: "stamp", ref: "stamps/ab/abcd.json" } });
  assert.equal(cr.targetNamespace(stamp), null);
  assert.throws(() => cr.checkRecordPath(stamp), /no namespace/);
});
