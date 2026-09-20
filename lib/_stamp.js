// _stamp.js — "stamp a file": a public, unauthenticated, fingerprint-only
// existence record. Underscore prefix = not routed as a serverless function;
// api/verify.js dispatches `?op=stamp` here (this deployment sits at the
// Vercel Hobby 12-function cap, same reason verify's bulk mode is a mode).
//
//   POST /api/stamp   {"sha256":"<64 hex>", "size": <bytes, optional>}
//   GET  /api/stamp?sha256=<64 hex>
//
// WHY IT EXISTS (Daniel, 2026-09-19): "They can't just be doing complicated
// code to try and get these tamperproof receipts." A person drops a file on a
// page; the page hashes it IN THE BROWSER and sends only the fingerprint here.
// The file never leaves their machine, and nothing about it but its hash and
// optional byte count is ever stored.
//
// WHAT A STAMP IS. One JSON file per fingerprint in the PUBLIC pins repo,
// written as its own commit. The outside witness is GitHub's commit history,
// not this service: anyone can clone the repo and see when the commit landed,
// and a rewrite of that history is visible. A stamp proves the fingerprint was
// recorded no later than that commit. It does NOT prove who made the file, that
// what the file says is true, or that no other version exists. That sentence
// ships in every response (`scope`) because a thing called a stamp gets read as
// an endorsement, and this is not one.
//
// NO FILENAME, NO LABEL, ON PURPOSE. The store is public. A filename is
// content ("Smith divorce settlement v3.pdf"), and a free-text label is an
// open mic on a public repo. Slice 1 takes a hash and a size and nothing else.
//
// FIRST WRITE WINS, FOREVER. Stamping a fingerprint that already has a stamp
// returns the EXISTING record with `existing:true` and writes nothing. "No
// later than" is only true if the earliest record can never be replaced by a
// later one. There is no update path in this file, deliberately.
//
// ABUSE. Two fences from day one: a per-IP limiter (stricter than the read
// endpoints', this is a write), and a global daily cap kept in the store so it
// holds across serverless instances. Both fail CLOSED: if the cap counter
// cannot be read or written, the stamp is refused, never waved through.

"use strict";

const store = require("./_store.js");
const { callerIp } = require("./_ratelimit.js");

const SHA_RE = /^[0-9a-f]{64}$/;
const MAX_SIZE = Number.MAX_SAFE_INTEGER;

const DAILY_CAP = (() => {
  const n = parseInt(process.env.STAMP_DAILY_CAP || "", 10);
  return Number.isFinite(n) && n >= 0 ? n : 500;
})();

const SITE = (process.env.STAMP_SITE_BASE || "https://arcaeon.io").replace(/\/+$/, "");

const SCOPE = Object.freeze({
  proves:
    "A file with exactly this SHA-256 fingerprint was recorded no later than the time of the public commit that holds this stamp.",
  does_not_prove:
    "Who made the file. That anything the file says is true. That no other version of it exists. That the file is older than this stamp by any particular amount.",
  witness:
    "The outside witness is the public commit history of the pins repository, not this service. Check it there.",
});

// ---- per-IP limiter: own buckets, stricter than the read limiter -----------
const WINDOW_MS = 10 * 60 * 1000;
const IP_LIMIT = 10;
const buckets = new Map();

function ipLimited(req, now = Date.now()) {
  for (const [k, b] of buckets) if (now - b.windowStart > WINDOW_MS) buckets.delete(k);
  const key = callerIp(req);
  const b = buckets.get(key);
  if (!b || now - b.windowStart > WINDOW_MS) {
    buckets.set(key, { windowStart: now, count: 1 });
    return null;
  }
  b.count += 1;
  if (b.count > IP_LIMIT) {
    return Math.max(1, Math.ceil((b.windowStart + WINDOW_MS - now) / 1000));
  }
  return null;
}

function _resetLimiterForTests() {
  buckets.clear();
}

// ---- validation -------------------------------------------------------------
function validate(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { error: "body must be a JSON object" };
  }
  const extra = Object.keys(body).filter((k) => k !== "sha256" && k !== "size");
  if (extra.length) {
    // Refused, not ignored: a caller who sends "name" believes it was recorded.
    return {
      error: `unexpected field(s): ${extra.join(", ")}. A stamp stores a fingerprint and an optional size, nothing else; the store is public.`,
    };
  }
  if (typeof body.sha256 !== "string") return { error: "sha256 is required (64 hex characters)" };
  const sha = body.sha256.trim().toLowerCase();
  if (!SHA_RE.test(sha)) return { error: "sha256 must be exactly 64 hex characters" };
  let size = null;
  if (body.size !== undefined && body.size !== null) {
    if (!Number.isInteger(body.size) || body.size < 0 || body.size > MAX_SIZE) {
      return { error: "size, when given, must be a non-negative integer number of bytes" };
    }
    size = body.size;
  }
  return { sha256: sha, size };
}

function stampPath(sha) {
  return `stamps/${sha.slice(0, 2)}/${sha}.json`;
}

function dayPath(iso) {
  return `stamps/_meta/day-${iso.slice(0, 10)}.json`;
}

function present(record, { existing, commitSha }) {
  const sha = record.sha256;
  return {
    ok: true,
    existing,
    stamp: record,
    scope: SCOPE,
    permalink: `${SITE}/r/${sha}`,
    record_url: `https://github.com/${store.REPO}/blob/${store.BRANCH}/${stampPath(sha)}`,
    history_url: `https://github.com/${store.REPO}/commits/${store.BRANCH}/${stampPath(sha)}`,
    ...(commitSha ? { commit: commitSha } : {}),
  };
}

// Take one unit of today's global budget. Returns {ok:true} or {ok:false, ...}.
// Counter first, stamp second: if the stamp write then fails the counter has
// over-counted by one, which errs toward refusing, never toward unlimited.
async function takeDailyBudget(nowIso) {
  if (DAILY_CAP === 0) return { ok: false, reason: "stamping_disabled", cap: 0, used: 0 };
  // Two callers creating the day's counter at once: the loser gets GitHub's
  // create-race 422 (err.conflict), which putFile does not retry. Re-read and
  // go again, a bounded number of times; past that, refuse (fail closed).
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await takeDailyBudgetOnce(nowIso);
    } catch (e) {
      if (!(e && e.conflict) || attempt === 3) throw e;
    }
  }
  throw new Error("unreachable");
}

async function takeDailyBudgetOnce(nowIso) {
  const path = dayPath(nowIso);
  const cur = await store.getFile(path);
  const used = cur && cur.json && Number.isInteger(cur.json.count) ? cur.json.count : 0;
  if (used >= DAILY_CAP) return { ok: false, reason: "daily_cap_reached", cap: DAILY_CAP, used };
  let denied = null;
  await store.putFile(
    path,
    { day: nowIso.slice(0, 10), count: used + 1 },
    `stamp budget ${nowIso.slice(0, 10)}: ${used + 1}`,
    cur ? cur.sha : undefined,
    {
      rebuild: (fresh) => {
        const n = fresh && Number.isInteger(fresh.count) ? fresh.count : 0;
        if (n >= DAILY_CAP) {
          denied = { ok: false, reason: "daily_cap_reached", cap: DAILY_CAP, used: n };
          return null;
        }
        return { day: nowIso.slice(0, 10), count: n + 1 };
      },
    }
  );
  return denied || { ok: true };
}

function applyCors(req, res) {
  // `*` on an unauthenticated write is deliberate and safe to read: there is no
  // bearer key or cookie here for a hostile page to ride on. The only thing any
  // origin can do is what curl can already do.
  res.setHeader("access-control-allow-origin", "*");
  if (req.method === "OPTIONS") {
    res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
    res.setHeader("access-control-allow-headers", "content-type");
    res.setHeader("access-control-max-age", "86400");
    res.status(204).end();
    return true;
  }
  return false;
}

async function handleStamp(req, res) {
  if (applyCors(req, res)) return;
  res.setHeader("cache-control", "no-store");

  if (req.method === "GET") {
    const raw = req.query && typeof req.query.sha256 === "string" ? req.query.sha256 : "";
    const sha = raw.trim().toLowerCase();
    if (!SHA_RE.test(sha)) {
      return res.status(400).json({ ok: false, error: "sha256 must be exactly 64 hex characters" });
    }
    let found;
    try {
      found = await store.getFile(stampPath(sha));
    } catch (e) {
      console.error("stamp lookup failed:", e && e.message);
      return res.status(503).json({ ok: false, error: "record store unreachable; this is not a 'no'", reason: "store_unreachable" });
    }
    if (!found) {
      return res.status(404).json({ ok: false, stamped: false, sha256: sha, scope: SCOPE,
        note: "No stamp is recorded for this fingerprint. That says nothing about whether the file exists or how old it is." });
    }
    return res.status(200).json(present(found.json, { existing: true }));
  }

  if (req.method !== "POST") {
    res.setHeader("allow", "GET, POST, OPTIONS");
    return res.status(405).json({ ok: false, error: "use POST to stamp, GET to look one up" });
  }

  const v = validate(req.body);
  if (v.error) return res.status(400).json({ ok: false, error: v.error });

  const retry = ipLimited(req);
  if (retry) {
    res.setHeader("retry-after", String(retry));
    return res.status(429).json({ ok: false, error: "too many stamps from this address; slow down", reason: "ip_rate_limited", retry_after_seconds: retry });
  }

  const path = stampPath(v.sha256);
  try {
    // First write wins: an existing stamp is returned untouched and costs no budget.
    const prior = await store.getFile(path);
    if (prior) return res.status(200).json(present(prior.json, { existing: true }));

    const nowIso = new Date().toISOString();
    const budget = await takeDailyBudget(nowIso);
    if (!budget.ok) {
      return res.status(429).json({ ok: false, error: "the free daily stamp allowance for this service is used up; try again tomorrow (UTC)", ...budget });
    }

    const record = { kind: "file-stamp", v: 1, sha256: v.sha256, size: v.size, stamped_at: nowIso };
    let put;
    try {
      put = await store.putFile(path, record, `stamp ${v.sha256.slice(0, 16)}`, undefined, {
        // Someone else stamped this same fingerprint between our read and our
        // write. Theirs is earlier; it stands. Never overwrite.
        rebuild: () => null,
      });
    } catch (e) {
      if (e && e.conflict) put = { abandoned: true };
      else throw e;
    }
    if (put && put.abandoned) {
      const theirs = await store.getFile(path);
      if (theirs) return res.status(200).json(present(theirs.json, { existing: true }));
      throw new Error("stamp write lost a race and the winner could not be read back");
    }
    const commitSha = put && put.commit && put.commit.sha;
    return res.status(201).json(present(record, { existing: false, commitSha }));
  } catch (e) {
    console.error("stamp failed:", e && e.message);
    return res.status(503).json({ ok: false, error: "could not record the stamp; nothing was written that you should rely on", reason: "store_error" });
  }
}

module.exports = { handleStamp, validate, stampPath, SCOPE, DAILY_CAP, IP_LIMIT, _resetLimiterForTests };
