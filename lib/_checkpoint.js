// _checkpoint.js — the published checkpoint of lib/_logtree.js's log, as a
// C2SP-style signed note (design A4). Pure: no store, no network, no clock.
// Ed25519 through node:crypto only; nothing is installed.
//
// ---- THE FORMAT, byte for byte ----
//
// The NOTE TEXT is three lines, each terminated by "\n":
//
//   arcaeon.io/witness-pins/log/v1        origin: names the log
//   56                                     size: decimal, no sign, no leading zero
//   <base64 of the 32-byte root>           standard base64 with "=" padding, 44 chars
//
// Unsigned, the checkpoint IS that text (design A4: "unsigned in slice 1 … its
// authenticity rests on where it sits plus the OTS timestamp"). Signed, the
// note is:
//
//   <text>\n<one or more signature lines>
//
// i.e. the text, an EMPTY LINE, then lines of the form
//
//   — <key name> <base64( key_hash[0:4] || ed25519_signature[0:64] )>
//
// The first character of a signature line is U+2014 (EM DASH) followed by a
// space. It is a format byte of the signed-note layout, not prose (design A4's
// note "for whoever builds that"). The signature is Ed25519 over the NOTE
// TEXT exactly (the three lines with their newlines, nothing else).
//
// key_hash = SHA-256( key name || "\n" || 0x01 || 32-byte public key ), and
// the first 4 bytes go on the line so a checker can pick the line for its
// key without trying every signature. A verifier key is written
//
//   <key name>+<8 lowercase hex of key_hash[0:4]>+<base64( 0x01 || public key )>
//
// and a signer key
//
//   PRIVATE+KEY+<key name>+<8 hex>+<base64( 0x01 || 32-byte seed )>
//
// 0x01 is the algorithm byte for Ed25519 in this layout. These are the shapes
// the C2SP signed-note and tlog-checkpoint documents describe; this file was
// written from that description and NOT cross-checked against a reference
// implementation (none may be installed here). Interop with other tooling is
// therefore a claim this file does not make; it is stated in the CHANGELOG.
//
// Key handling: the private key never appears on a command line. The
// publisher takes the NAME of an environment variable holding a signer key
// (tools/publish_checkpoint.js --key-env), and tests generate throwaway keys
// in-process. No real key is created or read by anything in this file.
//
// The rule "clients MUST ignore unknown signatures": verifyCheckpointSignature
// looks only at lines whose name and key hash match the verifier key given.
// A note with no such line is "no signature for this key", which is not the
// same as "a bad signature"; the two are different reasons on purpose because
// they mean different things to a checker (COULD NOT LOOK versus BROKEN).
"use strict";

const crypto = require("crypto");
const { decodeBase64Root, LOG_ORIGIN } = require("./_logtree.js");

const SIG_PREFIX = "— "; // EM DASH, SPACE
const ALG_ED25519 = 0x01;
// DER prefixes so a raw 32-byte seed / public key can be lifted into a
// KeyObject without any library. PKCS#8 for Ed25519 private:
//   30 2e 02 01 00 30 05 06 03 2b 65 70 04 22 04 20 || seed
// SubjectPublicKeyInfo for Ed25519 public:
//   30 2a 30 05 06 03 2b 65 70 03 21 00 || pub
const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function keyHash(name, pub) {
  return crypto
    .createHash("sha256")
    .update(Buffer.concat([Buffer.from(name, "utf8"), Buffer.from("\n"), Buffer.from([ALG_ED25519]), pub]))
    .digest()
    .subarray(0, 4);
}

function validName(name) {
  // A key name is one token: no whitespace, no "+", non-empty, printable.
  return typeof name === "string" && /^[!-*,-~]+$/.test(name);
}

// ---- keys ----

function privateKeyFromSeed(seed) {
  return crypto.createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, seed]), format: "der", type: "pkcs8" });
}
function publicKeyFromRaw(pub) {
  return crypto.createPublicKey({ key: Buffer.concat([SPKI_PREFIX, pub]), format: "der", type: "spki" });
}
function rawPublic(privateKey) {
  return crypto.createPublicKey(privateKey).export({ format: "der", type: "spki" }).subarray(SPKI_PREFIX.length);
}

// Throwaway key generation, for tests and for an operator who wants a new
// key: returns the two strings. Nothing is written anywhere.
function generateKey(name) {
  if (!validName(name)) throw new TypeError("checkpoint: invalid key name");
  const { privateKey } = crypto.generateKeyPairSync("ed25519");
  const seed = privateKey.export({ format: "der", type: "pkcs8" }).subarray(PKCS8_PREFIX.length);
  const pub = rawPublic(privateKey);
  const h = keyHash(name, pub).toString("hex");
  return {
    signer: `PRIVATE+KEY+${name}+${h}+${Buffer.concat([Buffer.from([ALG_ED25519]), seed]).toString("base64")}`,
    verifier: `${name}+${h}+${Buffer.concat([Buffer.from([ALG_ED25519]), pub]).toString("base64")}`,
  };
}

// Split "<a>+<b>+<rest>" at the first N "+" only: the base64 tail may itself
// contain "+" (standard alphabet), so a naive split on every "+" refuses
// roughly a quarter of all keys.
function chop(str, n) {
  const parts = [];
  let rest = str;
  for (let i = 0; i < n; i++) {
    const idx = rest.indexOf("+");
    if (idx < 0) return null;
    parts.push(rest.slice(0, idx));
    rest = rest.slice(idx + 1);
  }
  parts.push(rest);
  return parts;
}

function parseVerifierKey(str) {
  if (typeof str !== "string") return { ok: false, reason: "malformed_key" };
  const parts = chop(str, 2);
  if (!parts) return { ok: false, reason: "malformed_key" };
  const [name, hashHex, b64] = parts;
  if (!validName(name) || !/^[0-9a-f]{8}$/.test(hashHex)) return { ok: false, reason: "malformed_key" };
  const raw = Buffer.from(b64, "base64");
  if (raw.toString("base64") !== b64 || raw.length !== 33 || raw[0] !== ALG_ED25519) {
    return { ok: false, reason: "malformed_key" };
  }
  const pub = raw.subarray(1);
  if (keyHash(name, pub).toString("hex") !== hashHex) return { ok: false, reason: "key_hash_mismatch" };
  return { ok: true, name, hash: hashHex, pub, publicKey: publicKeyFromRaw(pub) };
}

function parseSignerKey(str) {
  if (typeof str !== "string") return { ok: false, reason: "malformed_key" };
  const parts = chop(str, 4);
  if (!parts || parts[0] !== "PRIVATE" || parts[1] !== "KEY") return { ok: false, reason: "malformed_key" };
  const [, , name, hashHex, b64] = parts;
  if (!validName(name) || !/^[0-9a-f]{8}$/.test(hashHex)) return { ok: false, reason: "malformed_key" };
  const raw = Buffer.from(b64, "base64");
  if (raw.toString("base64") !== b64 || raw.length !== 33 || raw[0] !== ALG_ED25519) {
    return { ok: false, reason: "malformed_key" };
  }
  const privateKey = privateKeyFromSeed(raw.subarray(1));
  const pub = rawPublic(privateKey);
  if (keyHash(name, pub).toString("hex") !== hashHex) return { ok: false, reason: "key_hash_mismatch" };
  return { ok: true, name, hash: hashHex, privateKey, pub };
}

// ---- the note ----

function formatCheckpoint({ origin = LOG_ORIGIN, size, root }) {
  if (typeof origin !== "string" || !/^[!-~]+$/.test(origin)) throw new TypeError("checkpoint: origin must be one printable token");
  if (!Number.isInteger(size) || size < 0) throw new TypeError("checkpoint: size must be a non-negative integer");
  if (!Buffer.isBuffer(root) || root.length !== 32) throw new TypeError("checkpoint: root must be 32 bytes");
  return `${origin}\n${size}\n${root.toString("base64")}\n`;
}

// Parse a checkpoint file's full contents. Returns the note text (what a
// signature covers), the three fields, and the signature lines. Strict on
// purpose: exactly three text lines (this log publishes no extension lines in
// v1, so a fourth line is refused rather than skipped), "\n" endings only, a
// blank separator line before any signature, and every signature line in the
// documented shape. A malformed note is refused whole; a reader never gets a
// size and root out of a file it could not fully parse.
function parseCheckpoint(contents) {
  if (typeof contents !== "string") return { ok: false, reason: "malformed_checkpoint" };
  if (contents.includes("\r")) return { ok: false, reason: "malformed_checkpoint", detail: "CR byte in note" };
  const lines = contents.split("\n");
  // A well-formed file ends with "\n", so the last split element is "".
  if (lines.length < 4 || lines[lines.length - 1] !== "") return { ok: false, reason: "malformed_checkpoint", detail: "missing final newline" };
  lines.pop();
  const [origin, sizeStr, rootB64] = lines;
  if (!/^[!-~]+$/.test(origin)) return { ok: false, reason: "malformed_checkpoint", detail: "origin" };
  if (!/^(0|[1-9][0-9]*)$/.test(sizeStr) || sizeStr.length > 15) return { ok: false, reason: "malformed_checkpoint", detail: "size" };
  const root = decodeBase64Root(rootB64);
  if (!root) return { ok: false, reason: "malformed_checkpoint", detail: "root" };
  const text = `${origin}\n${sizeStr}\n${rootB64}\n`;
  const signatures = [];
  if (lines.length > 3) {
    if (lines[3] !== "") return { ok: false, reason: "malformed_checkpoint", detail: "expected an empty line after the note text" };
    if (lines.length === 4) return { ok: false, reason: "malformed_checkpoint", detail: "empty line with no signature" };
    for (const line of lines.slice(4)) {
      if (!line.startsWith(SIG_PREFIX)) return { ok: false, reason: "malformed_checkpoint", detail: "signature line" };
      const rest = line.slice(SIG_PREFIX.length).split(" ");
      if (rest.length !== 2 || !validName(rest[0])) return { ok: false, reason: "malformed_checkpoint", detail: "signature line" };
      const blob = Buffer.from(rest[1], "base64");
      if (blob.toString("base64") !== rest[1] || blob.length !== 4 + 64) return { ok: false, reason: "malformed_checkpoint", detail: "signature bytes" };
      signatures.push({ name: rest[0], hash: blob.subarray(0, 4).toString("hex"), sig: blob.subarray(4) });
    }
  }
  return { ok: true, origin, size: Number(sizeStr), root, text, signatures };
}

// Sign a note text with a signer key string. Returns the full signed note.
// Re-signing an already-signed note appends a line; the text is unchanged.
function signCheckpoint(contents, signerKeyStr) {
  const k = parseSignerKey(signerKeyStr);
  if (!k.ok) throw new TypeError(`checkpoint: ${k.reason}`);
  const p = parseCheckpoint(contents);
  if (!p.ok) throw new TypeError(`checkpoint: ${p.reason}${p.detail ? ` (${p.detail})` : ""}`);
  const sig = crypto.sign(null, Buffer.from(p.text, "utf8"), k.privateKey);
  const line = `${SIG_PREFIX}${k.name} ${Buffer.concat([Buffer.from(k.hash, "hex"), sig]).toString("base64")}\n`;
  return p.signatures.length === 0 ? `${p.text}\n${line}` : `${contents}${line}`;
}

// Verify that the note carries a valid signature by the given verifier key.
// Typed: "no_signature_for_key" (nothing to check — the checker cannot
// attribute the note) is distinct from "bad_signature" (a line claims this
// key and the bytes do not verify — the note was altered or forged).
function verifyCheckpointSignature(contents, verifierKeyStr) {
  const k = parseVerifierKey(verifierKeyStr);
  if (!k.ok) return { ok: false, reason: k.reason };
  const p = parseCheckpoint(contents);
  if (!p.ok) return { ok: false, reason: p.reason, detail: p.detail };
  const mine = p.signatures.filter((s) => s.name === k.name && s.hash === k.hash);
  if (mine.length === 0) return { ok: false, reason: "no_signature_for_key", key: `${k.name}+${k.hash}` };
  for (const s of mine) {
    let good = false;
    try {
      good = crypto.verify(null, Buffer.from(p.text, "utf8"), k.publicKey, s.sig);
    } catch {
      good = false;
    }
    if (good) return { ok: true, reason: "signed", key: `${k.name}+${k.hash}`, origin: p.origin, size: p.size, root: p.root };
  }
  return { ok: false, reason: "bad_signature", key: `${k.name}+${k.hash}` };
}

module.exports = {
  SIG_PREFIX,
  generateKey,
  parseVerifierKey,
  parseSignerKey,
  formatCheckpoint,
  parseCheckpoint,
  signCheckpoint,
  verifyCheckpointSignature,
  keyHash,
};
