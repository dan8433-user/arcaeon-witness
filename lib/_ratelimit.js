// _ratelimit.js — naive per-IP fixed-window limiter for PUBLIC, UNAUTHENTICATED
// read endpoints. Underscore prefix = not routed as a serverless function.
//
// Same shape as api/pin.js's per-key rateLimited() (naive, per-instance,
// resets on cold start — see that file's comment for why this shape was
// already accepted as good enough for Stage-0). The difference here is the
// bucket key: /api/verify has no auth by design (board item 20 made it a
// no-key funnel — that's the point, a stranger shouldn't need a key just to
// ask "does this exist?"), so there is no caller key to bucket on. IP is the
// only identity available, and it is only as trustworthy as the header the
// edge network hands us.
//
// Honest limitation (documented, not hidden — same discipline as every
// other Stage-0 note in this repo): Vercel serverless functions are
// stateless per invocation, but a warm instance's module scope survives
// between invocations ON THAT INSTANCE. Under concurrent traffic Vercel
// routes requests for the same IP across MULTIPLE warm instances, each
// holding its own independent Map — so this is real protection against one
// hot loop hammering a single instance, and a real but imperfect slowdown
// against a distributed burst. It is NOT a guaranteed global cap. A precise
// cross-instance limiter needs shared state (Vercel KV / Upstash) and is
// not built here. This costs nothing extra and blocks something; it does
// not block everything.

"use strict";

const WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const LIMIT = 30; // calls per IP per window, per warm instance

// Named buckets (2026-09-27, registration release gate item 3). Each bucket
// name is its own independent per-IP budget, so a caller spending one never
// drains another: an agent polling register-status ("status") cannot lock its
// human out of confirm ("confirm") from the same address, and neither touches
// the shared "read" budget verify/status/health/badge/latest draw from. Every
// bucket not listed here gets LIMIT; the table exists so one can be tuned
// without touching the others.
const DEFAULT_BUCKET = "read";
const BUCKET_LIMITS = Object.freeze({
  read: LIMIT,
  status: 30, // register-status polls, per IP per window
  register: LIMIT,
  confirm: LIMIT,
});
function limitFor(bucket) {
  return Object.prototype.hasOwnProperty.call(BUCKET_LIMITS, bucket) ? BUCKET_LIMITS[bucket] : LIMIT;
}

const buckets = new Map(); // "<bucket> <ip>" -> {windowStart, count}

// Bounded cleanup: sweep expired buckets at most once per SWEEP_INTERVAL_MS,
// driven off real request traffic (no timer, nothing runs when nothing is
// calling in) — so a long-lived warm instance under broad IP traffic
// doesn't grow this Map forever.
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
let lastSweep = 0;
function sweep(now) {
  if (now - lastSweep < SWEEP_INTERVAL_MS) return;
  lastSweep = now;
  for (const [key, b] of buckets) {
    if (now - b.windowStart > WINDOW_MS) buckets.delete(key);
  }
}

// Best-effort caller IP: the RIGHTMOST x-forwarded-for hop (2026-09-27,
// reviewer finding 8). The leftmost entry is whatever the client wrote into
// the header before the first appending proxy, so a caller could mint a fresh
// bucket per request by prefixing a made-up hop. The rightmost is the one
// appended by the proxy nearest to us. On Vercel the platform overwrites the
// header with the one client IP it saw, so there the two are the same entry.
// lib/_register.js uses this same helper. Unset/unparseable falls back
// to the raw socket address; if even that is unavailable, every such caller
// collapses onto one shared "unknown" bucket — degraded, but it fails
// toward MORE blocking (they all share one 30/10min budget), never toward
// silently unlimited.
function callerIp(req) {
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.trim()) {
    const hops = xff.split(",").map((h) => h.trim()).filter(Boolean);
    if (hops.length) return hops[hops.length - 1];
  }
  const addr = req.socket && req.socket.remoteAddress;
  return addr || "unknown";
}

// check(req, cost=1) -> {limited:false} | {limited:true, retryAfterSeconds, limit, windowSeconds}
//
// `cost` lets one call consume more than one unit of the SAME per-IP budget
// other callers spend one unit at a time from (added for the bulk-verify
// weighting, 2026-09-20 — see api/verify.js's handleBulk). A plain call
// (cost omitted) behaves exactly as before: one unit. The bucket is unified
// on purpose — a caller mixing single verifies and bulk verifies from one
// IP draws down one shared budget, not two independent ones, which is the
// whole point of weighting rather than giving bulk mode its own bucket (see
// BULK_VERIFY_DESIGN.md's "Rate limiting" section for the fuller reasoning).
//
// `bucket` (default "read") names which independent per-IP budget the call
// draws from (see BUCKET_LIMITS). Omitted, behaviour is exactly as before.
function check(req, cost = 1, bucket = DEFAULT_BUCKET) {
  const now = Date.now();
  sweep(now);
  const name = typeof bucket === "string" && bucket ? bucket : DEFAULT_BUCKET;
  const limit = limitFor(name);
  const key = `${name} ${callerIp(req)}`;
  let b = buckets.get(key);
  if (!b || now - b.windowStart > WINDOW_MS) {
    b = { windowStart: now, count: 0 };
    buckets.set(key, b);
  }
  // Always spend the cost, even on the call that crosses the line — matches
  // the pre-weighting behavior (a blocked call still incremented count by
  // 1), and keeps this a single code path instead of a branch per outcome.
  // A single call whose OWN cost exceeds LIMIT can never succeed in any
  // window; it is still charged (so it doesn't dodge the budget by costing
  // "too much to count"), and blocked immediately rather than admitted.
  b.count += cost;
  if (b.count > limit) {
    const retryAfterSeconds = Math.max(1, Math.ceil((b.windowStart + WINDOW_MS - now) / 1000));
    return { limited: true, retryAfterSeconds, limit, windowSeconds: WINDOW_MS / 1000, bucket: name };
  }
  return { limited: false };
}

module.exports = { check, callerIp, LIMIT, WINDOW_MS, BUCKET_LIMITS, DEFAULT_BUCKET };
