// _keys.js — DYNAMICALLY ISSUED witness keys + Stripe-fulfillment bindings.
// Underscore prefix = not routed as a serverless function by Vercel.
//
// WHY THIS EXISTS (2026-08-17, board item 25 — instant fulfillment): until
// now every witness key lived in the WITNESS_KEYS env var, hand-provisioned.
// An env var cannot be appended to by a serverless function at runtime, so
// self-serve purchase ("pay Stripe, get a key on the receipt page") requires
// a real key store. This is that store — the MINIMAL one, deliberately built
// on the exact same primitive every other stateful module here already uses:
// JSON files in the PRIVATE usage repo (dan8433-user/arcaeon-witness-usage),
// GitHub contents API, create-only / compare-and-swap writes. Nothing new to
// operate, same GITHUB_PIN_TOKEN, same audit-by-git-history property as
// _meter.js and _balance.js.
//
// Files this module owns (all in the PRIVATE usage repo — never the public
// pin repo; a raw key or a billing hash must never land in public git):
//
//   keys/<sha256(key)>.json          issued-key record: namespace prefix the
//                                    key may pin under, plan, org, pool_id.
//                                    api/pin.js + api/balance.js consult this
//                                    AFTER the WITNESS_KEYS env lookup misses,
//                                    so env-provisioned keys are untouched.
//   fulfillments/<session_id>.json   Stripe Checkout session -> key binding.
//                                    CREATE-ONLY: this file is the idempotency
//                                    gate that guarantees one session never
//                                    mints two keys. It stores the RAW key on
//                                    purpose — the whole point of the receipt
//                                    page is that revisiting it re-shows the
//                                    same key (Stripe's receipt email links
//                                    back to it), and you cannot re-show what
//                                    you only kept a hash of. The session URL
//                                    is already a bearer of the key by design,
//                                    so a private-repo copy adds no new
//                                    exposure class beyond what the product
//                                    promise itself requires.
//   pools/<pool_id>.json             credit-pool record (org/team schema,
//                                    baked in now, UI later — see below).
//
// ORG / POOL SCHEMA (schema now, UI later): every issued key carries
// `org` (nullable) and `pool_id`. Credits conceptually live on the POOL.
// For a solo purchase — the only flow wired today — the pool is a
// single-key pool whose `credit_account` IS the key's own sha256 hash, so
// the pool's balance file is exactly the balance/<key_hash>.json that
// api/_balance.js already reads and decrements: no change to the live
// billing path. TEAM FLOW (future): N issued-key records share one
// pool_id; the pool's credit_account becomes a pool-scoped identifier and
// api/pin.js's charge path resolves key -> issued-key record -> pool_id ->
// credit_account before calling decrementCredit, so N keys draw down one
// shared balance. That resolution hop is NOT built (solo pools don't need
// it); the fields exist now so no schema migration is needed when it is.

"use strict";

const crypto = require("crypto");

const USAGE_REPO = process.env.GITHUB_USAGE_REPO || "dan8433-user/arcaeon-witness-usage";
const USAGE_BRANCH = process.env.GITHUB_USAGE_BRANCH || "main";
const API = "https://api.github.com";

// Stripe Checkout session ids are `cs_test_...` / `cs_live_...`, alphanumeric.
// Anchored + charset-limited so a session id is path-safe by construction —
// this is what lets fulfillments/<session_id>.json use the id verbatim with
// zero traversal risk, and it doubles as the first "faked URL" rejection.
const SESSION_ID_RE = /^cs_(test|live)_[A-Za-z0-9]{8,240}$/;

function ghHeaders() {
  const h = {
    accept: "application/vnd.github+json",
    "user-agent": "arcaeon-witness-keys",
    "x-github-api-version": "2022-11-28",
  };
  const tok = process.env.GITHUB_PIN_TOKEN;
  if (tok) h.authorization = `Bearer ${tok}`;
  return h;
}

// Same gh get/put pair as _meter.js/_balance.js. Duplicated rather than
// imported on purpose — each stateful module here carries its own copy so its
// error redaction and logging tag stay legible by inspection (the established
// house pattern; see _balance.js which did the same next to _meter.js).
async function getFile(path) {
  const r = await fetch(
    `${API}/repos/${USAGE_REPO}/contents/${path}?ref=${USAGE_BRANCH}`,
    { headers: ghHeaders() }
  );
  if (r.status === 404) return null;
  if (!r.ok) {
    // Path redacted from thrown messages (2026-08-14 audit discipline):
    // callers interpolate err.message into response bodies, and these paths
    // name key hashes / session ids in a PRIVATE repo.
    console.error(`[keys] GET ${path} -> ${r.status}`);
    throw new Error(`key store read failed (${r.status})`);
  }
  const body = await r.json();
  const text = Buffer.from(body.content, "base64").toString("utf-8");
  return { json: JSON.parse(text), sha: body.sha };
}

async function putFile(path, obj, message, sha) {
  const payload = {
    message,
    branch: USAGE_BRANCH,
    content: Buffer.from(JSON.stringify(obj, null, 2) + "\n").toString("base64"),
  };
  if (sha) payload.sha = sha;
  const r = await fetch(`${API}/repos/${USAGE_REPO}/contents/${path}`, {
    method: "PUT",
    headers: { ...ghHeaders(), "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (r.status === 409) {
    console.error(`[keys] PUT ${path} -> 409 sha conflict`);
    const err = new Error("key store write conflict (concurrent writer)");
    err.conflict = true;
    throw err;
  }
  if (!r.ok) {
    const detail = await r.text().catch(() => "");
    // GitHub's create-race shape (two writers both tried to CREATE the same
    // not-yet-existing file) — same tagging idiom as _store/_meter/_balance.
    const isCreateRace = r.status === 422 && /sha.*wasn't supplied/i.test(detail);
    console.error(`[keys] PUT ${path} -> ${r.status}: ${detail.slice(0, 400)}`);
    const err = new Error(`key store write failed (${r.status})`);
    if (isCreateRace) err.conflict = true;
    throw err;
  }
  return r.json();
}

// ---- minting ----
// wk_ prefix so an issued key is recognizable in support conversations
// without revealing anything; 24 random bytes = 192 bits, hex-encoded.
function mintKey() {
  return "wk_" + crypto.randomBytes(24).toString("hex");
}

// The namespace prefix an issued key may pin under. Random and DERIVED FROM
// NOTHING — deliberately not a slice of the key hash: sha256(key) is the
// billing identifier (client_reference_id, balance file names) and the public
// pin repo must never carry any recognizable piece of it (_store.js's
// OWNER_ID_DOMAIN comment states the rule). Matches _store.NS_RE by
// construction ([a-z0-9-], well under 64 chars, leaving the buyer room for a
// suffix like "prod" or "agent-7").
function mintNamespacePrefix() {
  return `wk-${crypto.randomBytes(6).toString("hex")}-`;
}

function mintPoolId() {
  return `pool_${crypto.randomBytes(8).toString("hex")}`;
}

function keyHash(secret) {
  return crypto.createHash("sha256").update(secret, "utf8").digest("hex");
}

// ---- paths ----
function issuedKeyPath(hash) {
  return `keys/${hash}.json`;
}
function poolPath(poolId) {
  return `pools/${poolId}.json`;
}
function fulfillmentPath(sessionId) {
  return `fulfillments/${sessionId}.json`;
}

// ---- issued-key auth resolution ----
// The dynamic half of what _store.keyPrefixFor does for env keys. Returns the
// key's namespace prefix (string) or null for an unknown/revoked key. Callers
// (pin.js, balance.js) try the env lookup FIRST — it's free and covers every
// hand-provisioned key — and only reach here on a miss, so env-key requests
// cost zero extra store reads. Fails CLOSED on a malformed record: a key file
// without a usable prefix authorizes nothing.
async function issuedKeyPrefix(secret) {
  if (!secret) return null;
  const rec = await getFile(issuedKeyPath(keyHash(secret)));
  if (!rec) return null;
  if (rec.json && rec.json.revoked === true) return null;
  const prefix = rec.json && typeof rec.json.namespace_prefix === "string"
    ? rec.json.namespace_prefix.trim()
    : "";
  // Same empty-prefix refusal as _store.keyPrefixFor: "" would startsWith-match
  // every namespace, and a malformed record must never widen authorization.
  return prefix ? prefix : null;
}

// ---- fulfillment binding (the session -> key idempotency record) ----
async function readFulfillment(sessionId) {
  return getFile(fulfillmentPath(sessionId));
}

// Create-only. Returns {created:true, record} if this call won the slot, or
// {created:false, record} with the WINNER's record if a concurrent visit (or a
// prior one) already bound this session — the caller must then serve the
// winner's key and throw its own freshly-minted one away (never minted twice
// for one session, even under a race: the create-only CAS is the guarantee).
async function createFulfillment(sessionId, record) {
  try {
    await putFile(
      fulfillmentPath(sessionId),
      record,
      `fulfill ${sessionId.slice(0, 24)} pack=${record.pack}`
    );
    return { created: true, record };
  } catch (err) {
    if (!err.conflict) throw err;
    const cur = await getFile(fulfillmentPath(sessionId));
    if (!cur) throw err; // conflict but nothing readable — surface the error
    return { created: false, record: cur.json };
  }
}

// Small CAS update loop for mutating an existing fulfillment record (consent
// capture). Best-effort semantics decided by the caller; this just does the
// read-modify-write honestly. Returns the updated record.
async function updateFulfillment(sessionId, mutate) {
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const cur = await getFile(fulfillmentPath(sessionId));
    if (!cur) return null;
    const next = mutate({ ...cur.json });
    try {
      await putFile(
        fulfillmentPath(sessionId),
        next,
        `fulfill update ${sessionId.slice(0, 24)}`,
        cur.sha
      );
      return next;
    } catch (err) {
      if (err.conflict && attempt === 0) {
        lastErr = err;
        continue;
      }
      throw err;
    }
  }
  throw lastErr || new Error("key store: exhausted CAS retries on fulfillment update");
}

// Create-only writes for the key + pool records. A conflict here means a
// concurrent request for the SAME session already wrote them (both derive from
// the same fulfillment record), so it is idempotent success, not an error.
async function writeIssuedKey(record) {
  try {
    await putFile(
      issuedKeyPath(record.key_hash),
      record,
      `issue key ${record.key_hash.slice(0, 12)} (${record.source})`
    );
  } catch (err) {
    if (!err.conflict) throw err;
  }
}

async function writePool(record) {
  try {
    await putFile(poolPath(record.pool_id), record, `pool ${record.pool_id}`);
  } catch (err) {
    if (!err.conflict) throw err;
  }
}

module.exports = {
  SESSION_ID_RE,
  mintKey,
  mintNamespacePrefix,
  mintPoolId,
  keyHash,
  issuedKeyPath,
  poolPath,
  fulfillmentPath,
  issuedKeyPrefix,
  readFulfillment,
  createFulfillment,
  updateFulfillment,
  writeIssuedKey,
  writePool,
  USAGE_REPO,
  USAGE_BRANCH,
  // exported for tests:
  getFile,
};
