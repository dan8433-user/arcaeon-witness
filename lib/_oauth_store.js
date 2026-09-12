// _oauth_store.js — GitHub-contents-API writer for the PRIVATE usage repo,
// scoped to the oauth/ prefix. Underscore prefix = not routed as a
// serverless function by Vercel.
//
// Same repo, same token, same contents-API shape api/_balance.js and
// api/_meter.js already use for this repo (dan8433-user/arcaeon-witness-usage)
// — a dedicated thin wrapper rather than importing across those modules,
// matching this repo's existing pattern of each module owning its own
// GitHub-contents helper (see _balance.js's own getFile/putFile, distinct
// from _store.js's public-repo pair).
//
// Overwrite is allowed here on purpose (per the oauth callback's spec): a
// re-consent for the same account replaces its ciphertext file. No CAS
// retry loop — this path is a low-frequency, human-initiated write, not a
// contended counter like the meter/balance files.

"use strict";

const USAGE_REPO = process.env.GITHUB_USAGE_REPO || "dan8433-user/arcaeon-witness-usage";
const USAGE_BRANCH = process.env.GITHUB_USAGE_BRANCH || "main";
const API = "https://api.github.com";

function ghHeaders() {
  const h = {
    accept: "application/vnd.github+json",
    "user-agent": "arcaeon-witness-oauth",
    "x-github-api-version": "2022-11-28",
  };
  const tok = process.env.GITHUB_PIN_TOKEN;
  if (tok) h.authorization = `Bearer ${tok}`;
  return h;
}

// Returns the file's current sha, or null if it doesn't exist yet.
async function getFileSha(path) {
  const r = await fetch(`${API}/repos/${USAGE_REPO}/contents/${path}?ref=${USAGE_BRANCH}`, {
    headers: ghHeaders(),
  });
  if (r.status === 404) return null;
  if (!r.ok) {
    console.error(`[oauth-store] GET ${path} -> ${r.status}`);
    throw new Error(`oauth store read failed (${r.status})`);
  }
  const body = await r.json();
  return body.sha;
}

// Commits `contentString` verbatim (already-stringified text/JSON) at
// `path`, creating or overwriting as needed.
async function putRaw(path, contentString, message) {
  const sha = await getFileSha(path);
  const payload = {
    message,
    branch: USAGE_BRANCH,
    content: Buffer.from(contentString, "utf-8").toString("base64"),
  };
  if (sha) payload.sha = sha;
  const r = await fetch(`${API}/repos/${USAGE_REPO}/contents/${path}`, {
    method: "PUT",
    headers: { ...ghHeaders(), "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!r.ok) {
    // Upstream body redacted from the thrown message on purpose (same
    // discipline as _store.js/_balance.js): a caller sees err.message
    // verbatim in a rendered failure page.
    const detail = await r.text().catch(() => "");
    console.error(`[oauth-store] PUT ${path} -> ${r.status}: ${detail.slice(0, 400)}`);
    const err = new Error(`oauth store write failed (${r.status})`);
    err.status = r.status;
    throw err;
  }
  return r.json();
}

module.exports = { USAGE_REPO, USAGE_BRANCH, getFileSha, putRaw };
