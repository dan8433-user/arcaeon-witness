// test/helpers/check_fixtures.js — builders for signed check records. Not a
// test file (no test() calls). Every record built here verifies against
// lib/_check_record.js unless a caller mutates it afterwards.
"use strict";

const cr = require("../../lib/_check_record.js");

const HEX64 = "ab".repeat(32);

// A well-formed UNSIGNED record. Override any field via `over`.
function unsignedRecord(over = {}) {
  const base = {
    kind: "check",
    v: 1,
    target: { type: "pin", ref: "pins/acme-prod/00000007.json", digest: `sha256:${HEX64}` },
    claim_checked: "public-record-checks",
    inputs: [{ url: "https://raw.githubusercontent.com/o/r/main/pins/acme-prod/00000007.json", sha256: HEX64 }],
    result: "VERIFIED",
    detail: "15 results: 15 VERIFIED",
    checked_at: "2026-09-22T14:02:11Z",
    checker: { name: "stranger", binding_url: "https://example.org/keys/stranger.pub" },
    tool: { name: "arcaeon-verifier-two", version: "0.1.0", impl: "independent", source_sha256: HEX64 },
    trust_dependencies: ["github.com", "raw.githubusercontent.com"],
    rerun: "py verify.py https://github.com/o/r --json",
  };
  const out = { ...base, ...over };
  for (const k of ["target", "checker", "tool"]) {
    if (over[k]) out[k] = { ...base[k], ...over[k] };
  }
  return out;
}

function signed(keyPair, over = {}) {
  return cr.signCheckRecord(unsignedRecord(over), keyPair.privateKey);
}

// ISO string `seconds` before/after an epoch-seconds `now`.
function isoAt(seconds) {
  return new Date(seconds * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

module.exports = { HEX64, unsignedRecord, signed, isoAt };
