// GET /api/oauth/google/callback — Google redirects here with ?code&state
// after consent. Exchanges the code for tokens, encrypts the token JSON to
// our receiver's RSA public key (hybrid RSA-OAEP-SHA256 + AES-256-GCM,
// lib/_oauth_crypto.js), and commits the ciphertext to the PRIVATE usage
// repo at oauth/google/<account>.json.enc. Renders a plain HTML page either
// way. NEVER logs the code or the tokens — only step names and HTTP
// statuses reach console.error / the rendered page.

"use strict";

const { validateState } = require("../../../lib/_oauth_state.js");
const { encryptForReceiver } = require("../../../lib/_oauth_crypto.js");
const oauthStore = require("../../../lib/_oauth_store.js");

const REDIRECT_URI = "https://arcaeon-witness.vercel.app/api/oauth/google/callback";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

function page(message) {
  return (
    "<!doctype html><html><head><meta charset=\"utf-8\">" +
    "<title>Google OAuth</title></head>" +
    `<body style="font-family:sans-serif;padding:2rem;max-width:32rem;margin:0 auto;">` +
    `<p>${message}</p></body></html>`
  );
}

function sendHtml(res, status, html) {
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.status(status);
  if (typeof res.send === "function") return res.send(html);
  return res.end(html);
}

// Renders the "named step failed" page. `step` is a short machine-readable
// tag, never an upstream error body — those can carry the auth code,
// redirect_uri echoes, or other detail that has no business on this page.
function fail(res, status, step) {
  console.error(`[oauth-callback] failed at step: ${step} (status ${status})`);
  return sendHtml(res, status, page(`Connection failed at step: ${step}. You can close this.`));
}

module.exports = async (req, res) => {
  if (req.method !== "GET") {
    res.setHeader("allow", "GET");
    return res.status(405).json({ error: "GET only" });
  }

  const query = req.query || {};

  if (query.error) {
    return fail(res, 400, "google_denied");
  }
  const code = typeof query.code === "string" ? query.code : "";
  const state = typeof query.state === "string" ? query.state : "";
  if (!code) return fail(res, 400, "missing_code");
  if (!state) return fail(res, 400, "missing_state");

  const stateCheck = validateState(state, { nonceEnv: process.env.OAUTH_NONCE || "" });
  if (!stateCheck.ok) {
    return fail(res, stateCheck.status, stateCheck.reason);
  }
  const { account } = stateCheck.decoded;

  const clientId = process.env.GOOGLE_WEB_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_WEB_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return fail(res, 500, "client_not_configured");
  }
  const pubkeyPem = process.env.OAUTH_RECEIVER_PUBKEY_PEM;
  if (!pubkeyPem) {
    return fail(res, 500, "receiver_pubkey_not_configured");
  }

  let tokenJson;
  try {
    const resp = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: REDIRECT_URI,
        grant_type: "authorization_code",
      }).toString(),
    });
    if (!resp.ok) {
      // Upstream body never reaches the page or the code/token — only the
      // status does. Google's error bodies can echo request parameters.
      return fail(res, 502, "token_exchange");
    }
    tokenJson = await resp.json();
  } catch {
    return fail(res, 502, "token_exchange");
  }

  const accessToken = tokenJson && tokenJson.access_token;
  if (!accessToken) {
    return fail(res, 502, "token_exchange_empty");
  }
  const expiresIn = Number(tokenJson.expires_in);
  const expiry = Number.isFinite(expiresIn)
    ? new Date(Date.now() + expiresIn * 1000).toISOString()
    : null;

  const payload = {
    access_token: accessToken,
    refresh_token: tokenJson.refresh_token || null,
    expiry,
    scope: tokenJson.scope || null,
    token_type: tokenJson.token_type || null,
  };

  let enc;
  try {
    enc = encryptForReceiver(pubkeyPem, payload);
  } catch {
    return fail(res, 500, "encrypt");
  }

  try {
    await oauthStore.putRaw(
      `oauth/google/${account}.json.enc`,
      JSON.stringify(enc, null, 2) + "\n",
      `oauth: google consent for ${account}`
    );
  } catch {
    return fail(res, 502, "commit");
  }

  return sendHtml(res, 200, page("Connected. You can close this."));
};
