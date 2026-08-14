// _meter.js — native Node reimplementation of arcaeon-meter's behavior
// contract for the arcaeon-witness Vercel functions.
//
// arcaeon-meter (C:/Users/USER/arcaeon-meter) is Python + SQLite: keys
// hashed at rest, per-key monthly counts, check-then-increment inside a
// SQLite IMMEDIATE transaction so concurrent workers can't both take the
// last slot under the cap. This function runtime is Node serverless with
// no persistent disk and no shared process between invocations, so SQLite
// isn't available — the atomicity primitive here is the GitHub contents
// API's compare-and-swap (PUT with `sha` of the version you read; a stale
// sha 409s). Underscore prefix = not routed as a serverless function.
//
// Same denial vocabulary as arcaeon_meter.Denied.reason:
//   "over_cap"           monthly cap reached (used/cap filled in)
//   "no_cap_configured"  key resolves to no cap at all -> fails CLOSED,
//                        never silently unlimited
// (missing_key / unknown_key / revoked are witness-auth's job in pin.js,
// via WITNESS_KEYS -- this module is only reached after that already
// passed, so it never needs those reasons itself.)
//
// Storage: one JSON file per key-hash per month, in a PRIVATE GitHub repo
// (dan8433-user/arcaeon-witness-usage) -- never the public pin repo. Usage
// counts are not fingerprints; they don't belong in the public commit log.
//
// Residual race (documented, not hidden): the CAS loop re-reads the file,
// checks the cap against that fresh read, and writes with that read's sha
// -- one retry on a 409 (another writer won the race) with a freshly
// re-read sha. A THIRD simultaneous writer landing inside the retry's own
// window still 409s and the request fails outright (502) rather than
// silently dropping the count. Acceptable at Stage-0 traffic (a handful of
// pins/hour); the Stage-2 fix is a real KV (Vercel KV / Upstash) with an
// atomic INCR and no CAS loop at all.

"use strict";

const crypto = require("crypto");

const USAGE_REPO = process.env.GITHUB_USAGE_REPO || "dan8433-user/arcaeon-witness-usage";
const USAGE_BRANCH = process.env.GITHUB_USAGE_BRANCH || "main";
const API = "https://api.github.com";

// Built-in plan -> monthly cap defaults ("free" is the documented tier).
// `null` = explicit unlimited (still counted). A key's own WITNESS_PLANS
// entry may set its own monthly_cap and override this, same precedence as
// arcaeon_meter.Meter._resolve_cap: own cap wins, else plan default, else
// NO_CAP (fail closed).
const PLAN_CAPS = { free: 100, internal: null };
const NO_CAP = Symbol("no_cap_configured");

function ghHeaders() {
  const h = {
    accept: "application/vnd.github+json",
    "user-agent": "arcaeon-witness-meter",
    "x-github-api-version": "2022-11-28",
  };
  // Reuses GITHUB_PIN_TOKEN: the same dan8433-user PAT already granted to
  // this Vercel project, which has write access to both the public pins
  // repo and this private usage repo (both under the same account). No
  // second secret needed.
  const tok = process.env.GITHUB_PIN_TOKEN;
  if (tok) h.authorization = `Bearer ${tok}`;
  return h;
}

function keyHash(secret) {
  return crypto.createHash("sha256").update(secret, "utf8").digest("hex");
}

function utcMonth(d) {
  const now = d || new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

// ---- WITNESS_PLANS: JSON object keyed by sha256(key) -> {plan, monthly_cap?}
// monthly_cap may be `null` for explicit unlimited. Malformed/missing env
// never crashes a request -- it just means every key falls back to the
// built-in "free" plan.
function loadPlanOverrides() {
  const raw = process.env.WITNESS_PLANS || "{}";
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function resolveEntry(hash) {
  const overrides = loadPlanOverrides();
  return overrides[hash] || { plan: "free" };
}

function resolveCap(entry) {
  if (Object.prototype.hasOwnProperty.call(entry, "monthly_cap")) {
    return entry.monthly_cap; // may be null = explicit unlimited
  }
  const plan = entry.plan || "free";
  if (Object.prototype.hasOwnProperty.call(PLAN_CAPS, plan)) {
    return PLAN_CAPS[plan];
  }
  return NO_CAP;
}

function usagePath(hash, month) {
  return `usage/${hash}/${month}.json`;
}

async function getUsageFile(path) {
  const r = await fetch(
    `${API}/repos/${USAGE_REPO}/contents/${path}?ref=${USAGE_BRANCH}`,
    { headers: ghHeaders() }
  );
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`usage store GET ${path} -> ${r.status}`);
  const body = await r.json();
  const text = Buffer.from(body.content, "base64").toString("utf-8");
  return { json: JSON.parse(text), sha: body.sha };
}

async function putUsageFile(path, obj, message, sha) {
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
    const err = new Error(`usage store PUT ${path} -> 409 sha conflict`);
    err.conflict = true;
    throw err;
  }
  if (!r.ok) {
    const detail = await r.text().catch(() => "");
    // GitHub's *other* CAS-conflict shape: two concurrent writers both try
    // to CREATE the same not-yet-existing file (no sha to give). The loser
    // doesn't get 409 -- it gets 422 "sha wasn't supplied", because the
    // file now exists and an update requires one. Same race, different
    // status code; treat it the same as a 409 so the retry loop re-reads
    // and picks up the sha the winner just created.
    const isCreateRace = r.status === 422 && /sha.*wasn't supplied/i.test(detail);
    const err = new Error(`usage store PUT ${path} -> ${r.status} ${detail.slice(0, 200)}`);
    if (isCreateRace) err.conflict = true;
    throw err;
  }
  return r.json();
}

// ---- the verb ----
// check(secret) -> {ok:true, key_hash, plan, month, used, cap}
//               |  {ok:false, reason, key_hash, plan, month, used, cap}
//
// Call ONLY after the caller already authenticated the key against
// WITNESS_KEYS (missing/unknown/revoked are that layer's job, already a
// 401 upstream in pin.js). This function's own denial reasons are
// "no_cap_configured" (fail-closed) and "over_cap". A grant increments the
// month's usage by 1; a denial never does.
async function check(secret) {
  const month = utcMonth();
  const hash = keyHash(secret);
  const entry = resolveEntry(hash);
  const plan = entry.plan || "free";
  const cap = resolveCap(entry);

  if (cap === NO_CAP) {
    return { ok: false, reason: "no_cap_configured", key_hash: hash, plan, month, used: null, cap: null };
  }

  const path = usagePath(hash, month);
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const cur = await getUsageFile(path);
    const used = cur ? Number(cur.json.used) || 0 : 0;

    if (cap !== null && used + 1 > cap) {
      return { ok: false, reason: "over_cap", key_hash: hash, plan, month, used, cap };
    }

    const next = used + 1;
    try {
      await putUsageFile(
        path,
        { key_id: hash.slice(0, 12), month, used: next, plan, updated_at: new Date().toISOString() },
        `meter usage ${hash.slice(0, 12)} ${month} used=${next}`,
        cur ? cur.sha : undefined
      );
      return { ok: true, reason: null, key_hash: hash, plan, month, used: next, cap };
    } catch (err) {
      if (err.conflict && attempt === 0) {
        lastErr = err;
        continue; // one retry with a freshly re-read sha
      }
      throw err;
    }
  }
  throw lastErr || new Error("usage store: exhausted CAS retries");
}

module.exports = { check, keyHash, utcMonth, resolveCap, resolveEntry, PLAN_CAPS, USAGE_REPO, USAGE_BRANCH };
