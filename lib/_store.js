// _store.js — the GitHub-repo backing store for the Arcaeon hosted witness.
// Underscore prefix = not routed as a serverless function by Vercel.
//
// Every pin lands as a commit in a PUBLIC repo. The commit history is public,
// and a rewrite of it is visible to anyone who cloned or watched the repo before
// the rewrite. A commit's date is the operator's own statement, not a third
// party's: git records whatever time the committing client wrote, these commits
// are made by the operator's account, and they are not signed. The independent
// evidence of time is the daily OpenTimestamps (Bitcoin) anchor. Pins hold fingerprints
// ONLY ({namespace, rows, chain, pinned_at}) — never log content.

"use strict";

const crypto = require("crypto");

const REPO = process.env.GITHUB_PIN_REPO || "dan8433-user/arcaeon-witness-pins";
const BRANCH = process.env.GITHUB_PIN_BRANCH || "main";
const API = "https://api.github.com";

// ---- TARGETS: which repo, which branch, which token (2026-09-20) ----
//
// Every read/write below used to be hardwired to the pin repo's three
// constants. lib/_stamp_store.js needs the SAME contents-API behaviour — in
// particular the measured 409 retry in putFile, which is subtle enough that a
// second hand-copy of it would be a second implementation with no parity
// mechanism — pointed at a DIFFERENT repo and a DIFFERENT token.
//
// So the primitives take a `target` as their LAST argument, defaulting to the
// pin repo. Every existing caller is byte-for-byte unaffected; a new store
// passes its own target, or calls forTarget() once and gets the bound set.
//
// The token is named by ENV VAR, not passed as a value, on purpose: it is then
// read at call time from the same place it always was, so nothing here caches
// a secret, and a target can never be constructed carrying a token literal
// that some log line might print.
const PINS_TARGET = Object.freeze({
  repo: REPO,
  branch: BRANCH,
  tokenEnv: "GITHUB_PIN_TOKEN",
  ua: "arcaeon-witness",
});

function ghHeaders(target = PINS_TARGET) {
  const h = {
    accept: "application/vnd.github+json",
    "user-agent": target.ua || "arcaeon-witness",
    "x-github-api-version": "2022-11-28",
  };
  // A target that is not the pins target MUST name its own token env var. The
  // old `target.tokenEnv || "GITHUB_PIN_TOKEN"` would have let a half-built
  // target borrow the paid side's token silently (review, 2026-09-20).
  if (target !== PINS_TARGET && !target.tokenEnv) {
    throw new Error("store target has no tokenEnv; refusing to fall back to the pin token");
  }
  const tok = process.env[target.tokenEnv];
  if (tok) h.authorization = `Bearer ${tok}`;
  return h;
}

// GET a file via the contents API. Returns {json, sha} or null on 404.
async function getFile(path, target = PINS_TARGET) {
  const { repo: REPO, branch: BRANCH } = target;
  const r = await fetch(
    `${API}/repos/${REPO}/contents/${path}?ref=${BRANCH}`,
    { headers: ghHeaders(target) }
  );
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`github GET ${path} -> ${r.status}`);
  const body = await r.json();
  const text = Buffer.from(body.content, "base64").toString("utf-8");
  return { json: JSON.parse(text), sha: body.sha };
}

// ---- the 409 retry (task 093, 2026-09-13 — measured, not theorized) ----
//
// tools/ceiling_probe.js measured this live against a scratch repo: ten
// concurrent writers on one branch issued 532 requests and took **465 409s**,
// and every one of those writers was creating its OWN distinct file. Nothing
// raced for a path — the BRANCH REF moved under each PUT ("is at X but
// expected Y"). A PUT that loses that race is not a semantic conflict at all,
// and putFile dropping it on the floor is why two overlapping serverless pins
// lose one. Production runs on instances that overlap, so this was live.
//
// The retry therefore distinguishes the two 409s by RE-READING the path:
//
//   the file is UNCHANGED since the caller read it  -> branch-ref contention.
//       Re-PUT the caller's object verbatim with the same sha. Nothing is
//       overwritten because nothing moved. This is the measured case.
//
//   the file HAS MOVED                              -> another writer owns
//       this path now. A blind re-PUT would erase that writer's row, so it is
//       never done. The caller's `rebuild` hook (opts.rebuild) is handed the
//       FRESH json and decides what to write on top of it; returning null
//       abandons the write (a legitimate outcome — see api/pin.js's latest
//       pointer). With no hook the call fails typed, and `err.conflict` stays
//       true, so every pre-existing caller behaves exactly as it did before.
//
// Backoff is ours to invent: the probe found the secondary limit is a short
// burst allowance that refills in ~16 s and carries **no Retry-After header**,
// so there is no server hint to honour. ~1 s base, doubling, jittered
// 0.5x-1.5x, four attempts total (worst case ~10 s of waiting, inside the
// measured recovery window).
//
// `sleep`/`jitter` are hooks, not config: the test suite swaps them so a
// retry regression runs in milliseconds. Nothing in production sets them.
const PUT_RETRY = {
  maxAttempts: 4,
  baseDelayMs: 1000,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  jitter: () => 0.5 + Math.random(),
};

function putRetryDelayMs(attempt) {
  // the wait BEFORE attempt+1; `attempt` is 1-based
  return Math.round(PUT_RETRY.baseDelayMs * Math.pow(2, attempt - 1) * PUT_RETRY.jitter());
}

// One PUT. Never throws on an HTTP error — returns the shape so the retry
// loop above it can decide, and so the error body is read exactly once.
async function putOnce(path, obj, message, sha, target = PINS_TARGET) {
  const { repo: REPO, branch: BRANCH } = target;
  const payload = {
    message,
    branch: BRANCH,
    content: Buffer.from(JSON.stringify(obj, null, 2) + "\n").toString("base64"),
  };
  if (sha) payload.sha = sha;
  const r = await fetch(`${API}/repos/${REPO}/contents/${path}`, {
    method: "PUT",
    headers: { ...ghHeaders(target), "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (r.ok) return { ok: true, body: await r.json() };
  return { ok: false, status: r.status, detail: await r.text().catch(() => "") };
}

// PUT (create or update) a file via the contents API — one commit per call.
// Retries a 409 per the header above. On success the returned object carries
// `attempts`, so a pin that took three tries can say so instead of reporting
// a clean single write. There is no fabricated success anywhere in here: a
// budget that runs out throws, and an abandoned write says `abandoned:true`.
async function putFile(path, obj, message, sha, opts = {}, target = PINS_TARGET) {
  const rebuild = opts && typeof opts.rebuild === "function" ? opts.rebuild : null;
  let body = obj;
  let curSha = sha;
  let last = null;
  let attempts = 0;
  let moved = false;

  while (attempts < PUT_RETRY.maxAttempts) {
    attempts += 1;
    const r = await putOnce(path, body, message, curSha, target);
    if (r.ok) {
      const out = r.body && typeof r.body === "object" ? r.body : {};
      out.attempts = attempts;
      return out;
    }
    last = r;
    // The upstream body goes to the SERVER LOG, never into the thrown message.
    // Handlers interpolate err.message straight into a 502 response body, and
    // GitHub's error bodies carry backend URLs and request context that a
    // caller has no business reading (2026-08-14 audit finding: a concurrent
    // pin storm returned GitHub's raw 422 body to the client verbatim).
    console.error(
      `[store] PUT ${path} -> ${r.status} (attempt ${attempts}/${PUT_RETRY.maxAttempts}): ${r.detail.slice(0, 400)}`
    );
    if (r.status !== 409 || attempts >= PUT_RETRY.maxAttempts) break;

    await PUT_RETRY.sleep(putRetryDelayMs(attempts));

    // Re-read to tell branch-ref contention from a path that actually moved.
    // A re-GET that itself fails is not a licence to guess: stop and report
    // the 409 we already have.
    let fresh;
    try {
      fresh = await getFile(path, target);
    } catch {
      break;
    }
    const freshSha = fresh ? fresh.sha : null;
    if ((freshSha || null) === (curSha || null)) continue; // nothing moved — re-PUT verbatim

    moved = true;
    if (!rebuild) break; // never blind-overwrite another writer's row
    const next = await rebuild(fresh ? fresh.json : null, freshSha);
    if (next === null || next === undefined) {
      return {
        abandoned: true,
        attempts,
        fresh: fresh ? fresh.json : null,
        fresh_sha: freshSha,
      };
    }
    body = next;
    curSha = freshSha;
    moved = false;
  }

  const err = new Error(`github PUT ${path} -> ${last.status}`);
  err.status = last.status;
  err.attempts = attempts;
  // GitHub's create-race shape: two writers both tried to CREATE the same
  // not-yet-existing file, so the loser is told a sha is required. Tagged
  // here (same idiom as api/_meter.js) so callers can name the condition
  // instead of surfacing a bare store error.
  err.conflict = last.status === 409 || (last.status === 422 && /sha.*wasn't supplied/i.test(last.detail));
  // `stale` narrows `conflict`: the path moved under us and no rebuild hook
  // was offered, so the write was refused rather than allowed to clobber.
  if (moved) err.stale = true;
  throw err;
}

// GET a file via the contents API as raw text (no JSON.parse). Used for the
// anchor .txt files, which are plain "<sha> <iso-timestamp>", not JSON.
// Returns {text, sha} or null on 404.
async function getRawFile(path, target = PINS_TARGET) {
  const { repo: REPO, branch: BRANCH } = target;
  const r = await fetch(
    `${API}/repos/${REPO}/contents/${path}?ref=${BRANCH}`,
    { headers: ghHeaders(target) }
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
async function listDir(path, target = PINS_TARGET) {
  const { repo: REPO, branch: BRANCH } = target;
  const r = await fetch(
    `${API}/repos/${REPO}/contents/${path}?ref=${BRANCH}`,
    { headers: ghHeaders(target) }
  );
  if (r.status === 404) return [];
  if (!r.ok) throw new Error(`github GET ${path} -> ${r.status}`);
  const body = await r.json();
  return Array.isArray(body) ? body : [];
}

// Full recursive tree of the pin repo (one call, {path, type} per entry).
// Used by the status page to count files under observations/ without one
// contents-API call per namespace subdirectory.
async function getTree(target = PINS_TARGET) {
  const { repo: REPO, branch: BRANCH } = target;
  const r = await fetch(
    `${API}/repos/${REPO}/git/trees/${BRANCH}?recursive=1`,
    { headers: ghHeaders(target) }
  );
  if (!r.ok) throw new Error(`github GET tree -> ${r.status}`);
  const body = await r.json();
  return Array.isArray(body.tree) ? body.tree : [];
}

// The same call as getTree, plus the one field getTree drops: GitHub sets
// `truncated: true` when the recursive tree was too large to return whole.
// getTree's callers (the status page) are counting, and a short count is a
// cosmetic wrong number. A RECONCILER is not counting — it is deciding whether
// a leaf appears nowhere, and "I did not see the file" and "the file is not
// there" are the two answers it must never merge. So the flag is surfaced
// here rather than inferred, and tools/reconcile_batches.js turns it into
// "could not look" instead of "clean".
// Same call as getTree, but keeps `truncated` — the field that lets
// tools/reconcile_batches.js say "could not look" instead of "clean".
// Takes the target like every other primitive here (release candidate,
// 2026-09-20): this function and the target refactor arrived on branches
// that forked apart, and git merged both without either noticing the
// other. It defaulted to the pins repo by reading module-level constants,
// which was the right repo by luck rather than by construction and left it
// out of forTarget()'s bound set. See test/store_target_no_borrow.test.js.
async function getTreeMeta(target = PINS_TARGET) {
  const { repo: REPO, branch: BRANCH } = target;
  const r = await fetch(
    `${API}/repos/${REPO}/git/trees/${BRANCH}?recursive=1`,
    { headers: ghHeaders(target) }
  );
  if (!r.ok) throw new Error(`github GET tree -> ${r.status}`);
  const body = await r.json();
  return {
    entries: Array.isArray(body.tree) ? body.tree : [],
    truncated: body.truncated === true,
  };
}

// Live reachability check for /api/health.
async function repoReachable(target = PINS_TARGET) {
  try {
    const r = await fetch(`${API}/repos/${target.repo}`, { headers: ghHeaders(target) });
    return r.ok;
  } catch {
    return false;
  }
}

// The five primitives, bound to one target. A store module that owns a
// different repo (lib/_stamp_store.js) calls this once instead of threading
// the target through every call site — and, more importantly, instead of
// carrying its own copy of putFile's 409 retry.
function forTarget(target) {
  return {
    target,
    getFile: (path) => getFile(path, target),
    getRawFile: (path) => getRawFile(path, target),
    listDir: (path) => listDir(path, target),
    getTree: () => getTree(target),
    getTreeMeta: () => getTreeMeta(target),
    putFile: (path, obj, message, sha, opts) => putFile(path, obj, message, sha, opts || {}, target),
    repoReachable: () => repoReachable(target),
  };
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

// LEGACY FALLBACK — frozen literals, never the live constants above.
// Records written before the auth stamp existed carry no `auth_level` field.
// Falling back to the CURRENT constant would silently upgrade every one of them
// the day AUTH_LEVEL becomes "owner-signature" — the exact retroactive rewrite
// README "Auth honesty" publicly promises will not happen ("every record written
// before then says bearer-stage0 in its own text"). Unstamped records were
// bearer-era, so they get the bearer-era value as a LITERAL that does not move
// when the constant does. Do not refactor these to reference AUTH_LEVEL.
const LEGACY_AUTH_LEVEL = "bearer-stage0";
const LEGACY_AUTH_NOTE =
  "Bearer-key auth only (unstamped legacy record). This record predates the " +
  "auth_level stamp, so it carries no stamp of its own; it is reported at the " +
  "bearer-era level it was written under. This is NOT owner-signature auth.";

// Constant-time string compare. `===` on a secret short-circuits at the first
// differing byte, so its runtime leaks how much of a guess was correct. The
// window is small over a network, but this is the ONLY thing standing between
// a stranger and a write to the public record, and a constant-time compare
// costs nothing. Length is compared first and non-constant-time on purpose:
// crypto.timingSafeEqual throws on length mismatch, and key LENGTH is not the
// secret — the bytes are.
function safeEqual(a, b) {
  const ab = Buffer.from(String(a), "utf8");
  const bb = Buffer.from(String(b), "utf8");
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function keyPrefixFor(bearerKey) {
  const raw = process.env.WITNESS_KEYS || "";
  let found = null;
  for (const pair of raw.split(",")) {
    const i = pair.indexOf(":");
    if (i < 1) continue;
    const key = pair.slice(0, i).trim();
    const prefix = pair.slice(i + 1).trim();
    if (!key) continue;
    // An EMPTY namespace-prefix is refused, not honoured as a wildcard.
    // `"".startsWith(...)` is true for every string, so a WITNESS_KEYS entry
    // written as "somekey:" (trailing comma, fat-fingered edit, a prefix
    // deleted but the pair left behind) would silently grant that key write
    // access to EVERY namespace in the store. A config typo must never be the
    // thing that widens authorization — fail closed, treat it as no binding.
    if (!prefix) continue;
    // Keep scanning after a hit so the loop's runtime doesn't depend on WHICH
    // key matched, and compare every entry rather than breaking early.
    if (safeEqual(key, bearerKey) && found === null) found = prefix;
  }
  return found;
}

// ---- deadline-owner binding (excelsior: renewal must be OWNER-authorized) ----
//
// The prefix gate above answers "may this key write somewhere in this
// namespace's neighbourhood." That is strictly weaker than "this key is this
// namespace's publisher": issued prefixes can overlap ("acme-" and
// "acme-ledger-"), so the broader key could refresh the narrower key's cadence
// deadline. Excelsior's deadline-laundering review asked for renewal to be
// owner-authorized rather than merely bearer-authorized; this is the Stage-0
// half of that, and it is honest about being only half.
//
// It is NOT owner-signature auth (that is Stage-1, see
// STAGE1_SIGNATURE_DESIGN.md, still not built): a stolen key still renews.
// What it closes is the OTHER key — the first key to arm or renew a
// namespace's deadline is recorded as that namespace's deadline owner, and
// every later deadline write must present that same key. Trust-on-first-use,
// and the first binder had already passed the prefix gate, so this can only
// ever SHRINK who may renew, never widen it.
//
// The binding lives in its own file, NOT as a new field on the pin record: the
// pin record's schema is published verbatim in README/PRACTICES and verified by
// strangers, and who may renew is not part of what a stranger verifies about a
// head. Nothing already stored changes shape.
//
// The stored id is DOMAIN-SEPARATED from the billing hash on purpose.
// _meter.js/_balance.js key their PRIVATE stores on sha256(key), and that same
// value is what a buyer types into Stripe as `client_reference_id`. This file
// is PUBLIC, so writing sha256(key) here would publish the billing identifier.
// Prefixing a fixed domain string identifies the same key without being the
// same number.
const OWNER_ID_DOMAIN = "arcaeon-witness-owner-v1";

function ownerKeyId(secret) {
  return crypto
    .createHash("sha256")
    .update(`${OWNER_ID_DOMAIN}|${secret}`, "utf8")
    .digest("hex")
    .slice(0, 32);
}

function ownerPath(namespace) {
  return `owners/${namespace}.json`;
}

// ---- validation (mirrors the arcaeon_ledger client's Head semantics) ----
const NS_RE = /^[a-z0-9-]{1,64}$/;
const CHAIN_RE = /^[0-9a-fA-F]{8,64}$/;

// Upper bound on `rows`. This is not tidiness — it closes a ONE-REQUEST,
// IRREVERSIBLE denial of service on a namespace (found by the 2026-08-14
// hostile audit, and reproduced live before the guard existed).
//
// The monotonic guard in api/pin.js is deliberately absolute: a witness never
// goes backward, so once a namespace's head is at rows=N, nothing below N is
// ever accepted again. That makes an absurdly large `rows` value a permanent
// brick, not a transient error — pin rows=9007199254740992 once and that
// namespace can never record a real head again, forever, by design. There is
// no admin undo, because "the witness can be walked back" is the one thing
// this product must never be true.
//
// Two guards, and both matter:
//   Number.isSafeInteger — beyond 2^53-1, JSON round-tripping is LOSSY.
//     JSON.parse("9007199254740993") silently yields 9007199254740992, so the
//     witness would record a number the publisher did not send. A witness that
//     rewrites its input is not a witness. (Number.isInteger accepts these;
//     isSafeInteger is the check that actually holds.)
//   MAX_ROWS — a domain bound. A trillion appended rows is far past any real
//     log this thing will ever see, so anything above it is a client bug or an
//     attack, and either way it should bounce off a 400 rather than land in an
//     append-only public record that cannot be corrected.
const MAX_ROWS = 1e12;

function validatePin(body) {
  if (!body || typeof body !== "object") return "body must be a JSON object";
  if (typeof body.namespace !== "string" || !NS_RE.test(body.namespace))
    return "namespace must match [a-z0-9-]{1,64}";
  if (!Number.isSafeInteger(body.rows) || body.rows < 1)
    return "rows must be a positive integer";
  if (body.rows > MAX_ROWS)
    return `rows must be <= ${MAX_ROWS} — the monotonic guard makes an oversized head permanent and unrecoverable, so it is refused rather than witnessed`;
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

// ---- cadence read-side verdict (shared by api/latest.js and api/verify.js) ----
//
// This is the ONE cadence-grading implementation for the "read a stored pin
// and say whether it's inside its declared window" question. api/status.js
// (and its api/status.json twin) deliberately do NOT call this — they carry
// their own independent reimplementation on purpose (see api/_status_data.js),
// so a bug in this function can't silently take the whole trust surface down
// at once. api/latest.js and api/verify.js SHOULD share one implementation:
// they're both "grade this one pin against its own deadline" reads, and a
// stranger diffing verify's cadence fields against latest's for the same pin
// should see the identical computation, not two hand-copies that can drift.
//
// Returns exactly the fields api/latest.js has always put on its response
// (this is an extraction, not a behavior change — api/latest.js's output is
// unchanged after switching to this). `now` is injectable for testability;
// defaults to the real clock.
function computeCadenceFields(pin, now = Date.now()) {
  const dueRaw = pin && typeof pin.next_pin_due_by === "string" ? pin.next_pin_due_by : null;
  const dueMs = dueRaw ? Date.parse(dueRaw) : NaN;

  const cadence_gradeable = Number.isFinite(dueMs);

  let cadence_status = "legacy_no_deadline";
  let overdue_by_seconds;
  if (cadence_gradeable) {
    if (now >= dueMs) {
      cadence_status = "overdue";
      overdue_by_seconds = Math.floor((now - dueMs) / 1000);
    } else {
      cadence_status = "current";
    }
  }

  const recordKind = pin && typeof pin.record_kind === "string" ? pin.record_kind : null;
  const head_state =
    recordKind === "publisher_heartbeat" ? "publisher_heartbeat_current" : "content_head_advanced";

  let status;
  if (!cadence_gradeable) status = "legacy_no_deadline";
  else if (cadence_status === "overdue") status = "overdue";
  else if (head_state === "publisher_heartbeat_current") status = "publisher_heartbeat_current";
  else status = "current";

  const out = {
    next_pin_due_by: dueRaw,
    status,
    cadence_status,
    cadence_gradeable,
    head_state,
  };
  if (!recordKind) {
    out.head_state_source = "inferred_pre_renewal_record (this record predates the heartbeat path, which could only write on a content advance)";
  }
  if (cadence_status === "overdue") out.overdue_by_seconds = overdue_by_seconds;

  if (!cadence_gradeable) {
    out.cadence_grade = "cannot_determine";
    out.gate_note =
      "REFUSE-SEMANTICS: this record predates the cadence field and declared no deadline, " +
      "so its cadence CANNOT be graded. A consumer gating on cadence MUST treat " +
      "cadence_gradeable:false as cannot_determine and apply its own not-determined policy — " +
      "it is NOT a pass. Nothing is backfilled to make this row look graded; the namespace " +
      "becomes gradeable again on its next pin or renewal, and never retroactively.";
  } else {
    out.cadence_grade = cadence_status === "current" ? "pass" : "fail";
  }

  const firstSeenRaw =
    pin && typeof pin.head_first_seen_at === "string" ? pin.head_first_seen_at : null;
  const firstSeenMs = firstSeenRaw ? Date.parse(firstSeenRaw) : NaN;
  if (Number.isFinite(firstSeenMs)) {
    out.head_first_seen_at = firstSeenRaw;
    out.content_unchanged_for_seconds = Math.max(0, Math.floor((now - firstSeenMs) / 1000));
  }
  if (Number.isInteger(pin && pin.renewals_since_advance)) {
    out.renewals_since_advance = pin.renewals_since_advance;
  }
  if (head_state === "publisher_heartbeat_current") {
    out.heartbeat_note =
      "The latest record is a publisher heartbeat: the deadline was renewed, the content head did NOT advance. " +
      "Do not read this as new activity — read it as 'a key-holder was alive and asserting nothing changed'.";
  }

  if (pin && pin.ever_missed_deadline === true) {
    out.ever_missed_deadline = true;
    if (typeof pin.missed_due_at === "string") out.missed_due_at = pin.missed_due_at;
    if (typeof pin.first_missed_due_at === "string") out.first_missed_due_at = pin.first_missed_due_at;
    if (Number.isInteger(pin.missed_deadline_count)) out.missed_deadline_count = pin.missed_deadline_count;
  }
  if (pin && pin.had_ungradeable_history === true) {
    out.had_ungradeable_history = true;
    if (cadence_gradeable) {
      // The namespace armed a deadline at some point AFTER running ungradeable.
      // Say so on the graded read too, so an armed row can never be mistaken for
      // a namespace that was under the cadence contract all along — the arming
      // is forward-only and grades nothing that came before it.
      out.cadence_history_note =
        "this namespace carried an ungradeable (legacy, no-deadline) record earlier in its history; " +
        "the deadline graded here was armed forward-only from that point and grades nothing before it";
    }
  }

  out.auth_level = (pin && pin.auth_level) || LEGACY_AUTH_LEVEL;
  out.auth_note = (pin && pin.auth_note) || LEGACY_AUTH_NOTE;

  return out;
}

module.exports = {
  REPO,
  BRANCH,
  PINS_TARGET,
  forTarget,
  getFile,
  getRawFile,
  putFile,
  listDir,
  getTree,
  getTreeMeta,
  repoReachable,
  keyPrefixFor,
  safeEqual,
  ownerKeyId,
  ownerPath,
  validatePin,
  NS_RE,
  CHAIN_RE,
  resolveCadenceHours,
  DEFAULT_CADENCE_HOURS,
  appendInterval,
  MAX_INLINE_HISTORY,
  AUTH_LEVEL,
  AUTH_LEVEL_NOTE,
  computeCadenceFields,
  // Retry knobs. Exported ONLY so the suite can swap `sleep` for a no-op —
  // production never touches these. See PUT_RETRY's header.
  _putRetry: PUT_RETRY,
};
