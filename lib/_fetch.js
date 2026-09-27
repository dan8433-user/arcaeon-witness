// _fetch.js — one outbound fetch with a per-request timeout.
// Underscore prefix = not routed as a serverless function by Vercel.
//
// WHY (2026-09-27, registration release gate item 3): a store call that never
// answers used to hold the function until the platform killed it, and a
// killed function runs no refund. Every outbound call to the GitHub contents
// API (the store), Resend (the register mail), and Stripe (fulfill) now goes
// through timedFetch: an AbortController fires at the timeout, and the call
// rejects with a plain Error. Callers already treat a thrown fetch as a store
// error, so their existing 503/502 paths and refunds run unchanged.
//
// The timeout covers the body read too: the timer is not cleared when the
// headers arrive, so a response that stalls mid-body is aborted as well. It is
// unref'd, so a pending timer never keeps a process alive.
//
// Env: WITNESS_FETCH_TIMEOUT_MS (default 10000). Read per call, so a test or a
// redeploy can change it without a module reload. A value that is not a
// positive number falls back to the default.

"use strict";

const DEFAULT_TIMEOUT_MS = 10000;

function timeoutMs() {
  const n = Number(process.env.WITNESS_FETCH_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TIMEOUT_MS;
}

function timedFetch(url, opts = {}) {
  const ms = timeoutMs();
  const ctl = new AbortController();
  let timer;
  // Raced as well as signalled: a fetch implementation that ignores the
  // signal still cannot hold the caller past the timeout.
  const timedOut = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`outbound request timed out after ${ms} ms`);
      err.timeout = true;
      ctl.abort(err);
      reject(err);
    }, ms);
    if (timer && typeof timer.unref === "function") timer.unref();
  });
  const call = Promise.resolve().then(() => globalThis.fetch(url, { ...opts, signal: ctl.signal }));
  call.catch(() => clearTimeout(timer));
  return Promise.race([call, timedOut]);
}

module.exports = { timedFetch, timeoutMs, DEFAULT_TIMEOUT_MS };
