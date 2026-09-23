// _stamp.js — "stamp a file": a public, fingerprint-only existence record.
// Underscore prefix = not routed as a serverless function; api/verify.js
// dispatches `?op=stamp` here (this deployment sits at the Vercel Hobby
// 12-function cap, same reason verify's bulk mode is a mode).
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
// WHAT A STAMP IS. One JSON file per fingerprint in the PUBLIC STAMPS repo,
// written as its own commit. The outside witness is GitHub's commit history,
// not this service: anyone can clone the repo and see when the commit landed,
// and a rewrite of that history would show. A stamp proves the fingerprint was
// recorded no later than that commit. It does NOT prove who made the file, that
// what the file says is true, or that no other version exists. That sentence
// ships in every response (`scope`) because a thing called a stamp gets read as
// an endorsement, and this is not one.
//
// ITS OWN REPOSITORY, ITS OWN TOKEN (owner direction, 2026-09-20). Stamps do
// NOT write to the witness pins repo. lib/_stamp_store.js owns that separation
// and carries the full argument; the operational consequence lives here: if
// the stamp store is not configured, every mode of this endpoint returns 503
// and NOTHING is written anywhere. There is no fallback path to the pins repo,
// by construction — the pins store object is not even in scope for a write in
// this file. It is required only for `keyPrefixFor`, which reads an env var.
//
// NO FILENAME, NO LABEL, ON PURPOSE. The store is public. A filename is
// content ("Smith divorce settlement v3.pdf"), and a free-text label is an
// open mic on a public repo. Slice 1 takes a hash and a size and nothing else.
//
// FIRST WRITE WINS, FOREVER. Stamping a fingerprint that already has a stamp
// returns the EXISTING record with `existing:true`, writes nothing, and CHARGES
// NOTHING. "No later than" is only true if the earliest record can never be
// replaced by a later one. There is no update path in this file, deliberately.
//
// ABUSE AND PRICE (2026-09-20). Daniel: "3 free stamps a day, and if free can
// get exploited just make it paid." Four fences, in this order:
//   1. a per-IP BURST limiter (10 per 10 minutes) — unchanged;
//   2. a per-IP FREE-PER-DAY allowance (STAMP_FREE_PER_DAY, default 3) — a
//      SOFT limit, see freeUsedToday() for exactly how soft;
//   3. past the free allowance, a valid witness key and a real debit from the
//      SAME prepaid balance the pins spend (STAMP_PRICE_CREDITS per stamp);
//   4. the global daily cap kept in the store so it holds across instances.
// Fences 2 and 4 fail CLOSED: if the cap counter cannot be read or written,
// the stamp is refused, never waved through.

"use strict";

const stampStore = require("./_stamp_store.js");
const balance = require("./_balance.js");
const store = require("./_store.js"); // env-key lookup ONLY — never a write target
const issuedKeys = require("./_keys.js");
const { callerIp } = require("./_ratelimit.js");
const verdict = require("./_verdict.js");

const SHA_RE = /^[0-9a-f]{64}$/;
const MAX_SIZE = Number.MAX_SAFE_INTEGER;

const DAILY_CAP = (() => {
  const n = parseInt(process.env.STAMP_DAILY_CAP || "", 10);
  return Number.isFinite(n) && n >= 0 ? n : 500;
})();

const SITE = (process.env.STAMP_SITE_BASE || "https://arcaeon.io").replace(/\/+$/, "");

// ---- THE PRICE. ONE CONSTANT. ------------------------------------------------
//
// A stamp costs a FRACTION of one pin credit, and this is the only place that
// fraction is written. It is deliberately NOT an env var: a price is a promise
// to a customer, and a promise that can be changed by editing a dashboard field
// at 2 a.m. is not one. Changing it is a code change, a changelog line, and a
// conversation.
//
// THE NUMBER BELOW IS A PLACEHOLDER AND IS NOT RATIFIED. Pricing authority for
// this lane is the owner's partner's call, and it must be brought to him WITH
// ITS MATH, not as a number. The math, from lib/_balance.js's real pack prices:
//
//   entry packs (mini $5/1,000 and starter $15/3,000) = $0.005 per credit
//   standard  ($50/12,000)                            = $0.0041667 per credit
//   bulk      ($150/40,000)                           = $0.00375 per credit
//
//   at 0.25 credits per stamp:
//     entry    $0.00125 per stamp   (800 stamps per dollar)
//     standard $0.00104 per stamp   (960 stamps per dollar)
//     bulk     $0.00094 per stamp   (1,067 stamps per dollar)
//
// Why a quarter and not one: a stamp is a single commit carrying a hash. A pin
// carries a cadence contract, a deadline, an interval history, a monotonic
// guard and a verification surface. Charging the same for both would price the
// cheap thing off the table. Why not a tenth: at 0.1 credits the entry rate is
// $0.0005 a stamp and the GitHub write behind it is worth more than the money,
// so the cheapest pack stops covering its own cost at volume. A quarter is the
// defensible middle, and "defensible middle" is an argument, not a decision.
const STAMP_PRICE_CREDITS = 0.25;

// ---- the free tier's SHARE of the daily budget --------------------------
//
// SECOND-LINEAGE FINDING (2026-09-20), fixed here. The header above says the
// fence that holds under attack is the global daily cap. It is store-backed
// and cross-instance and it does hold — but it held against the wrong thing.
// takeDailyBudget() was called with ONE ceiling for everybody, so a FREE
// stamp spent a unit of the same budget a PAID stamp needs, and enough free
// traffic refused the paying customer. That contradicts this endpoint's own
// 429 body: "a paid stamp is never silently dropped."
//
// It does not take header spoofing to get there. freeDays lives in module
// scope on ONE warm instance, so the per-address allowance resets on every
// cold start and is granted again by every concurrent instance — the comment
// below already says the real ceiling is (instances x 3), not 3.
//
// So the free tier now has a LOWER ceiling than the paid tier, and the gap
// is a floor under paying customers. Nothing else moves: the paid ceiling is
// still DAILY_CAP, a stamp still costs what it cost, and no new state is
// stored. An operator who wants the old behaviour sets this to 1.
function freeCeiling() {
  if (DAILY_CAP === 0) return 0;
  const raw = process.env.STAMP_FREE_SHARE_OF_CAP;
  let share = 0.5;
  if (raw !== undefined && raw !== null && String(raw).trim() !== "") {
    const n = Number(String(raw).trim());
    if (Number.isFinite(n) && n >= 0 && n <= 1) share = n;
  }
  return Math.floor(DAILY_CAP * share);
}

// Free stamps per client address per UTC day. 0 makes EVERY stamp paid — the
// owner's stated escape hatch ("if free can get exploited just make it paid"),
// reachable without a code change because it is an operational lever, not a
// price. Read lazily on every request so flipping it takes effect on warm
// instances too.
function freePerDay() {
  const raw = process.env.STAMP_FREE_PER_DAY;
  if (raw === undefined || raw === null || String(raw).trim() === "") return 3;
  const n = parseInt(String(raw), 10);
  return Number.isFinite(n) && n >= 0 ? n : 3;
}

const SCOPE = Object.freeze({
  proves:
    "A file with exactly this SHA-256 fingerprint was recorded no later than the time of the public commit that holds this stamp.",
  does_not_prove:
    "Who made the file. That anything the file says is true. That no other version of it exists. That the file is older than this stamp by any particular amount.",
  witness:
    "The outside witness is the public commit history of the stamps repository, not this service. Check it there.",
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

// ---- the free allowance: per IP, per UTC day -------------------------------
//
// SOFT LIMIT, AND THE WORD IS EXACT. This is the same per-IP approach
// lib/_ratelimit.js already uses and it inherits every one of that file's
// honest limitations, which are worth restating because MONEY now sits on the
// other side of this counter:
//
//   - it lives in module scope on ONE warm serverless instance. Concurrent
//     traffic is spread across instances, each with its own Map, so the real
//     ceiling is (instances x 3), not 3;
//   - a cold start resets it to zero;
//   - the identity is x-forwarded-for, which is an address, not a person. A
//     phone on cellular gets a new one by toggling airplane mode, and a
//     household behind one NAT shares one allowance.
//
// So this does NOT stop a determined free-rider, and nothing here pretends it
// does. It makes casual over-use cost effort, and it makes the FIRST THREE
// STAMPS FREE FOR A REAL PERSON, which is the thing it is actually for. The
// fence that holds under attack is the global daily cap below it (store-backed,
// cross-instance, fail-closed) plus the owner's lever: set STAMP_FREE_PER_DAY
// to 0 and every stamp needs a key and a balance.
const freeDays = new Map(); // "<ip>|<YYYY-MM-DD>" -> count

function freeKey(ip, day) {
  return `${ip}|${day}`;
}

function freeUsedToday(ip, day) {
  // Yesterday's buckets are dead weight; drop them whenever we look.
  for (const k of freeDays.keys()) if (!k.endsWith(`|${day}`)) freeDays.delete(k);
  return freeDays.get(freeKey(ip, day)) || 0;
}

// Called ONLY after a stamp has actually been written. A write that fails must
// not burn a free stamp the caller never got.
function noteFreeUsed(ip, day) {
  const k = freeKey(ip, day);
  const n = (freeDays.get(k) || 0) + 1;
  freeDays.set(k, n);
  return n;
}

function _resetLimiterForTests() {
  buckets.clear();
  freeDays.clear();
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

// A stored stamp gets a verdict before it is shown (lib/_verdict.js). `sha` is
// the fingerprint that was ASKED about, and it is required: a record filed
// under one fingerprint that names another, or names none, is not an answer
// to the question. Before this, a file holding ANOTHER fingerprint's stamp came
// back 200 ok:true for the fingerprint asked about, and a file with no sha256
// at all crashed in stampPath() instead of being refused.
//
// `got` is a store read ({json, sha}) — or, for the stamp this call just
// wrote, {json: <the record whose PUT landed>}. Since 2026-09-22 a green can
// only be minted from a read that judgeRead issued (lib/_verdict.js rule 4),
// so this goes through verdict.judgeWith instead of minting its own. A 404 is
// the CALLER's branch (it answers 404 before getting here); handed one here,
// this throws rather than render "empty" as a stamp.
function judgeStamp(got, sha) {
  const what = "stamp record";
  if (typeof sha !== "string" || !SHA_RE.test(sha)) throw new verdict.VerdictRequiredError("judgeStamp: the fingerprint asked about", sha);
  if (got === null) throw new verdict.VerdictRequiredError("judgeStamp: a stamp read that is not the 404 branch", got);
  return verdict.judgeWith(got, what, (record) => {
    if (record.sha256 !== sha) return "sha256_mismatch";
    if (typeof record.stamped_at !== "string" || !Number.isFinite(Date.parse(record.stamped_at))) return "stamped_at_unreadable";
    return true;
  });
}

function present(stampVerdict, record, { existing, commitSha, billing }) {
  const sha = record.sha256;
  const cfg = stampStore.status();
  return verdict.success(stampVerdict, {
    existing,
    stamp: record,
    scope: SCOPE,
    permalink: `${SITE}/r/${sha}`,
    record_url: `https://github.com/${cfg.repo}/blob/${cfg.branch}/${stampPath(sha)}`,
    history_url: `https://github.com/${cfg.repo}/commits/${cfg.branch}/${stampPath(sha)}`,
    ...(commitSha ? { commit: commitSha } : {}),
    ...(billing ? { billing } : {}),
  }, "stamp");
}

// Judge, then answer: the success body or a 503 refusal, never a guess.
function sendStamp(res, status, got, sha, opts) {
  const v = judgeStamp(got, sha);
  if (!v.ok) {
    const refused = verdict.refusal(v, "stamp");
    return res.status(refused.status).json({ ...refused.body, sha256: sha });
  }
  return res.status(status).json(present(v, got.json, opts));
}

// Take one unit of today's global budget. Returns {ok:true} or {ok:false, ...}.
// Counter first, stamp second: if the stamp write then fails the counter has
// over-counted by one, which errs toward refusing, never toward unlimited.
// `ceiling` is DAILY_CAP for a paid stamp and freeCeiling() for a free one,
// so free traffic runs out of room before the day does. See freeCeiling().
async function takeDailyBudget(nowIso, ceiling = DAILY_CAP) {
  if (DAILY_CAP === 0) return { ok: false, reason: "stamping_disabled", cap: 0, used: 0 };
  // Two callers creating the day's counter at once: the loser gets GitHub's
  // create-race 422 (err.conflict), which putFile does not retry. Re-read and
  // go again, a bounded number of times; past that, refuse (fail closed).
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await takeDailyBudgetOnce(nowIso, ceiling);
    } catch (e) {
      if (!(e && e.conflict) || attempt === 3) throw e;
    }
  }
  throw new Error("unreachable");
}

async function takeDailyBudgetOnce(nowIso, ceiling = DAILY_CAP) {
  const path = dayPath(nowIso);
  // A ceiling below the cap means this is a FREE stamp being measured
  // against the free tier's share, and the refusal must say so — telling a
  // free caller the whole service is out of budget when a key would still
  // be served is the wrong sentence.
  const tier = ceiling < DAILY_CAP ? "free_daily_cap_reached" : "daily_cap_reached";
  const denial = (used) => ({ ok: false, reason: tier, cap: DAILY_CAP, ceiling, used });
  const cur = await stampStore.getFile(path);
  // A day counter that is present but has no readable count used to read as 0:
  // a damaged budget file re-opened the whole day. Now it throws, and the
  // caller's existing catch refuses the stamp (lib/_verdict.js).
  const countOf = (got) => verdict.counterValue(
    verdict.judgeCounter(got, "count", { what: "daily stamp budget", integer: true }), "stamp budget");
  const used = countOf(cur);
  if (used >= ceiling) return denial(used);
  let denied = null;
  await stampStore.putFile(
    path,
    { day: nowIso.slice(0, 10), count: used + 1 },
    `stamp budget ${nowIso.slice(0, 10)}: ${used + 1}`,
    cur ? cur.sha : undefined,
    {
      rebuild: (freshRead) => {
        // putFile hands the rebuild hook the whole store read: null only when
        // the path is gone (404), {json, sha} otherwise. Judged as-is, so a
        // counter whose JSON is the literal null is red, not a fresh day.
        const n = countOf(freshRead);
        if (n >= ceiling) {
          denied = denial(n);
          return null;
        }
        return { day: nowIso.slice(0, 10), count: n + 1 };
      },
    }
  );
  return denied || { ok: true };
}

// ---- paid path: key resolution ---------------------------------------------
// Env-provisioned keys first (a free in-process lookup), then the dynamic
// issued-key store. A store FAILURE is 502, never 401 — "we couldn't check"
// must not read as "your key is invalid" to a paying customer. Same order and
// same reasoning as api/pin.js's auth block.
//
// A stamp has no namespace, so the key's namespace PREFIX is not used for
// anything here; its existence is the whole answer. A key valid for any
// namespace can buy a stamp.
async function resolveKey(req) {
  const auth = (req.headers && req.headers.authorization) || "";
  const key = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!key) return { key: null, valid: false };
  let prefix = store.keyPrefixFor(key);
  if (prefix === null) {
    try {
      prefix = await issuedKeys.issuedKeyPrefix(key);
    } catch (e) {
      return { key, valid: false, storeError: e && e.message };
    }
  }
  return { key, valid: prefix !== null };
}

function applyCors(req, res) {
  // `*` on a write that can be unauthenticated is deliberate and safe to read:
  // the free path carries no bearer key or cookie for a hostile page to ride
  // on, and the PAID path only fires when the caller's own script attaches an
  // Authorization header, which a cross-origin page cannot do on the caller's
  // behalf without already holding the key.
  res.setHeader("access-control-allow-origin", "*");
  if (req.method === "OPTIONS") {
    res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
    res.setHeader("access-control-allow-headers", "content-type, authorization");
    res.setHeader("access-control-max-age", "86400");
    res.status(204).end();
    return true;
  }
  return false;
}

// The fail-closed gate. Called before ANY store touch in either mode.
function storeGate(res) {
  const cfg = stampStore.status();
  if (cfg.configured) return null;
  console.error(`[stamp] refused: stamp record store not configured (${cfg.reason})`);
  res.status(503).json({
    ok: false,
    error:
      "the stamp record is not configured on this deployment, so no stamp can be recorded. " +
      "Nothing was written. Stamps are never written into the witness pins repository.",
    reason: cfg.reason,
    missing_config: cfg.missing,
  });
  return true;
}

async function handleStamp(req, res) {
  if (applyCors(req, res)) return;
  res.setHeader("cache-control", "no-store");

  if (storeGate(res)) return;

  if (req.method === "GET") {
    const raw = req.query && typeof req.query.sha256 === "string" ? req.query.sha256 : "";
    const sha = raw.trim().toLowerCase();
    if (!SHA_RE.test(sha)) {
      return res.status(400).json({ ok: false, error: "sha256 must be exactly 64 hex characters" });
    }
    let found;
    try {
      found = await stampStore.getFile(stampPath(sha));
    } catch (e) {
      console.error("stamp lookup failed:", e && e.message);
      return res.status(503).json({ ok: false, error: "record store unreachable; this is not a 'no'", reason: "store_unreachable" });
    }
    if (!found) {
      return res.status(404).json({ ok: false, stamped: false, sha256: sha, scope: SCOPE,
        note: "No stamp is recorded for this fingerprint. That says nothing about whether the file exists or how old it is." });
    }
    return sendStamp(res, 200, found, sha, { existing: true });
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
  const nowIso = new Date().toISOString();
  const day = nowIso.slice(0, 10);
  const ip = callerIp(req);

  try {
    // FIRST WRITE WINS, AND IT IS FREE. An existing stamp is returned untouched:
    // no budget, no free allowance, and above all NO DEBIT. Re-stamping a
    // fingerprint you already stamped must never cost money — this check sits
    // ahead of every meter on purpose.
    const prior = await stampStore.getFile(path);
    if (prior) return sendStamp(res, 200, prior, v.sha256, { existing: true });

    // --- who pays for this one ---
    //
    // Two independent things can send a caller to the paid path: their own
    // per-address free allowance is used up, OR the free tier's share of
    // today's global budget is gone (the 2026-09-20 reserve — see
    // freeCeiling()). The second one is tried FIRST, because it is the one
    // that takes a unit of the day when it succeeds, and because a caller
    // holding a key must be charged rather than refused when the free share
    // is what ran out. Refusing a key-holder there would make the refusal
    // body's own sentence false.
    const free = freePerDay();
    const usedFree = freeUsedToday(ip, day);
    let charge = null;
    let budget = null;
    let freeShareSpent = false;

    if (usedFree < free) {
      budget = await takeDailyBudget(nowIso, freeCeiling());
      if (!budget.ok) {
        if (budget.reason !== "free_daily_cap_reached") {
          // stamping_disabled, or the whole day's cap — a key cannot help.
          return res.status(429).json({
            ok: false,
            error:
              "this service's global daily stamp budget is used up; try again tomorrow (UTC). " +
              "This cap bounds the writes this deployment makes in a day and applies to paid stamps too — " +
              "a paid stamp is never silently dropped, it is refused here before any charge.",
            ...budget,
          });
        }
        // The free share is spent for today. Nothing was taken (the budget
        // is only incremented on a successful take), so fall through and
        // let a key-holder pay for this one.
        freeShareSpent = true;
        budget = null;
      }
    }

    if (!budget) {
      const resolved = await resolveKey(req);
      if (resolved.storeError) {
        return res.status(502).json({ ok: false, error: `key store error: ${resolved.storeError}`, reason: "key_store_error" });
      }
      if (!resolved.valid) {
        return res.status(401).json({
          ok: false,
          error: freeShareSpent
            ? "this service's FREE daily stamp allowance is used up for today (UTC); the remaining budget " +
              "is held back so free traffic cannot spend the day out from under a paying customer. " +
              "A stamp with a witness key can still be recorded right now."
            : free === 0
              ? "every stamp on this deployment requires a witness key"
              : `the free allowance of ${free} stamp(s) per day for this address is used up; a further stamp requires a witness key`,
          reason: freeShareSpent ? "free_daily_cap_reached" : "key_required",
          free_per_day: free,
          price_credits_per_stamp: STAMP_PRICE_CREDITS,
        });
      }
      // Balance is CHECKED here and DEBITED after the write lands. The check is
      // a read, so an insufficient balance refuses before anything is written;
      // the debit is after, so a failed write never charges.
      let bal;
      try {
        bal = await balance.readBalance(balance.keyHash(resolved.key));
      } catch (e) {
        return res.status(502).json({ ok: false, error: `credit store error: ${e.message}`, reason: "credit_store_error" });
      }
      if (bal.balance < STAMP_PRICE_CREDITS) {
        return res.status(402).json({
          ok: false,
          error: "not enough prepaid credit for a stamp — top up to continue",
          reason: "insufficient_credit",
          credit_balance: bal.balance,
          price_credits_per_stamp: STAMP_PRICE_CREDITS,
          ever_purchased: bal.ever_purchased,
          free_per_day: free,
          free_used_today: usedFree,
          packs: balance.PACKS,
        });
      }
      charge = { key: resolved.key, amount: STAMP_PRICE_CREDITS, balance_before: bal.balance };

      // The balance was checked first (a read), so an insufficient balance
      // refuses without taking a unit of the day. Now take one, against the
      // WHOLE cap — the reserve exists to keep this take available.
      budget = await takeDailyBudget(nowIso, DAILY_CAP);
      if (!budget.ok) {
        return res.status(429).json({
          ok: false,
          error:
            "this service's global daily stamp budget is used up; try again tomorrow (UTC). " +
            "This cap bounds the writes this deployment makes in a day and applies to paid stamps too — " +
            "a paid stamp is never silently dropped, it is refused here before any charge.",
          ...budget,
        });
      }
    }

    const record = { kind: "file-stamp", v: 1, sha256: v.sha256, size: v.size, stamped_at: nowIso };
    let put;
    try {
      put = await stampStore.putFile(path, record, `stamp ${v.sha256.slice(0, 16)}`, undefined, {
        // Someone else stamped this same fingerprint between our read and our
        // write. Theirs is earlier; it stands. Never overwrite.
        rebuild: () => null,
      });
    } catch (e) {
      if (e && e.conflict) put = { abandoned: true };
      else throw e;
    }
    if (put && put.abandoned) {
      // We lost the create race. The winner's record is what exists, so this
      // call recorded nothing — and therefore charges nothing.
      const theirs = await stampStore.getFile(path);
      if (theirs) return sendStamp(res, 200, theirs, v.sha256, { existing: true });
      throw new Error("stamp write lost a race and the winner could not be read back");
    }
    const commitSha = put && put.commit && put.commit.sha;

    // --- the write landed. NOW the meter moves. ---
    let billing;
    if (charge) {
      let d = null;
      let debitError = null;
      try {
        d = await balance.debitCredits(charge.key, charge.amount, `stamp ${v.sha256.slice(0, 16)}`);
      } catch (e) {
        debitError = e && e.message;
      }
      if (d && d.ok) {
        billing = { paid: true, credits_charged: d.amount, credit_balance: d.balance };
        if (d.ledger_write_failed) {
          console.error(`[stamp] ledger write failed for a successful debit: key=${d.key_hash.slice(0, 12)} seq=${d.seq}`);
          billing.ledger_write_failed = true;
        }
      } else {
        // The stamp is already public and cannot be unwritten, so this is a
        // charge WE eat, said out loud rather than hidden. It needs both a
        // balance drained between the check and the debit (or a credit-store
        // outage in that window) AND a stamp in flight; the amount is a tenth
        // of a cent. Erring toward the customer is the right direction here,
        // and an operator can reconcile from this log line.
        console.error(
          `[stamp] STAMP WRITTEN BUT NOT CHARGED sha=${v.sha256.slice(0, 16)} ` +
            `reason=${debitError || (d && d.reason) || "unknown"}`
        );
        billing = {
          paid: false,
          credits_charged: 0,
          charge_failed: true,
          note: "the stamp was recorded and the charge did not go through; you were not billed for it",
        };
      }
    } else {
      const usedNow = noteFreeUsed(ip, day);
      billing = {
        paid: false,
        credits_charged: 0,
        free_per_day: free,
        free_used_today: usedNow,
        free_remaining_today: Math.max(0, free - usedNow),
        note: "free allowance; counted per client address per UTC day, a soft limit",
      };
    }

    // The write landed; the record judged is the one whose PUT succeeded.
    return sendStamp(res, 201, { json: record }, v.sha256, { existing: false, commitSha, billing });
  } catch (e) {
    console.error("stamp failed:", e && e.message);
    return res.status(503).json({ ok: false, error: "could not record the stamp; nothing was written that you should rely on", reason: "store_error" });
  }
}

module.exports = {
  handleStamp,
  validate,
  stampPath,
  SCOPE,
  DAILY_CAP,
  IP_LIMIT,
  STAMP_PRICE_CREDITS,
  freePerDay,
  freeCeiling,
  _resetLimiterForTests,
};
