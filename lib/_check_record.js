// _check_record.js — the signed CHECK RECORD: who checked, when, what, with
// which tool, what they found, and how to run it again.
// Underscore prefix = not routed as a serverless function by Vercel.
//
// This is part B of DESIGN_CONSISTENCY_AND_NEVER_LOOKED_2026-09-22.md
// (projects/online_business/, section B4). Every verdict the system had
// before this file was the result of ONE run, in the hands of whoever ran
// it, and it evaporated. A check record is the memory: a small signed JSON
// document that says "key K ran tool T against record R at time C and found
// VERIFIED / BROKEN / COULD_NOT_LOOK". lib/_audit_state.js folds a record's
// list of these into an audit state (BLIND / SELF-CHECKED / CHECKED / STALE
// / BROKEN). This file knows nothing about states; it only knows what a
// well-formed, honestly-signed check record is.
//
// Rules, each from a failure we have read about (design page B4):
//   - The signature covers EVERY field except `sig`. The /vow chain left
//     `author` and `evidence` outside its preimage and both could be rewritten
//     while every entry stayed green. Here the preimage is the whole record
//     minus `sig`, canonicalized by json-c14n:v1 (the same serializer
//     lib/_merkle.js hashes leaves with, so there is still one canonicalizer).
//   - Unknown top-level fields are refused, not ignored. A field the verifier
//     does not know about is a field a reader might trust that nobody checked.
//   - Public inputs only: every input names an https URL and the sha256 of
//     the bytes fetched from it. A check a stranger cannot re-run is refused.
//   - A future-dated record is refused. `checked_at` is the checker's claim;
//     the evidence is the commit that later introduces the file (same rule
//     the public record spec applies to `stamped_at`). A claim from the
//     future is not a claim anyone can have evidence for.
//   - Ed25519 via node:crypto only. No dependency.
//
// Key id format: "ed25519:<standard base64 of the raw 32-byte public key>".
// The id IS the public key, so a verifier needs nothing beyond the record
// itself to check the signature. The base64 must round-trip exactly (no
// non-canonical encodings, no missing padding) — a key id that can be spelt
// two ways is a key that can appear twice in a list of "keys not ours".

"use strict";

const crypto = require("node:crypto");
const { jdump, PyInt } = require("./_distill_core.js");

const RECORD_KIND = "check";
const RECORD_VERSION = 1;
const RESULTS = Object.freeze(["VERIFIED", "BROKEN", "COULD_NOT_LOOK"]);
const TARGET_TYPES = Object.freeze(["pin", "observation", "stamp", "log-consistency", "receipt"]);
const TOOL_IMPLS = Object.freeze(["reference", "independent"]);
const TOP_LEVEL_FIELDS = Object.freeze([
  "kind", "v", "target", "claim_checked", "inputs", "result", "detail",
  "checked_at", "checker", "tool", "trust_dependencies", "rerun", "sig",
]);
// The design page's default tolerance for a checker's clock running ahead of
// ours. A record dated further ahead than this is refused as future-dated.
const DEFAULT_SKEW_SECONDS = 300;

const HEX64 = /^[0-9a-f]{64}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
// Strict ISO-8601 UTC, second precision, optional fraction, literal Z.
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;
const KEY_ID = /^ed25519:([A-Za-z0-9+/]{43}=)$/;
// DER prefix of an Ed25519 SubjectPublicKeyInfo (RFC 8410), followed by the
// 32 raw key bytes. node:crypto has no "raw" import for public keys, so the
// prefix is spelt out here rather than fished out of an exported key.
const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

// ---------------------------------------------------------------------------
// canonical bytes (json-c14n:v1 over a nested plain object)
// ---------------------------------------------------------------------------
// lib/_merkle.js's canonicalBytes lifts a FLAT object; a check record nests
// two levels and carries arrays, so this lifter walks. Numbers: only the
// integer `v` exists in a record and it is lifted as a PyInt. A non-integer
// number is refused outright (design page A2 reason 3: "strings only"
// sidesteps the 24 vs 24.0 edge; the record keeps that property by never
// carrying a float).
function lift(v, path) {
  if (v === null) return null;
  if (v === undefined) throw new TypeError(`check_record: undefined at ${path} cannot be canonicalized`);
  if (typeof v === "boolean" || typeof v === "string") return v;
  if (typeof v === "number") {
    if (!Number.isInteger(v)) throw new TypeError(`check_record: non-integer number at ${path}`);
    return new PyInt(String(v));
  }
  if (Array.isArray(v)) return v.map((x, i) => lift(x, `${path}[${i}]`));
  if (typeof v === "object") {
    const m = new Map();
    for (const k of Object.keys(v)) m.set(k, lift(v[k], `${path}.${k}`));
    return m;
  }
  throw new TypeError(`check_record: unhandled value type ${typeof v} at ${path}`);
}

function canonicalBytes(obj) {
  return Buffer.from(jdump(lift(obj, "$"), true), "utf-8");
}

// The bytes the signature is over: every top-level field except `sig`.
function preimage(record) {
  const body = {};
  for (const k of Object.keys(record)) if (k !== "sig") body[k] = record[k];
  return canonicalBytes(body);
}

// ---------------------------------------------------------------------------
// keys
// ---------------------------------------------------------------------------
function generateKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  return { publicKey, privateKey, keyId: keyIdOf(publicKey) };
}

function rawPublicKeyBytes(publicKey) {
  const der = publicKey.export({ type: "spki", format: "der" });
  if (der.length !== 44 || !der.subarray(0, 12).equals(SPKI_ED25519_PREFIX)) {
    throw new TypeError("check_record: not an Ed25519 public key");
  }
  return der.subarray(12);
}

function keyIdOf(publicKey) {
  return `ed25519:${rawPublicKeyBytes(publicKey).toString("base64")}`;
}

// Parse "ed25519:<base64>" into a KeyObject. Returns null on any defect:
// wrong prefix, wrong length, non-canonical base64 (the id must re-encode to
// itself, byte for byte).
function publicKeyFromId(keyId) {
  if (typeof keyId !== "string") return null;
  const m = KEY_ID.exec(keyId);
  if (!m) return null;
  const raw = Buffer.from(m[1], "base64");
  if (raw.length !== 32 || raw.toString("base64") !== m[1]) return null;
  try {
    return crypto.createPublicKey({
      key: Buffer.concat([SPKI_ED25519_PREFIX, raw]), format: "der", type: "spki",
    });
  } catch {
    return null;
  }
}

// Private keys travel as PKCS#8 PEM (what `openssl genpkey -algorithm ed25519`
// writes and what node exports by default) — so a stranger can mint a
// throwaway key with a tool that is not ours.
function privateKeyToPem(privateKey) {
  return privateKey.export({ type: "pkcs8", format: "pem" });
}
function privateKeyFromPem(pem) {
  const k = crypto.createPrivateKey({ key: pem, format: "pem" });
  if (k.asymmetricKeyType !== "ed25519") throw new TypeError("check_record: private key is not Ed25519");
  return k;
}
function publicKeyOfPrivate(privateKey) {
  return crypto.createPublicKey(privateKey);
}

// Short, stable handle for filenames: first 8 hex of sha256(keyId).
function keyIdShort(keyId) {
  return crypto.createHash("sha256").update(String(keyId), "utf-8").digest("hex").slice(0, 8);
}

// ---------------------------------------------------------------------------
// shape
// ---------------------------------------------------------------------------
function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
function nonEmptyString(v) {
  return typeof v === "string" && v.length > 0;
}

// Returns { ok:true } or { ok:false, reason, field }. `reason` is one of a
// fixed vocabulary so a caller can branch on it; `field` names the offender.
// Checks the UNSIGNED shape only — signature and clock are verifyCheckRecord's.
function validateShape(rec) {
  const bad = (reason, field) => ({ ok: false, reason, field });
  if (!isPlainObject(rec)) return bad("not_an_object", "$");
  for (const k of Object.keys(rec)) {
    if (!TOP_LEVEL_FIELDS.includes(k)) return bad("unknown_field", k);
  }
  for (const k of TOP_LEVEL_FIELDS) {
    if (k === "sig") continue;
    if (!(k in rec)) return bad("missing_field", k);
  }
  if (rec.kind !== RECORD_KIND) return bad("malformed_field", "kind");
  if (rec.v !== RECORD_VERSION) return bad("unknown_version", "v");

  const t = rec.target;
  if (!isPlainObject(t)) return bad("malformed_field", "target");
  for (const k of Object.keys(t)) if (!["type", "ref", "digest"].includes(k)) return bad("unknown_field", `target.${k}`);
  if (!TARGET_TYPES.includes(t.type)) return bad("malformed_field", "target.type");
  if (!nonEmptyString(t.ref) || t.ref.startsWith("/") || t.ref.includes("..")) return bad("malformed_field", "target.ref");
  if (!nonEmptyString(t.digest) || !DIGEST.test(t.digest)) return bad("malformed_field", "target.digest");

  if (!nonEmptyString(rec.claim_checked)) return bad("malformed_field", "claim_checked");

  if (!Array.isArray(rec.inputs) || rec.inputs.length === 0) return bad("malformed_field", "inputs");
  for (let i = 0; i < rec.inputs.length; i++) {
    const inp = rec.inputs[i];
    if (!isPlainObject(inp)) return bad("malformed_field", `inputs[${i}]`);
    for (const k of Object.keys(inp)) if (!["url", "sha256"].includes(k)) return bad("unknown_field", `inputs[${i}].${k}`);
    if (!nonEmptyString(inp.url) || !/^https:\/\/\S+$/.test(inp.url)) return bad("input_not_public", `inputs[${i}].url`);
    if (!nonEmptyString(inp.sha256) || !HEX64.test(inp.sha256)) return bad("malformed_field", `inputs[${i}].sha256`);
  }

  if (!RESULTS.includes(rec.result)) return bad("malformed_field", "result");
  if (typeof rec.detail !== "string") return bad("malformed_field", "detail");

  if (!nonEmptyString(rec.checked_at) || !ISO_UTC.test(rec.checked_at) || !Number.isFinite(Date.parse(rec.checked_at))) {
    return bad("malformed_field", "checked_at");
  }

  const c = rec.checker;
  if (!isPlainObject(c)) return bad("malformed_field", "checker");
  for (const k of Object.keys(c)) if (!["key", "name", "binding_url"].includes(k)) return bad("unknown_field", `checker.${k}`);
  if (!publicKeyFromId(c.key)) return bad("bad_key_id", "checker.key");
  if (typeof c.name !== "string") return bad("malformed_field", "checker.name");
  if (typeof c.binding_url !== "string") return bad("malformed_field", "checker.binding_url");

  const tool = rec.tool;
  if (!isPlainObject(tool)) return bad("malformed_field", "tool");
  for (const k of Object.keys(tool)) if (!["name", "version", "impl", "source_sha256"].includes(k)) return bad("unknown_field", `tool.${k}`);
  if (!nonEmptyString(tool.name)) return bad("malformed_field", "tool.name");
  if (!nonEmptyString(tool.version)) return bad("malformed_field", "tool.version");
  if (!TOOL_IMPLS.includes(tool.impl)) return bad("malformed_field", "tool.impl");
  if (!nonEmptyString(tool.source_sha256) || !HEX64.test(tool.source_sha256)) return bad("malformed_field", "tool.source_sha256");

  if (!Array.isArray(rec.trust_dependencies) || !rec.trust_dependencies.every(nonEmptyString)) {
    return bad("malformed_field", "trust_dependencies");
  }
  if (!nonEmptyString(rec.rerun)) return bad("malformed_field", "rerun");
  if ("sig" in rec && typeof rec.sig !== "string") return bad("malformed_field", "sig");
  return { ok: true };
}

// ---------------------------------------------------------------------------
// sign / verify
// ---------------------------------------------------------------------------
// Returns a NEW object: the unsigned record's fields plus `sig`. Refuses a
// malformed record (a signature over garbage is still garbage, now with a
// stamp on it). If `checker.key` is present it must match the private key —
// a record that names one key and is signed by another is refused rather
// than silently corrected.
function signCheckRecord(unsigned, privateKey) {
  if (!isPlainObject(unsigned)) throw new TypeError("check_record: record must be an object");
  if ("sig" in unsigned) throw new TypeError("check_record: refusing to re-sign a record that already carries sig");
  const keyId = keyIdOf(publicKeyOfPrivate(privateKey));
  const rec = { ...unsigned, checker: { ...(unsigned.checker || {}) } };
  if (rec.checker.key === undefined) rec.checker.key = keyId;
  if (rec.checker.key !== keyId) {
    throw new TypeError("check_record: checker.key does not match the signing key");
  }
  const shape = validateShape(rec);
  if (!shape.ok) {
    const err = new TypeError(`check_record: refusing to sign a malformed record (${shape.reason}: ${shape.field})`);
    err.reason = shape.reason;
    err.field = shape.field;
    throw err;
  }
  const sig = crypto.sign(null, preimage(rec), privateKey).toString("base64");
  return { ...rec, sig };
}

// Returns { ok:true, key_id, checked_at_seconds } or { ok:false, reason, field }.
// Never throws on bad input. Refuses, in this order: not an object; unsigned
// (no sig); malformed shape; bad signature; future-dated.
//   opts.nowSeconds     integer epoch seconds "now" (default: the wall clock)
//   opts.skewSeconds    tolerance for a checker's clock running ahead
function verifyCheckRecord(record, opts = {}) {
  const bad = (reason, field) => ({ ok: false, reason, field });
  if (!isPlainObject(record)) return bad("not_an_object", "$");
  if (!("sig" in record) || record.sig === null || record.sig === undefined || record.sig === "") {
    return bad("unsigned", "sig");
  }
  const shape = validateShape(record);
  if (!shape.ok) return shape;
  if (typeof record.sig !== "string") return bad("malformed_field", "sig");
  const sigBytes = Buffer.from(record.sig, "base64");
  if (sigBytes.length !== 64 || sigBytes.toString("base64") !== record.sig) return bad("malformed_field", "sig");
  const pub = publicKeyFromId(record.checker.key);
  if (!pub) return bad("bad_key_id", "checker.key");
  let good = false;
  try {
    good = crypto.verify(null, preimage(record), pub, sigBytes);
  } catch {
    good = false;
  }
  if (!good) return bad("bad_signature", "sig");

  const nowSeconds = Number.isInteger(opts.nowSeconds) ? opts.nowSeconds : Math.floor(Date.now() / 1000);
  const skew = Number.isInteger(opts.skewSeconds) ? opts.skewSeconds : DEFAULT_SKEW_SECONDS;
  const checkedAtSeconds = Math.floor(Date.parse(record.checked_at) / 1000);
  if (checkedAtSeconds > nowSeconds + skew) return bad("future_dated", "checked_at");
  return { ok: true, key_id: record.checker.key, checked_at_seconds: checkedAtSeconds };
}

// The namespace a record is about, read from target.ref, or null. A pin or
// observation path is pins/<ns>/... or observations/<ns>/...; anything else
// (stamps, log checkpoints, receipts) has no namespace.
function targetNamespace(record) {
  const ref = record && record.target && record.target.ref;
  if (typeof ref !== "string") return null;
  const m = /^(?:pins|observations)\/([^/]+)\/.+$/.exec(ref);
  return m ? m[1] : null;
}

// Where a record lives in the pins repo (design page B4, with the target's
// namespace as the id and the checker's short key id in the filename so two
// checkers in the same second cannot collide): create-only, never edited.
//   checks/<target type>/<namespace>/<checked_at, colons -> dashes>-<keyid8>.json
function checkRecordPath(record) {
  const ns = targetNamespace(record);
  if (!ns) throw new TypeError("check_record: no namespace in target.ref; path is defined for pin/observation targets only");
  const stamp = String(record.checked_at).replace(/:/g, "-").replace(/\.\d+Z$/, "Z");
  return `checks/${record.target.type}/${ns}/${stamp}-${keyIdShort(record.checker.key)}.json`;
}

module.exports = {
  RECORD_KIND, RECORD_VERSION, RESULTS, TARGET_TYPES, TOOL_IMPLS, TOP_LEVEL_FIELDS,
  DEFAULT_SKEW_SECONDS,
  canonicalBytes, preimage,
  generateKeyPair, keyIdOf, publicKeyFromId, privateKeyToPem, privateKeyFromPem, publicKeyOfPrivate, keyIdShort,
  validateShape, signCheckRecord, verifyCheckRecord,
  targetNamespace, checkRecordPath,
};
