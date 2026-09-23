// GET /api/verify?ns=<namespace>&rows=<n>&chain=<hex>  (&digest= is an alias for chain)
// POST /api/verify?op=bulk  { "items": [{ns, rows, chain|digest}, ...] }
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
//
// BULK MODE (K-017/K-018, BATCH_500 lane K, section 8 rule 4; design doc:
// BULK_VERIFY_DESIGN.md). `?op=bulk` is a MODE on this same function, not a
// new file — arcaeon-witness/api/ is at the Vercel Hobby 12-function cap
// (confirmed K-016), and the `?op=` dispatch pattern already exists on
// api/fulfill.js (`?op=prefix-available`). Bulk mode calls `verifyItem` — the
// SAME lookup logic the single-item path below calls — once per item, in
// order, never short-circuiting on the first failure, and emits no verdict
// word verifyItem doesn't already emit. An oversized batch is refused whole,
// before any store read, mirroring arcaeon_receipt/cite_batch.py's
// cap-or-refuse pattern. See BULK_VERIFY_DESIGN.md for the full contract.
//
// RATE LIMIT (2026-09-20 fix, see BULK_VERIFY_DESIGN.md "Rate limiting"):
// bulk mode runs its own weighted ratelimit.check(req, items.length) after
// the cheap shape/cap validation and before any store read — it does NOT
// fall through to the single-item GET/HEAD path's own (unweighted, cost=1)
// check below, since bulk is dispatched away from that path entirely.

"use strict";

const store = require("../lib/_store.js");
const verdict = require("../lib/_verdict.js");
const cors = require("../lib/_cors.js");
const ratelimit = require("../lib/_ratelimit.js");
const stamp = require("../lib/_stamp.js");

const HISTORY_BASE = `https://github.com/${store.REPO}/commits/${store.BRANCH}`;
const RAW_BASE = `https://raw.githubusercontent.com/${store.REPO}/${store.BRANCH}`;

const MAX_HISTORY_SCAN = 50;

// Bulk-batch cap (BULK_VERIFY_DESIGN.md "The cap, and refusal"): a single
// verify lookup can cost up to MAX_HISTORY_SCAN store reads in the worst
// case (a deep historical scan), so a bulk call's worst-case cost is
// MAX_BULK_ITEMS * MAX_HISTORY_SCAN reads. 20 keeps that bounded while still
// being a useful batch size; it's a plain constant, not load-bearing enough
// to need its own config surface yet.
const MAX_BULK_ITEMS = 20;

function seqName(seq) {
  return String(seq).padStart(8, "0");
}

function rawRecordUrl(ns, seq) {
  return `${RAW_BASE}/pins/${ns}/${seqName(seq)}.json`;
}

// The single-item verify logic, factored out so bulk mode calls the exact
// same implementation instead of a second hand-copy (section 8 rule 6: never
// a second implementation of a verdict without a parity mechanism — here the
// mechanism is "there is only one implementation"). Returns {status, body}
// instead of writing to a response, so both the single-item path and bulk
// mode can use it. Every failure mode of the STORE returns a body. The one
// thing that throws is a programming error: building an ok:true body without
// a green verdict in hand (lib/_verdict.js) — deliberately, fail closed.
async function verifyItem(rawNs, rawRows, rawChain, rawDigest) {
  const ns = rawNs || "";
  if (!store.NS_RE.test(ns)) {
    return { status: 400, body: { error: "ns must match [a-z0-9-]{1,64}" } };
  }

  const rowsRaw = rawRows;
  const rows = Number(rowsRaw);
  if (!Number.isInteger(rows) || rows < 1 || String(rowsRaw).trim() === "") {
    return { status: 400, body: { error: "rows must be a positive integer" } };
  }

  // chain and digest are aliases for the same field; both may be given only
  // if they agree (a caller passing two different fingerprints for one check
  // almost certainly has a bug, and guessing which one they meant would be
  // exactly the kind of silent fallthrough this repo's write paths refuse to
  // do — see api/pin.js's unknown-intent handling).
  const chainParam = typeof rawChain === "string" ? rawChain : null;
  const digestParam = typeof rawDigest === "string" ? rawDigest : null;
  if (chainParam && digestParam && chainParam.toLowerCase() !== digestParam.toLowerCase()) {
    return { status: 400, body: { error: "chain and digest were both given and disagree — pass one" } };
  }
  const chain = chainParam || digestParam || "";
  if (!store.CHAIN_RE.test(chain)) {
    return { status: 400, body: { error: "chain (or digest) must be a hex string of 8-64 chars" } };
  }
  const chainLower = chain.toLowerCase();

  const historyUrl = `${HISTORY_BASE}/pins/${ns}`;

  let cur;
  try {
    cur = await store.getFile(`pins/${ns}/latest.json`);
  } catch (err) {
    // Reached-and-not-JSON is a verdict about the record (red), not a store
    // outage: same 503 + ok:false as a head that parses but is not a pin.
    if (err instanceof SyntaxError) {
      return verdict.refusal(verdict.red(`pins/${ns}/latest.json`, "not_json"), "verify");
    }
    return { status: 502, body: { error: `pin store read error: ${err.message}` } };
  }

  // The verdict on the head comes before any answer is built from it
  // (lib/_verdict.js). Every `ok: true` body below is made by
  // verdict.success(<a verdict>, ...), which throws without one and throws on
  // a red one. Before this, a latest.json that was present but was not a pin
  // record fell past cases 1 and 2 (no integer rows), started the scan at
  // `seq = 0` (a DEFAULT), walked nothing, and answered 200 ok:true
  // witnessed:false "reached the start of this namespace's history without a
  // match" — a conclusive refutation manufactured from a damaged file.
  const headWhat = `pins/${ns}/latest.json`;
  // Every success below names the record it answers about ({what}), so a
  // verdict judged from one record cannot gate an answer about another
  // (lib/_verdict.js rule 6).
  const HEAD = { what: headWhat };
  const headVerdict = verdict.judgePin(cur, { what: headWhat, namespace: ns });

  if (verdict.isEmpty(headVerdict, "verify")) {
    // Verified empty: the store said 404. The only road to this answer.
    return {
      status: 200,
      body: verdict.success(headVerdict, {
        // null, not false: there is no record set to decide against. A conclusive
        // false is reserved for heads the store actively contradicts.
        witnessed: null,
        pin: null,
        reason: "no_pin_recorded_for_namespace",
        note: `no pin has ever been recorded for namespace "${ns}" — the witness has no basis to confirm or refute this head`,
        history: historyUrl,
      }, "verify", HEAD),
    };
  }
  if (!headVerdict.ok) return verdict.refusal(headVerdict, "verify", HEAD);

  const latest = cur.json;

  function witnessedResponse(recordVerdict, record, isCurrentHead) {
    const cadenceFields = store.computeCadenceFields(record);
    return verdict.success(recordVerdict, {
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
    }, "verify", { what: isCurrentHead ? headWhat : `pins/${ns}/${seqName(record.seq)}.json` });
  }

  // --- case 1: matches the current head ---
  if (rows === latest.rows) {
    if (latest.chain.toLowerCase() === chainLower) {
      return { status: 200, body: witnessedResponse(headVerdict, latest, true) };
    }
    return {
      status: 200,
      body: verdict.success(headVerdict, {
        witnessed: false,
        pin: null,
        reason: "rows_match_chain_mismatch",
        note: "a record exists at this rows count, but its witnessed chain differs from the one submitted — this is not the accepted head",
        accepted_head: { rows: latest.rows, chain: latest.chain, seq: latest.seq },
        raw_record_url: rawRecordUrl(ns, latest.seq),
        history: historyUrl,
      }, "verify", HEAD),
    };
  }

  // --- case 2: rows exceeds the current head — cannot have been witnessed yet ---
  if (rows > latest.rows) {
    return {
      status: 200,
      body: verdict.success(headVerdict, {
        // null, not false: a head ahead of the current pin hasn't been witnessed
        // YET — the store can't refute it, only report what it has accepted.
        witnessed: null,
        pin: null,
        reason: "exceeds_current_head",
        note: `requested rows (${rows}) is ahead of the namespace's current witnessed head (${latest.rows}) — it cannot have been witnessed yet; not a refutation`,
        accepted_head: { rows: latest.rows, chain: latest.chain, seq: latest.seq },
        history: historyUrl,
      }, "verify", HEAD),
    };
  }

  // --- case 3: rows is behind the current head — bounded backward scan of history ---
  // Same-rows accepted records have a unique chain (conflicts never land in
  // pins/, see api/pin.js), so the first record found at rows===target is
  // conclusive: match its chain, or it's a real mismatch, either way done.
  // No `: 0` here any more: headVerdict already proved latest.seq is an integer.
  let seq = latest.seq - 1;
  let scanned = 0;
  // Records the walk asked for and could not read as pin records: a hole in
  // the numbering, or a file that is there and is not a pin. Either one could
  // have been the record being asked about, so once this is non-zero no
  // NEGATIVE below may be conclusive. (A positive still is: a verified record
  // that matches is a match whatever else is damaged.)
  let unreadable = 0;
  const inconclusive = (fields) => ({
    ...fields,
    witnessed: null,
    reason: "history_unreadable",
    unreadable_records: unreadable,
    note:
      `${unreadable} record(s) in the scanned range are missing or cannot be read as pin records, and any of them ` +
      "could have been the head asked about — so this is NOT a refutation. Browse the commit history directly.",
  });
  try {
    while (seq >= 1 && scanned < MAX_HISTORY_SCAN) {
      let got;
      try {
        got = await store.getFile(`pins/${ns}/${seqName(seq)}.json`);
      } catch (err) {
        if (err instanceof SyntaxError) {
          // a historical record that is not JSON: unreadable, same as one that
          // parses and is not a pin — counted, never silently passed over
          scanned += 1;
          unreadable += 1;
          seq -= 1;
          continue;
        }
        return { status: 502, body: { error: `pin store read error during history scan: ${err.message}` } };
      }
      scanned += 1;
      const recWhat = { what: `pins/${ns}/${seqName(seq)}.json` };
      const recVerdict = verdict.judgePin(got, { what: recWhat.what, namespace: ns });
      if (!recVerdict.ok || verdict.isEmpty(recVerdict, "verify")) {
        // A gap in numbering shouldn't happen, and neither should a record that
        // is not a record. Don't loop forever on one — and don't pretend it was
        // looked at, either (both used to be skipped in silence).
        unreadable += 1;
        seq -= 1;
        continue;
      }
      const rec = got.json;
      if (rec.rows === rows) {
        if (rec.chain.toLowerCase() === chainLower) {
          return { status: 200, body: witnessedResponse(recVerdict, rec, false) };
        }
        return {
          status: 200,
          body: verdict.success(recVerdict, {
            witnessed: false,
            pin: null,
            reason: "rows_match_chain_mismatch",
            note: "a historical record exists at this rows count, but its witnessed chain differs from the one submitted",
            scanned,
            raw_record_url: rawRecordUrl(ns, rec.seq),
            history: historyUrl,
          }, "verify", recWhat),
        };
      }
      if (rec.rows < rows) {
        // Rows only ever advance forward across records; once we've stepped
        // below the target without an exact hit, that rows count was never
        // pinned (an advance can skip past values) — conclusively not found,
        // PROVIDED every record on the way down was actually read.
        const fields = {
          witnessed: false,
          pin: null,
          reason: "rows_never_witnessed",
          note: `rows=${rows} falls between two witnessed heads and was never itself the head — it was skipped by an advance`,
          scanned,
          history: historyUrl,
        };
        return { status: 200, body: verdict.success(recVerdict, unreadable ? inconclusive(fields) : fields, "verify", recWhat) };
      }
      seq -= 1;
    }
  } catch (err) {
    return { status: 502, body: { error: `pin store read error during history scan: ${err.message}` } };
  }

  const boundReached = scanned >= MAX_HISTORY_SCAN;
  const tail = {
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
  };
  return {
    status: 200,
    body: verdict.success(headVerdict, unreadable && !boundReached ? inconclusive(tail) : tail, "verify", HEAD),
  };
}

// POST /api/verify?op=bulk — see BULK_VERIFY_DESIGN.md for the full contract.
async function handleBulk(req, res) {
  if (req.method !== "POST") {
    res.setHeader("allow", "POST");
    return res.status(405).json({ error: "bulk verify is POST only" });
  }

  res.setHeader("cache-control", "no-store");

  const body = typeof req.body === "object" && req.body ? req.body : {};
  const items = body.items;

  if (!Array.isArray(items)) {
    return res.status(400).json({ ok: false, error: "items must be a non-empty array" });
  }
  if (items.length === 0) {
    return res.status(400).json({ ok: false, error: "items must be a non-empty array" });
  }
  // Cap check BEFORE any store read — an oversized batch is refused whole,
  // never truncated and never partially processed (BULK_VERIFY_DESIGN.md,
  // mirroring arcaeon_receipt/cite_batch.py's cap-or-refuse pattern).
  if (items.length > MAX_BULK_ITEMS) {
    return res.status(400).json({
      ok: false,
      error: `batch exceeds cap of ${MAX_BULK_ITEMS} items`,
      count: items.length,
      cap: MAX_BULK_ITEMS,
    });
  }

  // Per-IP rate limit, WEIGHTED by items.length (2026-09-20 fix — see
  // BULK_VERIFY_DESIGN.md "Rate limiting"). A single verify costs at most
  // MAX_HISTORY_SCAN store reads; a bulk call of N items costs up to N times
  // that, from the SAME shared GitHub token /api/pin's paid writes depend
  // on. Spending only one rate-limit unit per bulk call regardless of size
  // (the original design) let one HTTP request buy up to MAX_BULK_ITEMS
  // times the intended per-call budget in store reads. Charging
  // items.length units against the SAME bucket the single-item path uses
  // (ratelimit.js's `cost` param) closes that without a second bucket to
  // keep in sync — a caller mixing single and bulk calls draws from one
  // shared budget, matching how the two paths already share one GitHub
  // token. Checked here: AFTER the shape/cap validation above (which
  // touches no store and must stay free to refuse garbage), and BEFORE the
  // store-reading loop below — so an over-limit caller costs this instance
  // nothing beyond the checks already run, and a malformed/over-cap batch
  // (refused above) never reaches this check at all and so never spends a
  // rate-limit unit either — it was already refused for a cheaper reason
  // and shouldn't also be charged for one it never got the chance to incur.
  const rl = ratelimit.check(req, items.length);
  if (rl.limited) {
    res.setHeader("retry-after", String(rl.retryAfterSeconds));
    return res.status(429).json({
      ok: false,
      error: "rate limit exceeded",
      note: `naive per-instance, per-IP limiter (Stage-0): ~${rl.limit} calls per IP per ${Math.round(rl.windowSeconds / 60)} minutes, enforced per warm serverless instance — not a guaranteed global cap; a bulk call of N items spends N of those units from the same budget, see the repo's rate-limit note`,
      retry_after_seconds: rl.retryAfterSeconds,
    });
  }

  const results = [];
  // Plain sequential loop, never Promise.all: one item's rejection must not
  // take down the batch, and results must land in request order.
  for (const raw of items) {
    const item = typeof raw === "object" && raw ? raw : {};
    const { status, body: itemBody } = await verifyItem(item.ns, item.rows, item.chain, item.digest);
    results.push({
      ns: item.ns,
      rows: item.rows,
      chain: item.chain,
      digest: item.digest,
      http_status: status,
      ...itemBody,
    });
  }

  return res.status(200).json({ ok: true, count: results.length, results });
}

module.exports = async (req, res) => {
  // --- co-hosted mode: /api/stamp (vercel.json rewrite -> ?op=stamp) ---
  // A WRITE riding on a read endpoint, and it says so here rather than hiding:
  // this deployment is at the Vercel Hobby 12-function cap, so lib/_stamp.js
  // cannot have an api/ file of its own. It is dispatched BEFORE the GET-only
  // CORS helper below because it answers its own POST preflight, and it shares
  // nothing with verify's logic: no bearer key, no pins/ reads, its own
  // limiter and its own daily cap. See lib/_stamp.js.
  if (String((req.query || {}).op || "") === "stamp") {
    return stamp.handleStamp(req, res);
  }

  // GET-only CORS: answers an OPTIONS preflight with 204 and returns; every
  // other method falls through to the guard below with the ACAO header
  // already set. See _cors.js for why this is scoped to read endpoints only.
  if (cors.applyGetCors(req, res)) return;

  const q = req.query || {};

  // --- co-hosted mode: POST /api/verify?op=bulk ---
  // Dispatched before the single-item method/ratelimit gates below — bulk
  // mode has its own method requirement (POST, not GET/HEAD), its own shape
  // entirely, and (2026-09-20) its own WEIGHTED rate-limit check inside
  // handleBulk itself — it is never exempt from rate limiting, it is gated
  // by a different call shaped for its own cost. See BULK_VERIFY_DESIGN.md.
  if (String(q.op || "") === "bulk") {
    return handleBulk(req, res);
  }

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

  res.setHeader("cache-control", "no-store");

  const { status, body } = await verifyItem(q.ns, q.rows, q.chain, q.digest);
  return res.status(status).json(body);
};
