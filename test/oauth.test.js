// test/oauth.test.js — Google Web-OAuth consent flow
// (lib/_oauth_state.js, lib/_oauth_crypto.js, api/oauth/google/start.js,
// api/oauth/google/callback.js).
//
// Covers: state encode/decode roundtrip, nonce mismatch -> 403, expired
// state -> 400, hybrid RSA-OAEP+AES-256-GCM roundtrip against a test
// keypair, and the full callback flow with a mocked token exchange +
// mocked GitHub commit.
"use strict";

process.env.GITHUB_USAGE_REPO = "test-owner/test-usage";
process.env.GITHUB_PIN_TOKEN = "test-token";

const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");

const { encodeState, decodeState, validateState } = require("../lib/_oauth_state.js");
const { encryptForReceiver } = require("../lib/_oauth_crypto.js");
const { MockGitHubStore } = require("./helpers/mock_store.js");
const { makeReq, makeRes } = require("./helpers/http_mocks.js");

const startHandler = require("../api/oauth/google/start.js");
const callbackHandler = require("../api/oauth/google/callback.js");

const NONCE = "aabbccdd11223344";

let savedEnv;

function snapshotEnv(keys) {
  const s = {};
  for (const k of keys) s[k] = process.env[k];
  return s;
}
function restoreEnv(s) {
  for (const k of Object.keys(s)) {
    if (s[k] === undefined) delete process.env[k];
    else process.env[k] = s[k];
  }
}

const ENV_KEYS = [
  "OAUTH_NONCE",
  "GOOGLE_WEB_CLIENT_ID",
  "GOOGLE_WEB_CLIENT_SECRET",
  "OAUTH_RECEIVER_PUBKEY_PEM",
  "OAUTH_LOGIN_HINT",
];

beforeEach(() => {
  savedEnv = snapshotEnv(ENV_KEYS);
});
afterEach(() => {
  restoreEnv(savedEnv);
});

// ---------------------------------------------------------------------
// state encode/decode roundtrip
// ---------------------------------------------------------------------

test("state: encode then decode returns the original account/nonce/ts", () => {
  const now = Date.now();
  const state = encodeState({ account: "arcaeon", nonce: NONCE, ts: now });
  const decoded = decodeState(state);
  assert.deepEqual(decoded, { account: "arcaeon", nonce: NONCE, ts: now });
});

test("state: encoded value is base64url (no +, /, or padding =)", () => {
  const state = encodeState({ account: "arcaeon", nonce: NONCE, ts: Date.now() });
  assert.equal(/[+/=]/.test(state), false);
});

test("state: decodeState throws on malformed base64/JSON", () => {
  assert.throws(() => decodeState("not-valid-base64url-json!!"));
});

test("state: decodeState throws when account is missing", () => {
  const bad = Buffer.from(JSON.stringify({ nonce: NONCE, ts: Date.now() }), "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  assert.throws(() => decodeState(bad));
});

// ---------------------------------------------------------------------
// validateState: nonce mismatch -> 403, expired -> 400
// ---------------------------------------------------------------------

test("validateState: nonce mismatch -> 403", () => {
  const state = encodeState({ account: "arcaeon", nonce: "wrong-nonce", ts: Date.now() });
  const r = validateState(state, { nonceEnv: NONCE });
  assert.equal(r.ok, false);
  assert.equal(r.status, 403);
  assert.equal(r.reason, "nonce_mismatch");
});

test("validateState: no OAUTH_NONCE configured -> 403 (fails closed)", () => {
  const state = encodeState({ account: "arcaeon", nonce: NONCE, ts: Date.now() });
  const r = validateState(state, { nonceEnv: "" });
  assert.equal(r.ok, false);
  assert.equal(r.status, 403);
});

test("validateState: expired state (> 30 min old) -> 400", () => {
  const old = Date.now() - 31 * 60 * 1000;
  const state = encodeState({ account: "arcaeon", nonce: NONCE, ts: old });
  const r = validateState(state, { nonceEnv: NONCE });
  assert.equal(r.ok, false);
  assert.equal(r.status, 400);
  assert.equal(r.reason, "state_expired");
});

test("validateState: a state that is BOTH wrong-nonce AND expired reports nonce_mismatch (403), not expiry", () => {
  const old = Date.now() - 60 * 60 * 1000;
  const state = encodeState({ account: "arcaeon", nonce: "wrong", ts: old });
  const r = validateState(state, { nonceEnv: NONCE });
  assert.equal(r.status, 403);
  assert.equal(r.reason, "nonce_mismatch");
});

test("validateState: fresh, matching state is ok", () => {
  const state = encodeState({ account: "arcaeon", nonce: NONCE, ts: Date.now() - 1000 });
  const r = validateState(state, { nonceEnv: NONCE });
  assert.equal(r.ok, true);
  assert.equal(r.decoded.account, "arcaeon");
});

// ---------------------------------------------------------------------
// hybrid encryption roundtrip
// ---------------------------------------------------------------------

test("encryptForReceiver: RSA-OAEP+AES-256-GCM roundtrips against a fresh keypair", () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048, // small/fast for the test; production uses 4096
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });

  const plaintext = {
    access_token: "ya29.fake",
    refresh_token: "1//fake-refresh",
    expiry: "2026-09-12T00:00:00.000Z",
    scope: "https://mail.google.com/",
  };

  const enc = encryptForReceiver(publicKey, plaintext);
  assert.equal(enc.alg, "RSA-OAEP-256+A256GCM");
  for (const f of ["ek", "iv", "tag", "ct"]) {
    assert.equal(typeof enc[f], "string", `${f} must be a base64 string`);
  }

  // Decrypt independently with plain node:crypto — this is the Python
  // receiver's job in production, but the JS-side contract is verified
  // here without importing the Python module.
  const aesKey = crypto.privateDecrypt(
    {
      key: privateKey,
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: "sha256",
    },
    Buffer.from(enc.ek, "base64")
  );
  assert.equal(aesKey.length, 32);

  const decipher = crypto.createDecipheriv("aes-256-gcm", aesKey, Buffer.from(enc.iv, "base64"));
  decipher.setAuthTag(Buffer.from(enc.tag, "base64"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(enc.ct, "base64")),
    decipher.final(),
  ]);
  assert.deepEqual(JSON.parse(decrypted.toString("utf-8")), plaintext);
});

test("encryptForReceiver: tampering with the ciphertext breaks GCM auth (tag check fails)", () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const enc = encryptForReceiver(publicKey, { hello: "world" });
  const aesKey = crypto.privateDecrypt(
    { key: privateKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
    Buffer.from(enc.ek, "base64")
  );
  const ct = Buffer.from(enc.ct, "base64");
  ct[0] ^= 0xff; // flip a bit
  const decipher = crypto.createDecipheriv("aes-256-gcm", aesKey, Buffer.from(enc.iv, "base64"));
  decipher.setAuthTag(Buffer.from(enc.tag, "base64"));
  assert.throws(() => {
    Buffer.concat([decipher.update(ct), decipher.final()]);
  });
});

// ---------------------------------------------------------------------
// api/oauth/google/start.js
// ---------------------------------------------------------------------

test("start: no OAUTH_NONCE armed -> 403, no redirect issued", async () => {
  delete process.env.OAUTH_NONCE;
  const req = makeReq({ method: "GET", query: { account: "arcaeon", nonce: NONCE } });
  const res = makeRes();
  await startHandler(req, res);
  assert.equal(res._status, 403);
  assert.equal(res._headers["location"], undefined, "no Location header may be set without a valid nonce");
});

test("start: wrong nonce -> 403, no redirect issued", async () => {
  process.env.OAUTH_NONCE = NONCE;
  const req = makeReq({ method: "GET", query: { account: "arcaeon", nonce: "not-the-nonce" } });
  const res = makeRes();
  await startHandler(req, res);
  assert.equal(res._status, 403);
  assert.equal(res._headers["location"], undefined);
});

test("start: missing nonce entirely -> 403, no redirect issued", async () => {
  process.env.OAUTH_NONCE = NONCE;
  const req = makeReq({ method: "GET", query: { account: "arcaeon" } });
  const res = makeRes();
  await startHandler(req, res);
  assert.equal(res._status, 403);
});

test("start: matching nonce but missing account -> 400", async () => {
  process.env.OAUTH_NONCE = NONCE;
  const req = makeReq({ method: "GET", query: { nonce: NONCE } });
  const res = makeRes();
  await startHandler(req, res);
  assert.equal(res._status, 400);
});

test("start: matching nonce + account -> 302 to Google with the required params", async () => {
  process.env.OAUTH_NONCE = NONCE;
  process.env.GOOGLE_WEB_CLIENT_ID = "client-123.apps.googleusercontent.com";
  const req = makeReq({ method: "GET", query: { account: "arcaeon", nonce: NONCE } });
  const res = makeRes();
  await startHandler(req, res);
  assert.equal(res._status, 302);
  const loc = res._headers["location"];
  assert.ok(loc.startsWith("https://accounts.google.com/o/oauth2/v2/auth?"));
  const params = new URL(loc).searchParams;
  assert.equal(params.get("client_id"), "client-123.apps.googleusercontent.com");
  assert.equal(params.get("redirect_uri"), "https://arcaeon-witness.vercel.app/api/oauth/google/callback");
  assert.equal(params.get("response_type"), "code");
  assert.equal(params.get("access_type"), "offline");
  assert.equal(params.get("prompt"), "consent");
  assert.equal(params.get("include_granted_scopes"), "true");
  assert.equal(
    params.get("scope"),
    "https://mail.google.com/ https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/drive"
  );
  const state = decodeState(params.get("state"));
  assert.equal(state.account, "arcaeon");
  assert.equal(state.nonce, NONCE);
});

test("start: OAUTH_LOGIN_HINT set is passed through as login_hint", async () => {
  process.env.OAUTH_NONCE = NONCE;
  process.env.GOOGLE_WEB_CLIENT_ID = "client-123";
  process.env.OAUTH_LOGIN_HINT = "daniel@arcaeon.io";
  const req = makeReq({ method: "GET", query: { account: "arcaeon", nonce: NONCE } });
  const res = makeRes();
  await startHandler(req, res);
  const params = new URL(res._headers["location"]).searchParams;
  assert.equal(params.get("login_hint"), "daniel@arcaeon.io");
});

test("start: non-GET method -> 405", async () => {
  const req = makeReq({ method: "POST", query: {} });
  const res = makeRes();
  await startHandler(req, res);
  assert.equal(res._status, 405);
});

// ---------------------------------------------------------------------
// api/oauth/google/callback.js — full flow with mocked token exchange +
// mocked GitHub commit
// ---------------------------------------------------------------------

const TEST_KEYPAIR = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

function fakeFetchResponse(status, bodyObj) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => bodyObj,
    text: async () => JSON.stringify(bodyObj),
  };
}

// Routes oauth2.googleapis.com/token to `tokenResponder`, everything else
// (the GitHub contents API) to the shared MockGitHubStore fixture.
function installFetchStack(store, tokenResponder) {
  const original = global.fetch;
  global.fetch = async (url, opts) => {
    const u = String(url);
    if (u.startsWith("https://oauth2.googleapis.com/token")) {
      return tokenResponder(url, opts);
    }
    return store.handleFetch(url, opts);
  };
  return () => {
    global.fetch = original;
  };
}

function validState(account = "arcaeon") {
  return encodeState({ account, nonce: NONCE, ts: Date.now() - 1000 });
}

let store, restoreFetch;

function setupCallbackEnv() {
  process.env.OAUTH_NONCE = NONCE;
  process.env.GOOGLE_WEB_CLIENT_ID = "client-123";
  process.env.GOOGLE_WEB_CLIENT_SECRET = "shh";
  process.env.OAUTH_RECEIVER_PUBKEY_PEM = TEST_KEYPAIR.publicKey;
}

afterEach(() => {
  if (restoreFetch) {
    restoreFetch();
    restoreFetch = null;
  }
});

test("callback: happy path exchanges the code, encrypts, commits, and renders Connected", async () => {
  setupCallbackEnv();
  store = new MockGitHubStore();
  restoreFetch = installFetchStack(store, async () =>
    fakeFetchResponse(200, {
      access_token: "ya29.abc",
      refresh_token: "1//refresh-abc",
      expires_in: 3600,
      scope: "https://mail.google.com/ https://www.googleapis.com/auth/calendar",
      token_type: "Bearer",
    })
  );

  const req = makeReq({ method: "GET", query: { code: "auth-code-xyz", state: validState() } });
  const res = makeRes();
  await callbackHandler(req, res);

  assert.equal(res._status, 200);
  assert.match(res._body, /Connected\. You can close this\./);
  assert.equal(res._body.includes("auth-code-xyz"), false, "the auth code must never appear in the page");

  const committed = store.read("test-owner/test-usage", "oauth/google/arcaeon.json.enc");
  assert.ok(committed, "ciphertext must be committed to oauth/google/<account>.json.enc");
  assert.equal(committed.alg, "RSA-OAEP-256+A256GCM");

  // Decrypt what was actually committed and check the token round-tripped.
  const aesKey = crypto.privateDecrypt(
    { key: TEST_KEYPAIR.privateKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
    Buffer.from(committed.ek, "base64")
  );
  const decipher = crypto.createDecipheriv("aes-256-gcm", aesKey, Buffer.from(committed.iv, "base64"));
  decipher.setAuthTag(Buffer.from(committed.tag, "base64"));
  const plain = JSON.parse(
    Buffer.concat([decipher.update(Buffer.from(committed.ct, "base64")), decipher.final()]).toString("utf-8")
  );
  assert.equal(plain.access_token, "ya29.abc");
  assert.equal(plain.refresh_token, "1//refresh-abc");
  assert.equal(plain.scope, "https://mail.google.com/ https://www.googleapis.com/auth/calendar");
  assert.ok(plain.expiry, "expiry must be computed from expires_in");
});

test("callback: nonce mismatch on state -> 403, no token exchange attempted", async () => {
  setupCallbackEnv();
  store = new MockGitHubStore();
  let tokenCalled = false;
  restoreFetch = installFetchStack(store, async () => {
    tokenCalled = true;
    return fakeFetchResponse(200, { access_token: "x" });
  });

  const badState = encodeState({ account: "arcaeon", nonce: "wrong", ts: Date.now() });
  const req = makeReq({ method: "GET", query: { code: "c", state: badState } });
  const res = makeRes();
  await callbackHandler(req, res);

  assert.equal(res._status, 403);
  assert.match(res._body, /nonce_mismatch/);
  assert.equal(tokenCalled, false, "must not exchange the code before state is validated");
});

test("callback: expired state -> 400", async () => {
  setupCallbackEnv();
  store = new MockGitHubStore();
  restoreFetch = installFetchStack(store, async () => fakeFetchResponse(200, { access_token: "x" }));

  const oldState = encodeState({ account: "arcaeon", nonce: NONCE, ts: Date.now() - 60 * 60 * 1000 });
  const req = makeReq({ method: "GET", query: { code: "c", state: oldState } });
  const res = makeRes();
  await callbackHandler(req, res);

  assert.equal(res._status, 400);
  assert.match(res._body, /state_expired/);
});

test("callback: Google denial (?error=) -> 400, named step, no token exchange", async () => {
  setupCallbackEnv();
  store = new MockGitHubStore();
  let tokenCalled = false;
  restoreFetch = installFetchStack(store, async () => {
    tokenCalled = true;
    return fakeFetchResponse(200, {});
  });

  const req = makeReq({ method: "GET", query: { error: "access_denied" } });
  const res = makeRes();
  await callbackHandler(req, res);

  assert.equal(res._status, 400);
  assert.match(res._body, /google_denied/);
  assert.equal(tokenCalled, false);
});

test("callback: token exchange failure (non-2xx) -> 502, upstream body never surfaced", async () => {
  setupCallbackEnv();
  store = new MockGitHubStore();
  restoreFetch = installFetchStack(store, async () =>
    fakeFetchResponse(400, { error: "invalid_grant", secret_detail: "should-never-leak" })
  );

  const req = makeReq({ method: "GET", query: { code: "c", state: validState() } });
  const res = makeRes();
  await callbackHandler(req, res);

  assert.equal(res._status, 502);
  assert.match(res._body, /token_exchange/);
  assert.equal(res._body.includes("should-never-leak"), false);
});

test("callback: GitHub commit failure -> 502, named step", async () => {
  setupCallbackEnv();
  store = new MockGitHubStore();
  store.forceFailure("test-owner/test-usage", "oauth/google/arcaeon.json.enc", 1, 500);
  restoreFetch = installFetchStack(store, async () =>
    fakeFetchResponse(200, { access_token: "ya29.abc", refresh_token: "r", expires_in: 3600 })
  );

  const req = makeReq({ method: "GET", query: { code: "c", state: validState() } });
  const res = makeRes();
  await callbackHandler(req, res);

  assert.equal(res._status, 502);
  assert.match(res._body, /commit/);
});

test("callback: missing receiver pubkey -> 500, named step, nothing committed", async () => {
  setupCallbackEnv();
  delete process.env.OAUTH_RECEIVER_PUBKEY_PEM;
  store = new MockGitHubStore();
  restoreFetch = installFetchStack(store, async () =>
    fakeFetchResponse(200, { access_token: "ya29.abc", refresh_token: "r", expires_in: 3600 })
  );

  const req = makeReq({ method: "GET", query: { code: "c", state: validState() } });
  const res = makeRes();
  await callbackHandler(req, res);

  assert.equal(res._status, 500);
  assert.match(res._body, /receiver_pubkey_not_configured/);
  assert.equal(store.has("test-owner/test-usage", "oauth/google/arcaeon.json.enc"), false);
});

test("callback: overwrite allowed — re-consenting for the same account replaces the file", async () => {
  setupCallbackEnv();
  store = new MockGitHubStore();
  store.seed("test-owner/test-usage", "oauth/google/arcaeon.json.enc", { alg: "old", ek: "x", iv: "x", tag: "x", ct: "x" });
  restoreFetch = installFetchStack(store, async () =>
    fakeFetchResponse(200, { access_token: "ya29.new", refresh_token: "r-new", expires_in: 3600 })
  );

  const req = makeReq({ method: "GET", query: { code: "c", state: validState() } });
  const res = makeRes();
  await callbackHandler(req, res);

  assert.equal(res._status, 200);
  const committed = store.read("test-owner/test-usage", "oauth/google/arcaeon.json.enc");
  assert.notEqual(committed.alg, "old");
});

test("callback: non-GET method -> 405", async () => {
  const req = makeReq({ method: "POST", query: {} });
  const res = makeRes();
  await callbackHandler(req, res);
  assert.equal(res._status, 405);
});
