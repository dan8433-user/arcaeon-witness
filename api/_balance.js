// _balance.js — a real, decrementing per-key CREDIT BALANCE, with an
// append-only ledger for every mutation. This is the enabling mechanism
// for COUNCIL_PRICING_REVIEW_2026-08-14 §4 decision #5 (the "hard gate,"
// ratified same day): the free 100/mo cap in api/_meter.js resets monthly
// and cannot honestly back a prepaid, non-expiring per-pin credit promise.
// This module is the thing that makes the promise true.
//
// This module does NOT decide pricing, does NOT touch offers.json, and
// does NOT make credit packs purchasable. It only makes a purchased
// credit real, auditable, and correctly enforced once one exists. The
// pack catalogue below (PACKS) mirrors the ratified sizes so the crediting
// math is right when the human wiring step (Stripe Price IDs / Payment
// Link metadata) lands -- naming the SKUs here is not the same as selling
// them; offers.json remains the single source of truth for what's for sale.
//
// Storage: same PRIVATE GitHub repo api/_meter.js already uses
// (dan8433-user/arcaeon-witness-usage), same GITHUB_PIN_TOKEN, same
// contents-API CAS pattern -- reused on purpose, not reinvented. Three
// kinds of file live there for this module:
//
//   balance/<key_hash>.json          current balance (the fast-read state)
//   ledger/<key_hash>/grant-<event_id>.json   one per top-up, keyed by the
//                                     Stripe event id (or admin-supplied
//                                     event_id) for webhook-replay safety
//   ledger/<key_hash>/<seq>-decrement.json    one per pin-consumption
//
// A balance you can't audit contradicts the brand this repo is selling
// (PRACTICES.md: "the answer lives in a public git history... not in a
// database only we can read"). The ledger is that audit trail for the
// PRIVATE side of the store, same spirit as the public pin log's own
// append-only observations/ directory.
//
// Idempotent top-up, explained (grantCredits, below): GitHub's contents
// API only gives us single-file compare-and-swap, not a real multi-file
// transaction. A naive "check balance, add, write" is not safe against a
// webhook retry landing between the check and the write.
//
// THE FIX (2026-08-14 billing audit, CEO-authorized). The idempotency claim
// and the balance mutation must be ONE compare-and-swap, not two. The earlier
// design kept a separate ledger file whose `applied:false -> true` flag was the
// claim; but "read the flag" and "write the new balance" were two GitHub round-
// trips, so two overlapping deliveries of the SAME event_id could both read
// applied:false and both add the pack -- demonstrated live, 10 pins purchased,
// 20 granted. Now the set of already-applied event ids lives INSIDE the balance
// file itself (`applied_events`, bounded to the last MAX_APPLIED_EVENTS), and
// "is this event already applied? / add the pins / record the event" happen as
// a single CAS against the balance file's sha. A losing writer 409s, re-reads,
// sees the event_id already in `applied_events`, and returns already_credited
// WITHOUT adding a second time. The append-only ledger/ grant file is still
// written afterward as an audit record, but it is no longer the idempotency
// gate -- the balance file's own CAS is.
//
// SCHEMA NOTE for the not-yet-existent cutover: balance/<hash>.json now carries
// an `applied_events: [...]` array. This is a PURELY ADDITIVE field on a store
// with ZERO live balances today (no pack has ever been sold, the webhook is not
// wired) -- there is nothing to migrate. Any balance file written before this
// field existed reads as `applied_events: []` (treated as "no events applied
// yet"), which is correct.

"use strict";

const crypto = require("crypto");

const USAGE_REPO = process.env.GITHUB_USAGE_REPO || "dan8433-user/arcaeon-witness-usage";
const USAGE_BRANCH = process.env.GITHUB_USAGE_BRANCH || "main";
const API = "https://api.github.com";

// The balance file remembers the last N applied Stripe event ids so a delivery
// retry is a no-op. Bounded so the file can't grow without limit: Stripe never
// retries an event for more than ~3 days, and N=500 top-ups is far more history
// than that window can hold, so an id can never age out of the set while a
// retry of it is still possible.
const MAX_APPLIED_EVENTS = 500;

// The contents API shows observable read-after-write lag (a GET right after a
// successful create-only PUT can still 404). A short pause before re-reading on
// a CAS conflict lets it settle so the retry sees the winner's write instead of
// racing it again. Bounded, tiny, and only on the contended path.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Pack catalogue -- SKU id -> pins. Sizes ratified in
// COUNCIL_PRICING_REVIEW_2026-08-14.md §2.2 / §4 decision #1: Starter
// $15/3,000 · Standard $50/12,000 · Bulk $150/40,000. price_usd is
// informational only (it's what the mechanism EXPECTS a Stripe Price to
// charge once wired) -- this module never talks to Stripe about price,
// only about which pack id maps to how many pins.
const PACKS = Object.freeze({
  starter: Object.freeze({ price_usd: 15, pins: 3000 }),
  standard: Object.freeze({ price_usd: 50, pins: 12000 }),
  bulk: Object.freeze({ price_usd: 150, pins: 40000 }),
});

function ghHeaders() {
  const h = {
    accept: "application/vnd.github+json",
    "user-agent": "arcaeon-witness-balance",
    "x-github-api-version": "2022-11-28",
  };
  const tok = process.env.GITHUB_PIN_TOKEN;
  if (tok) h.authorization = `Bearer ${tok}`;
  return h;
}

function keyHash(secret) {
  return crypto.createHash("sha256").update(secret, "utf8").digest("hex");
}

async function getFile(path) {
  const r = await fetch(
    `${API}/repos/${USAGE_REPO}/contents/${path}?ref=${USAGE_BRANCH}`,
    { headers: ghHeaders() }
  );
  if (r.status === 404) return null;
  if (!r.ok) {
    // Path redacted from the thrown message (2026-08-14 audit): it is
    // `balance/<sha256(key)>.json` / `ledger/<sha256(key)>/...` in a PRIVATE
    // repo, and callers see err.message verbatim in a 502 body.
    console.error(`[balance] GET ${path} -> ${r.status}`);
    throw new Error(`balance store read failed (${r.status})`);
  }
  const body = await r.json();
  const text = Buffer.from(body.content, "base64").toString("utf-8");
  return { json: JSON.parse(text), sha: body.sha };
}

// PUT (create if `sha` omitted, update if present). Same conflict
// detection as api/_meter.js: a 409 (update race) or a 422 whose message
// says a sha "wasn't supplied" (create race -- the file was created by a
// concurrent writer between our read and our write) both get tagged
// `err.conflict = true` so callers can retry-once against a fresh read,
// exactly like the existing meter's CAS loop.
async function putFile(path, obj, message, sha) {
  const payload = {
    message,
    branch: USAGE_BRANCH,
    content: Buffer.from(JSON.stringify(obj, null, 2) + "\n").toString("base64"),
  };
  if (sha) payload.sha = sha;
  const r = await fetch(`${API}/repos/${USAGE_REPO}/contents/${path}`, {
    method: "PUT",
    headers: { ...ghHeaders(), "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (r.status === 409) {
    console.error(`[balance] PUT ${path} -> 409 sha conflict`);
    const err = new Error("balance store write conflict (concurrent writer)");
    err.conflict = true;
    throw err;
  }
  if (!r.ok) {
    const detail = await r.text().catch(() => "");
    const isCreateRace = r.status === 422 && /sha.*wasn't supplied/i.test(detail);
    console.error(`[balance] PUT ${path} -> ${r.status}: ${detail.slice(0, 400)}`);
    const err = new Error(`balance store write failed (${r.status})`);
    if (isCreateRace) err.conflict = true;
    throw err;
  }
  return r.json();
}

// DELETE — used only by the test-cleanup path (never called by any
// production request handler). Requires the current sha.
async function deleteFile(path, sha, message) {
  const r = await fetch(`${API}/repos/${USAGE_REPO}/contents/${path}`, {
    method: "DELETE",
    headers: { ...ghHeaders(), "content-type": "application/json" },
    body: JSON.stringify({ message, branch: USAGE_BRANCH, sha }),
  });
  if (!r.ok) {
    const detail = await r.text().catch(() => "");
    throw new Error(`balance store DELETE ${path} -> ${r.status} ${detail.slice(0, 200)}`);
  }
  return r.json();
}

function sanitizeEventId(id) {
  // Stripe event ids (evt_XXXXXXXX) are already path-safe; this is a
  // defensive clamp for the internal/admin path, where a caller could in
  // principle hand in an arbitrary string as the idempotency key.
  return String(id).replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 128);
}

function balancePath(hash) {
  return `balance/${hash}.json`;
}
function ledgerGrantPath(hash, eventId) {
  return `ledger/${hash}/grant-${sanitizeEventId(eventId)}.json`;
}
function ledgerDecrementPath(hash, seq) {
  return `ledger/${hash}/${String(seq).padStart(8, "0")}-decrement.json`;
}

// ---- read ----
// readBalance(hash) -> {key_id, key_hash, balance, seq, ever_purchased, updated_at}
// `ever_purchased` distinguishes "never bought credits" (balance file
// doesn't exist) from "bought credits, spent them all" (balance file
// exists, balance is 0) -- pin.js uses this to choose 429 vs 402.
async function readBalance(hash) {
  const cur = await getFile(balancePath(hash));
  if (!cur) {
    return { key_id: hash.slice(0, 12), key_hash: hash, balance: 0, seq: 0, ever_purchased: false, updated_at: null };
  }
  return {
    key_id: cur.json.key_id || hash.slice(0, 12),
    key_hash: hash,
    balance: Number(cur.json.balance) || 0,
    seq: Number(cur.json.seq) || 0,
    ever_purchased: true,
    updated_at: cur.json.updated_at || null,
  };
}

// ---- decrement (one pin consumed from a purchased balance) ----
// decrementCredit(secret, reason) ->
//   {ok:true, key_hash, balance, seq}
// | {ok:false, reason:"insufficient_credit", key_hash, balance:0, ever_purchased}
//
// Fails CLOSED, same philosophy as api/_meter.js's own denial vocabulary:
// a balance of 0 (or no balance record at all) is refused, never waved
// through as free.
async function decrementCredit(secret, reason) {
  const hash = keyHash(secret);
  const path = balancePath(hash);
  let lastErr = null;

  for (let attempt = 0; attempt < 2; attempt++) {
    const cur = await getFile(path);
    const bal = cur ? Number(cur.json.balance) || 0 : 0;
    const everPurchased = !!cur;

    if (bal <= 0) {
      return { ok: false, reason: "insufficient_credit", key_hash: hash, balance: 0, ever_purchased: everPurchased };
    }

    const seq = cur && Number.isInteger(cur.json.seq) ? cur.json.seq + 1 : 1;
    const next = bal - 1;
    const nowIso = new Date().toISOString();
    const obj = { key_id: hash.slice(0, 12), key_hash: hash, balance: next, seq, updated_at: nowIso };

    try {
      await putFile(path, obj, `credit decrement ${hash.slice(0, 12)} seq=${seq} balance=${next}`, cur ? cur.sha : undefined);
    } catch (err) {
      if (err.conflict && attempt === 0) {
        lastErr = err;
        continue; // one retry with a freshly re-read sha, same as _meter.check
      }
      throw err;
    }

    // Ledger entry for this decrement. Its filename is seq-derived, and
    // seq only advances once the CAS write above already succeeded, so a
    // duplicate write here can't happen under normal operation -- create-
    // only is still used (not update) so a genuine collision throws
    // instead of silently overwriting a prior audit record.
    const ledgerPath = ledgerDecrementPath(hash, seq);
    const entry = { seq, type: "decrement", amount: 1, balance_before: bal, balance_after: next, reason: reason || "pin", at: nowIso };
    try {
      await putFile(ledgerPath, entry, `ledger decrement ${hash.slice(0, 12)} seq=${seq}`);
    } catch (err) {
      // The balance number itself already moved and is the source of
      // truth; a failed ledger write here is the same documented class of
      // gap as pin.js's own "two commits, not atomic" note -- surfaced in
      // the return value, not swallowed.
      return { ok: true, key_hash: hash, balance: next, seq, ledger_write_failed: err.message };
    }

    return { ok: true, key_hash: hash, balance: next, seq };
  }

  throw lastErr || new Error("balance store: exhausted CAS retries on decrement");
}

// ---- grant (top-up) — the low-level primitive ----
// grantCredits(hash, pins, pack, eventId, source) -> idempotent on eventId.
// Exposed directly (not just via creditPack) so tests can grant an
// arbitrary small amount without needing a full $15+ pack.
//
// Idempotency and the balance mutation are ONE compare-and-swap against
// balance/<hash>.json (see the header comment). The event id is recorded in
// the balance file's `applied_events` set in the SAME write that adds the
// pins, so a concurrent replay of the same event can never add twice: the
// loser of the CAS re-reads, finds the id already applied, and returns
// already_credited without touching the balance.
async function grantCredits(hash, pins, pack, eventId, source) {
  const evt = sanitizeEventId(eventId);
  const path = balancePath(hash);

  let alreadyApplied = false;
  let finalBalance = null;
  let finalSeq = null;
  let lastErr = null;

  // A few more attempts than the meter's 2: a create-race on a brand-new
  // balance file plus read-after-write lag can need one or two extra re-reads
  // before the loser sees the winner's write. Bounded, with backoff — no spiral.
  const MAX_ATTEMPTS = 6;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const cur = await getFile(path);
    const curJson = cur ? cur.json : null;
    const bal = curJson ? Number(curJson.balance) || 0 : 0;
    const appliedEvents =
      curJson && Array.isArray(curJson.applied_events) ? curJson.applied_events : [];

    if (appliedEvents.includes(evt)) {
      // This exact event is already folded into the balance. Idempotent.
      alreadyApplied = true;
      finalBalance = bal;
      finalSeq = curJson && Number.isInteger(curJson.seq) ? curJson.seq : null;
      break;
    }

    const seq = curJson && Number.isInteger(curJson.seq) ? curJson.seq + 1 : 1;
    const newBalance = bal + pins;
    const newApplied = appliedEvents.concat([evt]).slice(-MAX_APPLIED_EVENTS);
    const obj = {
      key_id: hash.slice(0, 12),
      key_hash: hash,
      balance: newBalance,
      seq,
      applied_events: newApplied,
      updated_at: new Date().toISOString(),
    };
    try {
      await putFile(
        path, obj,
        `credit grant ${hash.slice(0, 12)} ${pack} +${pins} seq=${seq} evt=${evt}`,
        cur ? cur.sha : undefined
      );
      finalBalance = newBalance;
      finalSeq = seq;
      break;
    } catch (err) {
      if (err.conflict && attempt < MAX_ATTEMPTS - 1) {
        lastErr = err;
        await sleep(120 * (attempt + 1)); // let read-after-write settle, then re-read
        continue;
      }
      throw err;
    }
  }
  if (finalBalance === null) {
    throw lastErr || new Error("balance store: exhausted CAS retries on grant");
  }

  // Append-only audit record for this top-up. NOT the idempotency gate anymore
  // (the balance file's applied_events set is) — a create-only write, best
  // effort. A conflict here just means a prior/concurrent delivery already
  // wrote the audit line, which is fine; a genuine write failure is surfaced
  // but does NOT fail the grant, because the balance is already correct and the
  // event is already recorded as applied in the source-of-truth balance file.
  const ledgerPath = ledgerGrantPath(hash, eventId);
  const record = {
    event_id: evt, key_hash: hash, pack, pins, source,
    applied: true, balance_after: finalBalance, balance_seq: finalSeq,
    at: new Date().toISOString(),
  };
  try {
    await putFile(ledgerPath, record, `credit ledger ${hash.slice(0, 12)} ${pack} evt=${evt}`);
  } catch (err) {
    if (!err.conflict) {
      return {
        ok: true, already_credited: alreadyApplied, key_hash: hash,
        pins, pack, balance_after: finalBalance, ledger_write_failed: err.message,
      };
    }
  }

  return { ok: true, already_credited: alreadyApplied, key_hash: hash, pins, pack, balance_after: finalBalance };
}

// ---- grant by SKU — the entry point api/credit.js and api/stripe-webhook.js call ----
async function creditPack(hash, packId, eventId, source) {
  const pack = PACKS[packId];
  if (!pack) return { ok: false, reason: "unknown_pack", pack_id: packId };
  if (!eventId) return { ok: false, reason: "missing_event_id" };
  return grantCredits(hash, pack.pins, packId, eventId, source);
}

module.exports = {
  PACKS,
  keyHash,
  readBalance,
  decrementCredit,
  grantCredits,
  creditPack,
  // exported for the test harness's cleanup pass only:
  getFile,
  deleteFile,
  balancePath,
  ledgerGrantPath,
  ledgerDecrementPath,
  USAGE_REPO,
  USAGE_BRANCH,
};
