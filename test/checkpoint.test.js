// test/checkpoint.test.js — lib/_checkpoint.js: the note format byte for
// byte, Ed25519 sign/verify with THROWAWAY keys generated in-test, the
// "ignore unknown signatures" rule, and a BREAK ARM: a lying verifier that
// accepts any note carrying a line for the key, without checking the bytes.
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");

const cp = require("../lib/_checkpoint.js");
const lt = require("../lib/_logtree.js");

const ROOT = crypto.createHash("sha256").update("a root").digest();
const TEXT = `${lt.LOG_ORIGIN}\n56\n${ROOT.toString("base64")}\n`;

test("format: three lines, LF endings, base64 root; parse round-trips and refuses each malformation", () => {
  assert.equal(cp.formatCheckpoint({ size: 56, root: ROOT }), TEXT);
  const p = cp.parseCheckpoint(TEXT);
  assert.equal(p.ok, true);
  assert.equal(p.origin, lt.LOG_ORIGIN);
  assert.equal(p.size, 56);
  assert.ok(p.root.equals(ROOT));
  assert.equal(p.text, TEXT);
  assert.deepEqual(p.signatures, []);

  const bad = {
    "leading zero in size": `${lt.LOG_ORIGIN}\n056\n${ROOT.toString("base64")}\n`,
    "negative size": `${lt.LOG_ORIGIN}\n-1\n${ROOT.toString("base64")}\n`,
    "CRLF": TEXT.replace(/\n/g, "\r\n"),
    "missing final newline": TEXT.slice(0, -1),
    "fourth text line (extension lines are not accepted in v1)": `${TEXT}extra\n`,
    "root of 31 bytes": `${lt.LOG_ORIGIN}\n56\n${ROOT.subarray(1).toString("base64")}\n`,
    "root url-safe alphabet": `${lt.LOG_ORIGIN}\n56\n${"-".repeat(43)}=\n`,
    "origin with a space": `arcaeon witness\n56\n${ROOT.toString("base64")}\n`,
    "empty line but no signature": `${TEXT}\n`,
    "signature line without the dash prefix": `${TEXT}\n- key AAAA\n`,
    "signature blob wrong length": `${TEXT}\n— key ${Buffer.alloc(10).toString("base64")}\n`,
    "two lines only": `${lt.LOG_ORIGIN}\n56\n`,
    "empty": "",
  };
  for (const [name, text] of Object.entries(bad)) {
    const r = cp.parseCheckpoint(text);
    assert.equal(r.ok, false, `accepted: ${name}`);
    assert.equal(r.reason, "malformed_checkpoint", name);
  }
  assert.equal(cp.parseCheckpoint(`${lt.LOG_ORIGIN}\n0\n${ROOT.toString("base64")}\n`).size, 0, "size 0 parses (a checker decides what it means)");
});

test("keys: generateKey yields a verifier key that parses, and a tampered key hash is refused", () => {
  const k = cp.generateKey("arcaeon-log-test");
  const v = cp.parseVerifierKey(k.verifier);
  assert.equal(v.ok, true);
  assert.equal(v.name, "arcaeon-log-test");
  const s = cp.parseSignerKey(k.signer);
  assert.equal(s.ok, true);
  assert.equal(s.hash, v.hash);
  assert.ok(s.pub.equals(v.pub), "the signer's derived public key is the verifier's");
  // key hash = SHA256(name || "\n" || 0x01 || pub)[0:4]
  assert.equal(cp.keyHash("arcaeon-log-test", v.pub).toString("hex"), v.hash);
  const i1 = k.verifier.indexOf("+");
  const i2 = k.verifier.indexOf("+", i1 + 1);
  const [name, hash, b64] = [k.verifier.slice(0, i1), k.verifier.slice(i1 + 1, i2), k.verifier.slice(i2 + 1)];
  const flipped = hash.slice(0, 7) + (hash.endsWith("0") ? "1" : "0");
  assert.equal(cp.parseVerifierKey(`${name}+${flipped}+${b64}`).reason, "key_hash_mismatch");
  assert.equal(cp.parseVerifierKey(`${name}+${hash}`).reason, "malformed_key");
  assert.equal(cp.parseVerifierKey(k.signer).reason, "malformed_key");
  assert.equal(cp.parseSignerKey(k.verifier).reason, "malformed_key");
  assert.equal(cp.parseVerifierKey(`${name}+${hash}+${Buffer.concat([Buffer.from([2]), v.pub]).toString("base64")}`).reason, "malformed_key", "algorithm byte other than 0x01");
  assert.throws(() => cp.generateKey("has space"), TypeError);
  assert.throws(() => cp.generateKey("has+plus"), TypeError);
});

test("sign then verify; the signature covers the note text and nothing else", () => {
  const k = cp.generateKey("k1");
  const signed = cp.signCheckpoint(TEXT, k.signer);
  assert.ok(signed.startsWith(`${TEXT}\n— k1 `), "text, empty line, dash-space-name-space");
  assert.ok(signed.endsWith("\n"));
  const lines = signed.split("\n");
  assert.equal(lines.length, 6, "3 text lines + empty + 1 signature + trailing");
  const blob = Buffer.from(lines[4].split(" ")[2], "base64");
  assert.equal(blob.length, 68);
  assert.equal(blob.subarray(0, 4).toString("hex"), cp.parseVerifierKey(k.verifier).hash);
  const r = cp.verifyCheckpointSignature(signed, k.verifier);
  assert.equal(r.ok, true);
  assert.equal(r.size, 56);
  assert.ok(r.root.equals(ROOT));
  // Direct check with node:crypto, independent of the module's own verify:
  const pub = cp.parseVerifierKey(k.verifier).publicKey;
  assert.equal(crypto.verify(null, Buffer.from(TEXT), pub, blob.subarray(4)), true);
  assert.equal(crypto.verify(null, Buffer.from(signed), pub, blob.subarray(4)), false, "the signature is NOT over the whole file");
});

test("tampered body is bad_signature; a different key is no_signature_for_key; unknown signature lines are ignored", () => {
  const k1 = cp.generateKey("k1");
  const k2 = cp.generateKey("k2");
  const signed = cp.signCheckpoint(TEXT, k1.signer);
  const tampered = signed.replace("\n56\n", "\n57\n");
  assert.equal(cp.verifyCheckpointSignature(tampered, k1.verifier).reason, "bad_signature");
  const rootFlipped = signed.replace(ROOT.toString("base64"), crypto.createHash("sha256").update("other").digest().toString("base64"));
  assert.equal(cp.verifyCheckpointSignature(rootFlipped, k1.verifier).reason, "bad_signature");
  assert.equal(cp.verifyCheckpointSignature(signed, k2.verifier).reason, "no_signature_for_key");
  // cosigned by k2 as well: both verify; a third, unknown line is ignored
  const both = cp.signCheckpoint(signed, k2.signer);
  assert.equal(both.split("\n").length, 7);
  assert.equal(cp.verifyCheckpointSignature(both, k1.verifier).ok, true);
  assert.equal(cp.verifyCheckpointSignature(both, k2.verifier).ok, true);
  const junk = `${both}— someone-else ${Buffer.alloc(68, 7).toString("base64")}\n`;
  assert.equal(cp.verifyCheckpointSignature(junk, k1.verifier).ok, true, "clients MUST ignore unknown signatures");
  // a line that names k1 with the right hash but garbage bytes: bad_signature
  const forged = `${TEXT}\n— k1 ${Buffer.concat([Buffer.from(cp.parseVerifierKey(k1.verifier).hash, "hex"), Buffer.alloc(64, 1)]).toString("base64")}\n`;
  assert.equal(cp.verifyCheckpointSignature(forged, k1.verifier).reason, "bad_signature");
  // same name, different key hash: not for this key
  const wrongHash = `${TEXT}\n— k1 ${Buffer.concat([Buffer.alloc(4, 0), Buffer.alloc(64, 1)]).toString("base64")}\n`;
  assert.equal(cp.verifyCheckpointSignature(wrongHash, k1.verifier).reason, "no_signature_for_key");
  assert.throws(() => cp.signCheckpoint("not a checkpoint", k1.signer), TypeError);
  assert.throws(() => cp.signCheckpoint(TEXT, "PRIVATE+KEY+nope"), TypeError);
});

test("BREAK ARM: a lying verifier that only checks for a line naming the key is caught by the tampered-body and forged cases", () => {
  const k1 = cp.generateKey("k1");
  const signed = cp.signCheckpoint(TEXT, k1.signer);
  const v = cp.parseVerifierKey(k1.verifier);
  const lying = (contents) => {
    const p = cp.parseCheckpoint(contents);
    if (!p.ok) return { ok: false };
    return { ok: p.signatures.some((s) => s.name === v.name && s.hash === v.hash) };
  };
  const cases = {
    tampered: signed.replace("\n56\n", "\n57\n"),
    forged: `${TEXT}\n— k1 ${Buffer.concat([Buffer.from(v.hash, "hex"), Buffer.alloc(64, 1)]).toString("base64")}\n`,
    "signature moved to another note": `${lt.LOG_ORIGIN}\n99\n${ROOT.toString("base64")}\n\n${signed.split("\n")[4]}\n`,
  };
  for (const [name, text] of Object.entries(cases)) {
    assert.equal(lying(text).ok, true, `the liar accepts ${name}`);
    assert.equal(cp.verifyCheckpointSignature(text, k1.verifier).ok, false, `ours refuses ${name}`);
  }
  assert.equal(cp.verifyCheckpointSignature(signed, k1.verifier).ok, true);
});
