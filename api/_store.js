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

// GET a file via the contents API as raw text (no JSON.parse). Used for the
// anchor .txt files, which are plain "<sha> <iso-timestamp>", not JSON.
// Returns {text, sha} or null on 404.
async function getRawFile(path) {
  const r = await fetch(
    `${API}/repos/${REPO}/contents/${path}?ref=${BRANCH}`,
    { headers: ghHeaders() }
  );
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`github GET ${path} -> ${r.status}`);
  const body = await r.json();
  return { text: Buffer.from(body.content, "base64").toString("utf-8"), sha: body.sha };
}

// List entries of a directory via the contents API. Returns [] for a
// missing/empty directory rather than throwing — callers (the status page)
// treat "nothing pinned/observed/anchored yet" as a legitimate state, not
// an error condition.
async function listDir(path) {
  const r = await fetch(
    `${API}/repos/${REPO}/contents/${path}?ref=${BRANCH}`,
    { headers: ghHeaders() }
  );
  if (r.status === 404) return [];
  if (!r.ok) throw new Error(`github GET ${path} -> ${r.status}`);
  const body = await r.json();
  return Array.isArray(body) ? body : [];
}

// Full recursive tree of the pin repo (one call, {path, type} per entry).
// Used by the status page to count files under observations/ without one
// contents-API call per namespace subdirectory.
async function getTree() {
  const r = await fetch(
    `${API}/repos/${REPO}/git/trees/${BRANCH}?recursive=1`,
    { headers: ghHeaders() }
  );
  if (!r.ok) throw new Error(`github GET tree -> ${r.status}`);
  const body = await r.json();
  return Array.isArray(body.tree) ? body.tree : [];
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
//
// AUTH HONESTY (Stage-0). Every write path in this service — pin AND renewal —
// is authorized by a bearer key and nothing else. That is weaker than what a
// relying party might assume the word "owner" implies, so the weakness is
// stamped into the record and into every write response rather than left to
// be discovered. See README "Auth honesty" for the Stage-1 plan.
const AUTH_LEVEL = "bearer-stage0";
const AUTH_LEVEL_NOTE =
  "Bearer-key auth only. This is NOT owner-signature auth: the witness verifies " +
  "that the caller holds a key bound to this namespace prefix, not that the log's " +
  "owner authorized this record. Anyone who obtains the key can pin or renew. " +
  "Owner-signature auth — a detached signature over {namespace, rows, chain, " +
  "timestamp} verified against a public key registered to the namespace — is the " +
  "Stage-1 requirement and is NOT built yet. Read publisher_heartbeat_current as " +
  "proof that a key-holder was alive and asserting, never as proof of the log " +
  "owner's intent.";

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

// ---- renewal / interval history (excelsior's invariants, 2026-08-14) ----
//
// A namespace whose log genuinely stops changing used to go permanently
// overdue: the idempotent re-pin branch returned the stored pin untouched, so
// the deadline only ever moved when rows advanced. "Still here, nothing new"
// had no way to be said. Renewal says it — and the whole design problem is
// that renewal must not be launderable into "and everything is fine."
//
// excelsior's invariants, implemented here once and used by BOTH the
// content-advance path and the renewal path so the two can't drift apart:
//   (1) a missed deadline is RETAINED forever — no later write of any kind,
//       renewal or advance, erases the fact that a deadline passed unmet;
//   (2) a new deadline is an APPENDED interval object, never a rewrite of the
//       old one — the superseded window stays readable in the record;
//   (3) a renewal is TYPED differently from a content advance in the record
//       itself (`record_kind`), so no downstream reader can conflate a
//       publisher heartbeat with the head actually moving.
const MAX_INLINE_HISTORY = 20;

// Returns {fields, wasOverdue, missedDueAt, interval} for a record about to be
// written. `prev` is the previous latest.json object (or null for a namespace's
// first pin). Nothing here invents a deadline for a record that never had one.
function appendInterval(prev, { now, seq, cadenceHours, dueBy, kind }) {
  const prevDueRaw =
    prev && typeof prev.next_pin_due_by === "string" ? prev.next_pin_due_by : null;
  const prevDueMs = prevDueRaw ? Date.parse(prevDueRaw) : NaN;
  const wasOverdue = Number.isFinite(prevDueMs) && now.getTime() >= prevDueMs;

  // --- intervals: append, never rewrite ---
  let intervals = prev && Array.isArray(prev.intervals) ? prev.intervals.slice() : [];
  let intervalsTotal =
    prev && Number.isInteger(prev.intervals_total) ? prev.intervals_total : intervals.length;
  if (!intervals.length && prevDueRaw && Number.isInteger(prev.seq)) {
    // Seed the series from the previous record's OWN stored values — a
    // restatement of what that record already said, not a backfilled deadline
    // for a pin that never made one. Records written before this build have no
    // `intervals` array; without this the window they DID declare would vanish
    // from the record the moment the next one supersedes it.
    intervals.push({
      seq: prev.seq,
      kind: prev.record_kind === "publisher_heartbeat" ? "publisher_heartbeat" : "content_head_advance",
      opened_at: prev.pinned_at || null,
      cadence_hours: Number.isFinite(prev.cadence_hours) ? prev.cadence_hours : null,
      due_by: prevDueRaw,
      reconstructed_from: "prior latest.json record (values as stored, not inferred)",
    });
    intervalsTotal = intervals.length;
  }
  const interval = {
    seq,
    kind,
    opened_at: now.toISOString(),
    cadence_hours: cadenceHours,
    due_by: dueBy,
    supersedes_due_by: prevDueRaw,
    superseded_deadline_was_missed: wasOverdue,
  };
  if (prev && !prevDueRaw) {
    interval.note =
      "prior record carried no deadline (legacy, ungradeable); this interval is forward-looking only — no past window is claimed graded";
  }
  intervals.push(interval);
  intervalsTotal += 1;

  // --- missed deadlines: sticky, append-only, never erased ---
  const missed = prev && Array.isArray(prev.missed_deadlines) ? prev.missed_deadlines.slice() : [];
  let missedCount =
    prev && Number.isInteger(prev.missed_deadline_count) ? prev.missed_deadline_count : missed.length;
  let firstMissed = prev && typeof prev.first_missed_due_at === "string" ? prev.first_missed_due_at : null;
  // carried forward even when THIS write missed nothing: a renewal that lands
  // on time never erases an earlier miss.
  let missedDueAt = prev && typeof prev.missed_due_at === "string" ? prev.missed_due_at : null;
  if (wasOverdue) {
    missed.push({
      due_at: prevDueRaw,
      observed_at: now.toISOString(),
      overdue_by_seconds: Math.floor((now.getTime() - prevDueMs) / 1000),
      closed_by: kind,
      seq,
    });
    missedCount += 1;
    missedDueAt = prevDueRaw;
    if (!firstMissed) firstMissed = prevDueRaw;
  }

  const fields = {
    intervals: intervals.slice(-MAX_INLINE_HISTORY),
    intervals_total: intervalsTotal,
    ever_missed_deadline: missedCount > 0,
    missed_deadline_count: missedCount,
    missed_deadlines: missed.slice(-MAX_INLINE_HISTORY),
  };
  if (missedDueAt) fields.missed_due_at = missedDueAt;
  if (firstMissed) fields.first_missed_due_at = firstMissed;
  if (intervalsTotal > fields.intervals.length || missedCount > fields.missed_deadlines.length) {
    fields.history_note =
      `only the most recent ${MAX_INLINE_HISTORY} entries are inlined here; the complete series is the per-seq record history in the public pin repo`;
  }
  // "this namespace was once ungradeable" survives forever, so a renewal can't
  // launder a legacy gap into a clean graded record.
  if (prev && (prev.had_ungradeable_history === true || !prevDueRaw)) {
    fields.had_ungradeable_history = true;
  }
  return { fields, wasOverdue, missedDueAt: wasOverdue ? prevDueRaw : null, interval };
}

module.exports = {
  REPO,
  BRANCH,
  getFile,
  getRawFile,
  putFile,
  listDir,
  getTree,
  repoReachable,
  keyPrefixFor,
  validatePin,
  NS_RE,
  resolveCadenceHours,
  DEFAULT_CADENCE_HOURS,
  appendInterval,
  MAX_INLINE_HISTORY,
  AUTH_LEVEL,
  AUTH_LEVEL_NOTE,
};
