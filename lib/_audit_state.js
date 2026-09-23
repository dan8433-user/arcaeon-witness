// _audit_state.js — derive a record's AUDIT STATE from its check records,
// and render the exact strings the design page specifies.
// Underscore prefix = not routed as a serverless function by Vercel.
//
// Design page: projects/online_business/DESIGN_CONSISTENCY_AND_NEVER_LOOKED_
// 2026-09-22.md, part B (B3 states, B5 "not the operator", B6 decay, B7
// rendering). Two axes, never merged: a CHECK RESULT is one run (VERIFIED /
// BROKEN / COULD_NOT_LOOK, lib/_check_record.js); an AUDIT STATE is a
// property of a RECORD derived only from the list of check results on it.
// Nothing here is ever set by hand.
//
//   BLIND         no verifiable check result, by anyone. The default for
//                 every record that exists today.
//   SELF-CHECKED  results exist only from keys declared as the operator's own
//   CHECKED       at least one VERIFIED from a key NOT declared ours, fresh
//                 (< 30 days), tool and key not withdrawn, no standing BROKEN
//   STALE         CHECKED once, now past freshness, or its tool/key withdrawn
//   BROKEN        any verifiable BROKEN result, from anyone, including us,
//                 whose tool and key have not been withdrawn
//
// Precedence (B3): BROKEN, then CHECKED, then STALE, then SELF-CHECKED, then
// BLIND. A reproducible BROKEN is permanent: a later VERIFIED does not clear
// it. The only way out is the BROKEN itself being shown wrong (its tool
// withdrawn, or its key withdrawn), and both results stay on the record.
//
// Every interpretive choice where the page left room is written down in
// DISAGREEMENTS_audit_state.md at the repo root, and every one of them was
// resolved the same way: a state is never upgraded without evidence.
//
// This module is pure: no I/O, no clock of its own (`nowSeconds` is passed
// in), no HTML. lib/_audit_status.js does the store reads and the HTML.

"use strict";

const { verifyCheckRecord, targetNamespace } = require("./_check_record.js");

const STATES = Object.freeze({
  BLIND: "BLIND",
  SELF_CHECKED: "SELF-CHECKED",
  CHECKED: "CHECKED",
  STALE: "STALE",
  BROKEN: "BROKEN",
});
const STATE_ORDER = Object.freeze([STATES.BLIND, STATES.SELF_CHECKED, STATES.CHECKED, STATES.STALE, STATES.BROKEN]);

// B6: "A record is CHECKED while its most recent independent VERIFIED is
// less than 30 days old, compared in integer seconds with no float."
const FRESH_WINDOW_SECONDS = 30 * 86400;

function toolKey(rec) {
  return `${rec.tool.name}@${rec.tool.version}`;
}
function secondsOf(rec) {
  return Math.floor(Date.parse(rec.checked_at) / 1000);
}
function newestOf(list) {
  return list.reduce((best, r) => (!best || secondsOf(r) > secondsOf(best) ? r : best), null);
}
function isoOf(rec) {
  return rec ? rec.checked_at : null;
}
function daysBetween(nowSeconds, thenSeconds) {
  return Math.floor((nowSeconds - thenSeconds) / 86400);
}

// records         array of check records (signed JSON, as read from the repo)
// opts.ownKeys    Set of key ids declared as the operator's own (B5)
// opts.ownKeysUnknown  true when the declaration could not be read. Then
//                 EVERY key is treated as ours, so CHECKED is unreachable
//                 (an unreadable declaration is not evidence of independence)
// opts.withdrawnTools  Set of "name@version" strings (B6 immediate demotion)
// opts.withdrawnKeys   Set of key ids withdrawn by their owner or shown ours
// opts.nowSeconds integer epoch seconds
// opts.skewSeconds     passed to verifyCheckRecord
//
// Returns a plain object; `state` is one of STATES. Counts carry their
// denominator: `records` is everything handed in, `unverifiable` is what
// failed signature/shape/clock and was ignored, `could_not_look` is counted
// and never changes the state (a failed look is not a look).
function deriveAuditState(records, opts = {}) {
  const nowSeconds = Number.isInteger(opts.nowSeconds) ? opts.nowSeconds : Math.floor(Date.now() / 1000);
  const ownKeys = opts.ownKeys instanceof Set ? opts.ownKeys : new Set(opts.ownKeys || []);
  const ownKeysUnknown = opts.ownKeysUnknown === true;
  const withdrawnTools = opts.withdrawnTools instanceof Set ? opts.withdrawnTools : new Set(opts.withdrawnTools || []);
  const withdrawnKeys = opts.withdrawnKeys instanceof Set ? opts.withdrawnKeys : new Set(opts.withdrawnKeys || []);
  const list = Array.isArray(records) ? records : [];

  const valid = [];
  const unverifiable = [];
  for (const r of list) {
    const v = verifyCheckRecord(r, { nowSeconds, skewSeconds: opts.skewSeconds });
    if (v.ok) valid.push(r); else unverifiable.push({ record: r, reason: v.reason, field: v.field });
  }

  const isOwn = (r) => ownKeysUnknown || ownKeys.has(r.checker.key);
  const isWithdrawn = (r) => withdrawnTools.has(toolKey(r)) || withdrawnKeys.has(r.checker.key);
  const isFresh = (r) => nowSeconds - secondsOf(r) < FRESH_WINDOW_SECONDS;

  const broken = valid.filter((r) => r.result === "BROKEN");
  const brokenStanding = broken.filter((r) => !isWithdrawn(r));
  const brokenWithdrawn = broken.filter(isWithdrawn);
  const verifiedOutside = valid.filter((r) => r.result === "VERIFIED" && !isOwn(r));
  const verifiedOutsideLive = verifiedOutside.filter((r) => !isWithdrawn(r));
  const verifiedOutsideFresh = verifiedOutsideLive.filter(isFresh);
  const verifiedOwn = valid.filter((r) => r.result === "VERIFIED" && isOwn(r));
  const verifiedOwnLive = verifiedOwn.filter((r) => !isWithdrawn(r));
  const couldNotLook = valid.filter((r) => r.result === "COULD_NOT_LOOK");

  const newestOutside = newestOf(verifiedOutsideLive) || newestOf(verifiedOutside);
  const newestOwn = newestOf(verifiedOwnLive);
  const newestBroken = newestOf(brokenStanding);

  let state;
  let stale_reason = null;
  if (brokenStanding.length) {
    state = STATES.BROKEN;
  } else if (verifiedOutsideFresh.length) {
    state = STATES.CHECKED;
  } else if (verifiedOutside.length) {
    state = STATES.STALE;
    stale_reason = verifiedOutsideLive.length ? "past_window" : "withdrawn";
  } else if (verifiedOwnLive.length) {
    state = STATES.SELF_CHECKED;
  } else {
    state = STATES.BLIND;
  }

  const outsideKeys = [];
  const seen = new Set();
  for (const r of (state === STATES.CHECKED ? verifiedOutsideFresh : verifiedOutsideLive)) {
    if (seen.has(r.checker.key)) continue;
    seen.add(r.checker.key);
    outsideKeys.push({ key: r.checker.key, name: r.checker.name, binding_url: r.checker.binding_url });
  }

  return {
    state,
    stale_reason,
    own_keys_unknown: ownKeysUnknown,
    counts: {
      records: list.length,
      unverifiable: unverifiable.length,
      verified_outside: verifiedOutside.length,
      verified_own: verifiedOwn.length,
      broken: brokenStanding.length,
      broken_withdrawn: brokenWithdrawn.length,
      could_not_look: couldNotLook.length,
      withdrawn: valid.filter(isWithdrawn).length,
    },
    last_outside_verified_at: isoOf(newestOutside),
    last_own_verified_at: isoOf(newestOwn),
    last_broken_at: isoOf(newestBroken),
    days_since_outside_verified: newestOutside ? daysBetween(nowSeconds, secondsOf(newestOutside)) : null,
    outside_keys: outsideKeys,
    broken_evidence: newestBroken
      ? { checked_at: newestBroken.checked_at, key: newestBroken.checker.key, name: newestBroken.checker.name, detail: newestBroken.detail, rerun: newestBroken.rerun }
      : null,
    unverifiable_reasons: unverifiable.map((u) => `${u.reason}:${u.field}`),
  };
}

// Filter a mixed list to the records about one namespace.
function recordsForNamespace(records, ns) {
  return (Array.isArray(records) ? records : []).filter((r) => targetNamespace(r) === ns);
}

// ---------------------------------------------------------------------------
// rendering (strings only; B7, wording rule: UNALTERED, never "true")
// ---------------------------------------------------------------------------
function badgeString(derived) {
  switch (derived.state) {
    case STATES.CHECKED: return `UNALTERED, checked ${derived.days_since_outside_verified} days ago`;
    default: return derived.state;
  }
}

function keyNames(derived) {
  return derived.outside_keys.map((k) => k.name || k.key).join(", ");
}

// The line under the badge. `rerun` is the command a reader can run
// themselves; it is the reader's door out of BLIND, so it is never omitted.
function lineUnder(derived, { rerun = "<command>" } = {}) {
  const d = derived;
  switch (d.state) {
    case STATES.BLIND:
      return `No one has checked this record. It was registered, and registering is a claim, not a check. Check it yourself: ${rerun}`;
    case STATES.SELF_CHECKED:
      return `Only the operator's own checker has looked, most recently ${d.last_own_verified_at}. That is not an outside check.`;
    case STATES.CHECKED: {
      const n = d.outside_keys.length;
      return `Found unaltered on ${d.last_outside_verified_at} by ${n} key${n === 1 ? "" : "s"} not declared as ours: ${keyNames(d)}. This says the record was not rewritten. It does not say the record is true.`;
    }
    case STATES.STALE:
      return `Last found unaltered by an outside key on ${d.last_outside_verified_at}, ${d.days_since_outside_verified} days ago. Nothing since. Treat it as unchecked.`;
    case STATES.BROKEN: {
      const ev = d.broken_evidence;
      return `A check on ${ev.checked_at} found this record does not match. Re-run it: ${ev.rerun}. Both records are kept.`;
    }
    default:
      throw new Error(`audit_state: unknown state ${d.state}`);
  }
}

// B7: "Every aggregate names BLIND first." Stale is included because a
// count that hides amber is the same lie as a count that hides grey.
function countStates(deriveds) {
  const c = { total: 0, blind: 0, self_checked: 0, checked: 0, stale: 0, broken: 0 };
  for (const d of deriveds) {
    c.total += 1;
    if (d.state === STATES.BLIND) c.blind += 1;
    else if (d.state === STATES.SELF_CHECKED) c.self_checked += 1;
    else if (d.state === STATES.CHECKED) c.checked += 1;
    else if (d.state === STATES.STALE) c.stale += 1;
    else if (d.state === STATES.BROKEN) c.broken += 1;
  }
  return c;
}

function aggregateLine(deriveds, { noun = "records" } = {}) {
  const c = countStates(deriveds);
  return `${c.total} ${noun}: ${c.blind} blind, ${c.self_checked} self-checked, ${c.checked} checked, ${c.stale} stale, ${c.broken} broken.`;
}

// "N of M claims checked" — the headline that counts what was looked at.
function checkedOfLine(deriveds, { noun = "records" } = {}) {
  const c = countStates(deriveds);
  return `${c.checked} of ${c.total} ${noun} checked by a key not declared as ours.`;
}

module.exports = {
  STATES, STATE_ORDER, FRESH_WINDOW_SECONDS,
  deriveAuditState, recordsForNamespace,
  badgeString, lineUnder, countStates, aggregateLine, checkedOfLine,
};
