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
// webhook retry landing between the check and the write. Instead the
// ledger entry for a grant IS the atomic claim: it's created FIRST via a
// create-only PUT keyed by event_id (a second writer racing the same
// event_id gets a 409/422 and backs off, exactly like _meter.js's CAS
// loop), written with `applied:false`, and only flipped to `applied:true`
// once the balance file has actually been updated. A crash between those
// two steps leaves a `applied:false` claim behind; a retry of the SAME
// event_id finds it and *completes* the mutation rather than re-doing it
// or silently dropping it -- self-healing, same idiom as pin.js's own
// documented "two commits, not atomic, self-heals on the next pin."

"use strict";

const crypto = require("crypto");

const USAGE_REPO = process.env.GITHUB_USAGE_REPO || "dan8433-user/arcaeon-witness-usage";
const USAGE_BRANCH = process.env.GITHUB_USAGE_BRANCH || "main";
const API = "https://api.github.com";

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
async function grantCredits(hash, pins, pack, eventId, source) {
  const ledgerPath = ledgerGrantPath(hash, eventId);
  let entry = await getFile(ledgerPath);

  if (!entry) {
    const draft = {
      event_id: eventId, key_hash: hash, pack, pins, source,
      applied: false, claimed_at: new Date().toISOString(),
    };
    try {
      // Build `entry` straight from the PUT response's own sha rather than
      // re-GETting the file — the contents API showed observable read-
      // after-write lag in testing (a GET immediately after a successful
      // create-only PUT returned 404), so re-reading here was a real race,
      // not a defensive nicety.
      const put = await putFile(ledgerPath, draft, `credit claim ${hash.slice(0, 12)} ${pack} evt=${eventId}`);
      entry = { json: draft, sha: put.content.sha };
    } catch (err) {
      if (err.conflict) {
        // Someone else (a concurrent replay, most likely) already claimed
        // this event_id between our GET and our create. Re-read and fall
        // through to the applied-check below instead of erroring.
        entry = await getFile(ledgerPath);
        if (!entry) throw err;
      } else {
        throw err;
      }
    }
  }

  if (entry.json.applied === true) {
    return {
      ok: true, already_credited: true, key_hash: hash,
      pins: entry.json.pins, pack: entry.json.pack, balance_after: entry.json.balance_after,
    };
  }

  // Complete the claim: CAS-add `pins` onto balance/<hash>.json.
  const path = balancePath(hash);
  let lastErr = null;
  let newBalance = null;
  let newSeq = null;

  for (let attempt = 0; attempt < 2; attempt++) {
    const cur = await getFile(path);
    const bal = cur ? Number(cur.json.balance) || 0 : 0;
    const seq = cur && Number.isInteger(cur.json.seq) ? cur.json.seq + 1 : 1;
    newBalance = bal + pins;
    newSeq = seq;
    const obj = { key_id: hash.slice(0, 12), key_hash: hash, balance: newBalance, seq, updated_at: new Date().toISOString() };
    try {
      await putFile(path, obj, `credit grant ${hash.slice(0, 12)} ${pack} +${pins} seq=${seq}`, cur ? cur.sha : undefined);
      break;
    } catch (err) {
      if (err.conflict && attempt === 0) {
        lastErr = err;
        newBalance = null;
        continue;
      }
      throw err;
    }
  }
  if (newBalance === null) throw lastErr || new Error("balance store: exhausted CAS retries on grant");

  const finalEntry = { ...entry.json, applied: true, balance_after: newBalance, balance_seq: newSeq, applied_at: new Date().toISOString() };
  await putFile(ledgerPath, finalEntry, `credit applied ${hash.slice(0, 12)} ${pack} evt=${eventId}`, entry.sha);

  return { ok: true, already_credited: false, key_hash: hash, pins, pack, balance_after: newBalance };
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
