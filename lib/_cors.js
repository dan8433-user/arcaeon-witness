// _cors.js — GET-only CORS for PUBLIC READ endpoints. Underscore prefix =
// not routed as a serverless function.
//
// Scope is deliberate and narrow: this repo's read endpoints (verify,
// status, health) leak nothing beyond what the public pin repo already
// shows anyone who clones it (see api/verify.js's own module comment), so
// there is no reason to force a browser-based caller through a same-origin
// fetch to read them. Write endpoints (pin.js, renew.js, credit.js,
// balance.js, distill.js, stripe-webhook.js) are Authorization-bearer-keyed
// and/or billing-adjacent — CORS is never applied there. Opening GET to `*`
// on a write endpoint would do nothing by itself (the browser still can't
// forge the bearer key), but this repo's discipline is to keep each
// endpoint's exposure legible by inspection rather than "safe because of a
// second layer" — so the helper below is only ever imported by read paths,
// on purpose.
//
// applyGetCors(req, res) -> true if the caller must return immediately
// (an OPTIONS preflight was answered), false to keep handling the request.

"use strict";

function applyGetCors(req, res) {
  res.setHeader("access-control-allow-origin", "*");
  if (req.method === "OPTIONS") {
    res.setHeader("access-control-allow-methods", "GET, HEAD, OPTIONS");
    res.setHeader("access-control-allow-headers", "content-type");
    // A day is plenty for a read-only, header-only preflight and keeps
    // repeat cross-origin callers from re-preflighting every call.
    res.setHeader("access-control-max-age", "86400");
    res.status(204).end();
    return true;
  }
  return false;
}

module.exports = { applyGetCors };
