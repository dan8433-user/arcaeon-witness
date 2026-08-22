// GET /api/verify?ns=<namespace>&rows=<n>&chain=<hex>  (&digest= is an alias for chain)
//
// One-call public proof-of-inclusion (board item 20): "does this exact head
// exist in the witness record?" No auth, no metering — this is a funnel and
// a trust surface, not a write path, and the answer leaks nothing beyond
// what the public pins repo already shows to anyone who clones it.
//
// Grading a pin's cadence reuses store.computeCadenceFields — the SAME
// function api/latest.js uses (extracted from it, see that file's comment) —
// so a stranger diffing this endpoint's cadence fields against a plain
// /api/latest call for the same head sees one computation, not two
// hand-copies that can drift apart.
//
// Scope: the caller's (rows, chain) is checked first against the namespace's
// CURRENT head (one read, the common case — "is my log witnessed right
// now?"). If it doesn't match the current head and the requested rows are
// LOWER than the current head's rows, a bounded backward scan over the
// namespace's numbered records (pins/<ns>/<seq>.json) looks for a historical
// match — same-rows/different-chain conflicts are never written into pins/
// (they land in observations/ instead, see api/pin.js), so within pins/ a
// given rows value has at most one accepted chain, and finding rows===target
// is a conclusive yes/no. The scan is capped (MAX_HISTORY_SCAN) — this is a
// public unauthenticated GET, so the cap exists to bound this repo's shared
// GitHub API budget per call, not to meter the caller. A scan that exhausts
// the cap without a conclusive answer says so honestly rather than guessing.

"use strict";

const store = require("../lib/_store.js");
const cors = require("../lib/_cors.js");
const ratelimit = require("../lib/_ratelimit.js");

const HISTORY_BASE = `https://github.com/${store.REPO}/commits/${store.BRANCH}`;
const RAW_BASE = `https://raw.githubusercontent.com/${store.REPO}/${store.BRANCH}`;

const MAX_HISTORY_SCAN = 50;

function seqName(seq) {
  return String(seq).padStart(8, "0");
}

function rawRecordUrl(ns, seq) {
  return `${RAW_BASE}/pins/${ns}/${seqName(seq)}.json`;
}

module.exports = async (req, res) => {
  // GET-only CORS: answers an OPTIONS preflight with 204 and returns; every
  // other method falls through to the guard below with the ACAO header
  // already set. See _cors.js for why this is scoped to read endpoints only.
  if (cors.applyGetCors(req, res)) return;

  // HEAD is a read and must answer like one. Uptime monitors and link checkers
  // default to HEAD; 405-ing them reports this endpoint as DOWN while it is in
  // fact serving 200. /api/health and /status never had this guard and always
  // answered HEAD correctly — these read endpoints now match them. Node drops
  // the body from a HEAD response on its own, so the handler needs no branch.
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.setHeader("allow", "GET, HEAD, OPTIONS");
    return res.status(405).json({ error: "GET or HEAD only" });
  }

  // Per-IP rate limit — this endpoint is deliberately unauthenticated (board
  // item 20: a stranger shouldn't need a key just to ask "does this exist?"),
  // so there is no key to bucket abuse on. See _ratelimit.js for the honest
  // per-instance limitation. Checked before any store read so an over-limit
  // caller costs this instance nothing beyond a Map lookup.
  const rl = ratelimit.check(req);
  if (rl.limited) {
    res.setHeader("retry-after", String(rl.retryAfterSeconds));
    res.setHeader("cache-control", "no-store");
    return res.status(429).json({
      ok: false,
      error: "rate limit exceeded",
      note: `naive per-instance, per-IP limiter (Stage-0): ~${rl.limit} calls per IP per ${Math.round(rl.windowSeconds / 60)} minutes, enforced per warm serverless instance — not a guaranteed global cap, see the repo's rate-limit note`,
      retry_after_seconds: rl.retryAfterSeconds,
    });
  }

  const q = req.query || {};
  const ns = q.ns || "";
  if (!store.NS_RE.test(ns)) {
    return res.status(400).json({ error: "ns must match [a-z0-9-]{1,64}" });
  }

  const rowsRaw = q.rows;
  const rows = Number(rowsRaw);
  if (!Number.isInteger(rows) || rows < 1 || String(rowsRaw).trim() === "") {
    return res.status(400).json({ error: "rows must be a positive integer" });
  }

  // chain and digest are aliases for the same query parameter; both may be
  // given only if they agree (a caller passing two different fingerprints
  // for one check almost certainly has a bug, and guessing which one they
  // meant would be exactly the kind of silent fallthrough this repo's write
  // paths refuse to do — see api/pin.js's unknown-intent handling).
  const chainParam = typeof q.chain === "string" ? q.chain : null;
  const digestParam = typeof q.digest === "string" ? q.digest : null;
  if (chainParam && digestParam && chainParam.toLowerCase() !== digestParam.toLowerCase()) {
    return res.status(400).json({ error: "chain and digest were both given and disagree — pass one" });
  }
  const chain = chainParam || digestParam || "";
  if (!store.CHAIN_RE.test(chain)) {
    return res.status(400).json({ error: "chain (or digest) must be a hex string of 8-64 chars" });
  }
  const chainLower = chain.toLowerCase();

  res.setHeader("cache-control", "no-store");

  let cur;
  try {
    cur = await store.getFile(`pins/${ns}/latest.json`);
  } catch (err) {
    return res.status(502).json({ error: `pin store read error: ${err.message}` });
  }

  const historyUrl = `${HISTORY_BASE}/pins/${ns}`;

  if (!cur) {
    return res.status(200).json({
      ok: true,
      // null, not false: there is no record set to decide against. A conclusive
      // false is reserved for heads the store actively contradicts.
      witnessed: null,
      pin: null,
      reason: "no_pin_recorded_for_namespace",
      note: `no pin has ever been recorded for namespace "${ns}" — the witness has no basis to confirm or refute this head`,
      history: historyUrl,
    });
  }

  const latest = cur.json;

  function witnessedResponse(record, isCurrentHead) {
    const cadenceFields = store.computeCadenceFields(record);
    return {
      ok: true,
      witnessed: true,
      pin: record,
      seq: record.seq,
      pinned_at: record.pinned_at,
      is_current_head: isCurrentHead,
      raw_record_url: rawRecordUrl(ns, record.seq),
      history: historyUrl,
      note: isCurrentHead
        ? "this is the namespace's current witnessed head"
        : "this exact (rows, chain) was witnessed, but the namespace has since advanced past it — this is a superseded historical head, not the current one; cadence fields below describe THIS record, not the namespace's live status",
      ...cadenceFields,
    };
  }

  // --- case 1: matches the current head ---
  if (Number.isInteger(latest.rows) && rows === latest.rows) {
    if (String(latest.chain).toLowerCase() === chainLower) {
      return res.status(200).json(witnessedResponse(latest, true));
    }
    return res.status(200).json({
      ok: true,
      witnessed: false,
      pin: null,
      reason: "rows_match_chain_mismatch",
      note: "a record exists at this rows count, but its witnessed chain differs from the one submitted — this is not the accepted head",
      accepted_head: { rows: latest.rows, chain: latest.chain, seq: latest.seq },
      raw_record_url: rawRecordUrl(ns, latest.seq),
      history: historyUrl,
    });
  }

  // --- case 2: rows exceeds the current head — cannot have been witnessed yet ---
  if (Number.isInteger(latest.rows) && rows > latest.rows) {
    return res.status(200).json({
      ok: true,
      // null, not false: a head ahead of the current pin hasn't been witnessed
      // YET — the store can't refute it, only report what it has accepted.
      witnessed: null,
      pin: null,
      reason: "exceeds_current_head",
      note: `requested rows (${rows}) is ahead of the namespace's current witnessed head (${latest.rows}) — it cannot have been witnessed yet; not a refutation`,
      accepted_head: { rows: latest.rows, chain: latest.chain, seq: latest.seq },
      history: historyUrl,
    });
  }

  // --- case 3: rows is behind the current head — bounded backward scan of history ---
  // Same-rows accepted records have a unique chain (conflicts never land in
  // pins/, see api/pin.js), so the first record found at rows===target is
  // conclusive: match its chain, or it's a real mismatch, either way done.
  let seq = Number.isInteger(latest.seq) ? latest.seq - 1 : 0;
  let scanned = 0;
  try {
    while (seq >= 1 && scanned < MAX_HISTORY_SCAN) {
      let got;
      try {
        got = await store.getFile(`pins/${ns}/${seqName(seq)}.json`);
      } catch (err) {
        return res.status(502).json({ error: `pin store read error during history scan: ${err.message}` });
      }
      scanned += 1;
      if (!got) {
        // A gap in numbering shouldn't happen, but don't loop forever on one.
        seq -= 1;
        continue;
      }
      const rec = got.json;
      if (Number.isInteger(rec.rows) && rec.rows === rows) {
        if (String(rec.chain).toLowerCase() === chainLower) {
          return res.status(200).json(witnessedResponse(rec, false));
        }
        return res.status(200).json({
          ok: true,
          witnessed: false,
          pin: null,
          reason: "rows_match_chain_mismatch",
          note: "a historical record exists at this rows count, but its witnessed chain differs from the one submitted",
          scanned,
          raw_record_url: rawRecordUrl(ns, rec.seq),
          history: historyUrl,
        });
      }
      if (Number.isInteger(rec.rows) && rec.rows < rows) {
        // Rows only ever advance forward across records; once we've stepped
        // below the target without an exact hit, that rows count was never
        // pinned (an advance can skip past values) — conclusively not found.
        return res.status(200).json({
          ok: true,
          witnessed: false,
          pin: null,
          reason: "rows_never_witnessed",
          note: `rows=${rows} falls between two witnessed heads and was never itself the head — it was skipped by an advance`,
          scanned,
          history: historyUrl,
        });
      }
      seq -= 1;
    }
  } catch (err) {
    return res.status(502).json({ error: `pin store read error during history scan: ${err.message}` });
  }

  const boundReached = scanned >= MAX_HISTORY_SCAN;
  return res.status(200).json({
    ok: true,
    // Tri-state: a capped scan is an INCOMPLETE check, so it may not assert a
    // conclusive negative — witnessed:null. Reaching the start of history
    // without a match IS conclusive — witnessed:false.
    witnessed: boundReached ? null : false,
    pin: null,
    reason: boundReached ? "scan_bound_reached" : "not_found_in_history",
    note: boundReached
      ? `not found within a bounded backward scan of ${scanned} historical record(s) — older records may exist and were NOT checked; browse the full commit history directly to check further back`
      : "reached the start of this namespace's history without a match",
    scanned,
    history: historyUrl,
  });
};
