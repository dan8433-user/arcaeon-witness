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

const buckets = new Map(); // ip -> {windowStart, count}

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

// Best-effort caller IP. x-forwarded-for's leftmost entry is what Vercel's
// edge network reports as the original client. Unset/unparseable falls back
// to the raw socket address; if even that is unavailable, every such caller
// collapses onto one shared "unknown" bucket — degraded, but it fails
// toward MORE blocking (they all share one 30/10min budget), never toward
// silently unlimited.
function callerIp(req) {
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.trim()) {
    return xff.split(",")[0].trim();
  }
  const addr = req.socket && req.socket.remoteAddress;
  return addr || "unknown";
}

// check(req) -> {limited:false} | {limited:true, retryAfterSeconds, limit, windowSeconds}
function check(req) {
  const now = Date.now();
  sweep(now);
  const key = callerIp(req);
  const b = buckets.get(key);
  if (!b || now - b.windowStart > WINDOW_MS) {
    buckets.set(key, { windowStart: now, count: 1 });
    return { limited: false };
  }
  b.count += 1;
  if (b.count > LIMIT) {
    const retryAfterSeconds = Math.max(1, Math.ceil((b.windowStart + WINDOW_MS - now) / 1000));
    return { limited: true, retryAfterSeconds, limit: LIMIT, windowSeconds: WINDOW_MS / 1000 };
  }
  return { limited: false };
}

module.exports = { check, callerIp, LIMIT, WINDOW_MS };
