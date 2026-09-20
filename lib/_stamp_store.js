// _stamp_store.js — the stamps log's OWN record repository and OWN token.
// Underscore prefix = not routed as a serverless function by Vercel.
//
// WHY THIS IS A SEPARATE STORE (owner direction, Daniel, 2026-09-20): stamps
// get their own public record repository and their own write token. They are
// sold beside the witness on the same prepaid credit pool, but they do not
// share its record. Three reasons, in the order they matter:
//
//   1. BLAST RADIUS OF THE TOKEN. A stamp is a public, near-unauthenticated
//      write. The token that performs it is the most exposed credential in
//      this service. If that token is the pin token, then the worst day for
//      stamps is also the worst day for every pinned head. A fine-grained
//      token scoped to one repository that holds only fingerprints cannot
//      touch the witness record at all.
//   2. THE RECORDS ARE DIFFERENT CLAIMS. A pin says "this namespace's head
//      was at (rows, chain) at this time," graded against a cadence. A stamp
//      says "a file with this fingerprint was recorded no later than this
//      commit." Mixing them in one history invites a reader to carry one
//      record's strength onto the other.
//   3. VOLUME. Stamps are meant to be cheap and many. A pins repo whose
//      history is 99% stamps is a pins repo nobody can read.
//
// FAIL CLOSED, AND SPECIFICALLY: NEVER FALL BACK TO THE PINS STORE.
// If STAMP_REPO or STAMP_TOKEN is missing, this module is `configured:false`
// and every read and write throws a typed not-configured error. It does not
// read GITHUB_PIN_REPO. It does not read GITHUB_PIN_TOKEN. The handler turns
// that into a 503. An unconfigured stamp endpoint refuses service; it does
// not quietly write a stamp into the witness record.
//
// The guard is belt AND braces: even if STAMP_REPO were set BY HAND to the
// pins repo, config() refuses it (`stamp_repo_is_pins_repo`). One env typo
// must never be the thing that merges the two records.
//
// The GitHub primitives are lib/_store.js's, bound to this target via
// store.forTarget(). They are not re-implemented here on purpose: putFile's
// 409 retry was measured live (tools/ceiling_probe.js, 465 conflicts in 532
// requests) and a second hand-copy of that loop would be a second
// implementation with nothing keeping the two in step.

"use strict";

const store = require("./_store.js");

// Config is read LAZILY, on every call, not captured at module load. A
// serverless instance can be warm across a config change, and — the reason
// that matters here — "the stamp env is missing" is a state the tests must be
// able to enter and leave without re-requiring the module graph.
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function config() {
  const repo = String(process.env.STAMP_REPO || "").trim();
  const branch = String(process.env.STAMP_BRANCH || "").trim() || "main";
  const token = String(process.env.STAMP_TOKEN || "").trim();

  const missing = [];
  if (!repo) missing.push("STAMP_REPO");
  if (!token) missing.push("STAMP_TOKEN");
  if (missing.length) {
    return { configured: false, reason: "stamp_store_not_configured", missing, repo: null, branch };
  }
  if (!REPO_RE.test(repo)) {
    return {
      configured: false,
      reason: "stamp_repo_malformed",
      missing: ["STAMP_REPO"],
      repo: null,
      branch,
    };
  }
  // The one that is not a formality. See the header.
  if (repo === store.REPO) {
    return {
      configured: false,
      reason: "stamp_repo_is_pins_repo",
      missing: ["STAMP_REPO"],
      repo: null,
      branch,
    };
  }
  return { configured: true, reason: null, missing: [], repo, branch };
}

// A stamp token that is byte-identical to the pin token is not a misrouting
// (config() has already proved the repo is different) — it is a SCOPE
// mistake: one credential that can write both records, which is the thing
// the separate repo exists to prevent. Logged once per instance, loudly,
// rather than refused: we cannot see a token's scope from here, and refusing
// on a guess would take down a correctly-scoped deployment that happens to
// reuse a value. STAMPS_OWN_REPO.md's checklist is where this gets prevented.
let warnedSharedToken = false;
function warnIfSharedToken() {
  if (warnedSharedToken) return;
  const stampTok = process.env.STAMP_TOKEN;
  const pinTok = process.env.GITHUB_PIN_TOKEN;
  if (stampTok && pinTok && stampTok === pinTok) {
    warnedSharedToken = true;
    console.error(
      "[stamp-store] STAMP_TOKEN is the same value as GITHUB_PIN_TOKEN. The stamps " +
        "repo is separate but the credential is not — issue a fine-grained token scoped " +
        "to the stamps repository only. See STAMPS_OWN_REPO.md."
    );
  }
}

function notConfigured(cfg) {
  const err = new Error(
    `stamp record store is not configured (${cfg.reason}): set ${cfg.missing.join(", ")}. ` +
      "Stamps are never written to the pins repository."
  );
  err.not_configured = true;
  err.reason = cfg.reason;
  err.missing = cfg.missing;
  return err;
}

function target() {
  const cfg = config();
  if (!cfg.configured) throw notConfigured(cfg);
  warnIfSharedToken();
  return {
    repo: cfg.repo,
    branch: cfg.branch,
    tokenEnv: "STAMP_TOKEN", // NEVER GITHUB_PIN_TOKEN, under any fallback
    ua: "arcaeon-stamps",
  };
}

function bound() {
  return store.forTarget(target());
}

// The surface lib/_stamp.js uses. Each call resolves config first, so an
// unconfigured deployment throws BEFORE any fetch is attempted — there is no
// request in flight to be misrouted.
async function getFile(path) {
  return bound().getFile(path);
}

async function putFile(path, obj, message, sha, opts) {
  return bound().putFile(path, obj, message, sha, opts);
}

// Read-only view for the handler's fail-closed gate and for status surfaces:
// answers "is this configured, and to what" without throwing and without
// leaking the token.
function status() {
  const cfg = config();
  return {
    configured: cfg.configured,
    reason: cfg.reason,
    missing: cfg.missing,
    repo: cfg.repo,
    branch: cfg.branch,
  };
}

module.exports = { config, status, target, getFile, putFile, notConfigured };
