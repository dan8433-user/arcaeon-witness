// _oauth_state.js — OAuth `state` param encode/decode + validation for the
// Google Web-OAuth consent flow (api/oauth/google/start.js + callback.js).
// Underscore prefix = not routed as a serverless function by Vercel.
//
// state = base64url(JSON{account, nonce, ts}). The nonce is a shared secret
// (env OAUTH_NONCE) minted per consent attempt — it is the ONLY thing that
// gates this flow, since the phone-openable link carries no session/cookie.
// ts is a mint-time epoch-ms guard against a stale/replayed link.

"use strict";

const ACCOUNT_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_STATE_AGE_MS = 30 * 60 * 1000; // 30 minutes

function b64url(buf) {
  return Buffer.from(buf)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function b64urlDecode(str) {
  let s = String(str).replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return Buffer.from(s, "base64");
}

function encodeState({ account, nonce, ts }) {
  const json = JSON.stringify({ account, nonce, ts });
  return b64url(Buffer.from(json, "utf-8"));
}

// Throws on anything malformed. Callers that want a non-throwing check use
// validateState below.
function decodeState(state) {
  const json = b64urlDecode(state).toString("utf-8");
  const obj = JSON.parse(json);
  if (!obj || typeof obj !== "object") throw new Error("state is not an object");
  if (typeof obj.account !== "string" || !ACCOUNT_RE.test(obj.account)) {
    throw new Error("state.account missing or malformed");
  }
  if (typeof obj.nonce !== "string" || !obj.nonce) {
    throw new Error("state.nonce missing");
  }
  if (!Number.isFinite(obj.ts)) {
    throw new Error("state.ts missing or not a number");
  }
  return { account: obj.account, nonce: obj.nonce, ts: obj.ts };
}

// Constant-time-ish compare (length-first, like _store.js's safeEqual) —
// this file has no crypto import of its own on purpose, so this stays a
// simple string compare; nonce mismatch is already gated by a real
// constant-time compare in start.js. Here it's a secondary check on data
// that already round-tripped through JSON, not the primary defense.
function stringsEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  return a === b;
}

// Full validation used by callback.js: nonce must match the CURRENT
// OAUTH_NONCE, and the state must not be older than MAX_STATE_AGE_MS.
// Order matters (mirrors the task spec): nonce mismatch -> 403 is checked
// BEFORE expiry -> 400, so a stale AND wrong-nonce state reports as the
// auth failure, not the freshness failure.
function validateState(rawState, { nonceEnv, now = Date.now() } = {}) {
  let decoded;
  try {
    decoded = decodeState(rawState);
  } catch (e) {
    return { ok: false, status: 400, reason: "state_malformed", error: e.message };
  }

  const expected = typeof nonceEnv === "string" ? nonceEnv : "";
  if (!expected || !stringsEqual(decoded.nonce, expected)) {
    return { ok: false, status: 403, reason: "nonce_mismatch", decoded };
  }

  const age = now - decoded.ts;
  if (!Number.isFinite(age) || age < 0 || age > MAX_STATE_AGE_MS) {
    return { ok: false, status: 400, reason: "state_expired", decoded };
  }

  return { ok: true, decoded };
}

module.exports = {
  ACCOUNT_RE,
  MAX_STATE_AGE_MS,
  encodeState,
  decodeState,
  validateState,
};
