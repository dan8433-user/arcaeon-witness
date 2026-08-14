// _store.js — the GitHub-repo backing store for the Arcaeon hosted witness.
// Underscore prefix = not routed as a serverless function by Vercel.
//
// Every pin lands as a commit in a PUBLIC repo. The commit history IS the
// tamper-evidence: commits are third-party-timestamped by GitHub, publicly
// readable, and any rewrite of history is visible. Pins hold fingerprints
// ONLY ({namespace, rows, chain, pinned_at}) — never log content.

"use strict";

const REPO = process.env.GITHUB_PIN_REPO || "dan8433-user/arcaeon-witness-pins";
const BRANCH = process.env.GITHUB_PIN_BRANCH || "main";
const API = "https://api.github.com";

function ghHeaders() {
  const h = {
    accept: "application/vnd.github+json",
    "user-agent": "arcaeon-witness",
    "x-github-api-version": "2022-11-28",
  };
  const tok = process.env.GITHUB_PIN_TOKEN;
  if (tok) h.authorization = `Bearer ${tok}`;
  return h;
}

// GET a file via the contents API. Returns {json, sha} or null on 404.
async function getFile(path) {
  const r = await fetch(
    `${API}/repos/${REPO}/contents/${path}?ref=${BRANCH}`,
    { headers: ghHeaders() }
  );
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`github GET ${path} -> ${r.status}`);
  const body = await r.json();
  const text = Buffer.from(body.content, "base64").toString("utf-8");
  return { json: JSON.parse(text), sha: body.sha };
}

// PUT (create or update) a file via the contents API — one commit per call.
async function putFile(path, obj, message, sha) {
  const payload = {
    message,
    branch: BRANCH,
    content: Buffer.from(JSON.stringify(obj, null, 2) + "\n").toString("base64"),
  };
  if (sha) payload.sha = sha;
  const r = await fetch(`${API}/repos/${REPO}/contents/${path}`, {
    method: "PUT",
    headers: { ...ghHeaders(), "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!r.ok) {
    const detail = await r.text().catch(() => "");
    throw new Error(`github PUT ${path} -> ${r.status} ${detail.slice(0, 200)}`);
  }
  return r.json();
}

// Live reachability check for /api/health.
async function repoReachable() {
  try {
    const r = await fetch(`${API}/repos/${REPO}`, { headers: ghHeaders() });
    return r.ok;
  } catch {
    return false;
  }
}

// ---- auth: WITNESS_KEYS = comma-separated "key:namespace-prefix" pairs ----
// A key may only pin namespaces starting with its prefix.
function keyPrefixFor(bearerKey) {
  const raw = process.env.WITNESS_KEYS || "";
  for (const pair of raw.split(",")) {
    const i = pair.indexOf(":");
    if (i < 1) continue;
    const key = pair.slice(0, i).trim();
    const prefix = pair.slice(i + 1).trim();
    if (key && key === bearerKey) return prefix;
  }
  return null;
}

// ---- validation (mirrors the arcaeon_ledger client's Head semantics) ----
const NS_RE = /^[a-z0-9-]{1,64}$/;
const CHAIN_RE = /^[0-9a-fA-F]{8,64}$/;

function validatePin(body) {
  if (!body || typeof body !== "object") return "body must be a JSON object";
  if (typeof body.namespace !== "string" || !NS_RE.test(body.namespace))
    return "namespace must match [a-z0-9-]{1,64}";
  if (!Number.isInteger(body.rows) || body.rows < 1)
    return "rows must be a positive integer";
  if (typeof body.chain !== "string" || !CHAIN_RE.test(body.chain))
    return "chain must be a hex string of 8-64 chars";
  return null;
}

// ---- cadence: how often a namespace PROMISES to pin (excelsior's review) ----
// A pin's deadline is a promise, not a proof — it makes a missed cadence
// VISIBLE to a stranger polling /api/latest, it does not prove tampering.
// Default 24h for every namespace; WITNESS_CADENCE overrides per
// namespace-PREFIX (JSON: {"<prefix>": <hours>}), longest-matching-prefix
// wins (same shape as WITNESS_KEYS's prefix binding, but many-to-one, so
// there's no single "the" prefix to key off of the way an auth key has one).
const DEFAULT_CADENCE_HOURS = 24;

function resolveCadenceHours(namespace) {
  const raw = process.env.WITNESS_CADENCE || "{}";
  let map;
  try {
    const parsed = JSON.parse(raw);
    map = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    map = {};
  }
  let best = null; // {prefix, hours}
  for (const [prefix, hours] of Object.entries(map)) {
    if (!namespace.startsWith(prefix)) continue;
    const h = Number(hours);
    if (!Number.isFinite(h) || h <= 0) continue; // malformed entries are ignored, not fatal
    if (best === null || prefix.length > best.prefix.length) best = { prefix, hours: h };
  }
  return best ? best.hours : DEFAULT_CADENCE_HOURS;
}

module.exports = {
  REPO,
  BRANCH,
  getFile,
  putFile,
  repoReachable,
  keyPrefixFor,
  validatePin,
  NS_RE,
  resolveCadenceHours,
  DEFAULT_CADENCE_HOURS,
};
