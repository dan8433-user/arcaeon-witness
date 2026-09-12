// GET /api/oauth/google/start — begin the Web-OAuth consent flow for a
// second Google Workspace account (e.g. daniel@arcaeon.io), openable from a
// phone with no session/cookie.
//
// ?account=<name>&nonce=<hex> -> 302 to Google's consent screen.
//
// The nonce is a shared secret (env OAUTH_NONCE) minted per consent attempt.
// It is the ONLY gate here: no matching nonce, no redirect, ever — a plain
// bearer-token check would need a session this phone-openable link cannot
// carry, so the per-consent nonce stands in.
//
// The Desktop OAuth client (localhost redirect) only completes on the
// laptop that's listening on that port; this is the Web client counterpart,
// whose redirect_uri is this repo's own callback, reachable from anywhere.

"use strict";

const crypto = require("crypto");
const { encodeState, ACCOUNT_RE } = require("../../../lib/_oauth_state.js");

const REDIRECT_URI = "https://arcaeon-witness.vercel.app/api/oauth/google/callback";
const SCOPE = [
  "https://mail.google.com/",
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/drive",
].join(" ");
const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";

// Length-first then constant-time compare, same idiom as _store.js's
// safeEqual — nonce is the only thing standing between "anyone with the
// link" and "the person who was handed today's nonce."
function nonceMatches(candidate, expected) {
  if (!expected) return false;
  const a = Buffer.from(String(candidate == null ? "" : candidate), "utf8");
  const b = Buffer.from(String(expected), "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

module.exports = async (req, res) => {
  if (req.method !== "GET") {
    res.setHeader("allow", "GET");
    return res.status(405).json({ error: "GET only" });
  }

  const account = typeof req.query.account === "string" ? req.query.account.trim() : "";
  const nonce = typeof req.query.nonce === "string" ? req.query.nonce.trim() : "";

  res.setHeader("cache-control", "no-store");

  // Nonce is checked BEFORE anything else about the request is validated or
  // reported: a wrong/missing nonce gets exactly one flat 403, no hints
  // about what else might be wrong with the call.
  const expected = process.env.OAUTH_NONCE || "";
  if (!nonceMatches(nonce, expected)) {
    return res.status(403).json({ error: "nonce mismatch" });
  }

  if (!account || !ACCOUNT_RE.test(account)) {
    return res.status(400).json({ error: "missing or malformed account" });
  }

  const clientId = process.env.GOOGLE_WEB_CLIENT_ID;
  if (!clientId) {
    return res.status(500).json({ error: "GOOGLE_WEB_CLIENT_ID not configured" });
  }

  const state = encodeState({ account, nonce, ts: Date.now() });

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    scope: SCOPE,
    state,
  });
  const loginHint = process.env.OAUTH_LOGIN_HINT;
  if (loginHint) params.set("login_hint", loginHint);

  res.setHeader("location", `${AUTH_ENDPOINT}?${params.toString()}`);
  return res.status(302).end();
};
