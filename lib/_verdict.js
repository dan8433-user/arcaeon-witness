// lib/_verdict.js — the verdict is a REQUIRED argument, never a default.
//
// The defect class this closes (found 2026-09-19/20 in the receipt proxy's
// health endpoint, one repo over): a library verify step said "this ledger is
// broken" and a wrapper above it ignored that and built a well-formed success
// out of DEFAULT values — rows 0, chain "genesis", ok true. A damaged log read
// as a brand-new one. The patch fixed the call site. This file is for the
// class: in this codebase a success-shaped answer about a stored record can be
// built only by handing over an explicit verdict about that record.
//
// Three rules, all enforced by throwing rather than by convention:
//   1. No verdict, no answer. requireVerdict(undefined) THROWS. Nothing in
//      this file has a default value for ok / state / value.
//   2. Red never renders green. success() and counterValue() THROW on a red
//      verdict; the caller has to take the red branch on purpose.
//   3. Empty is a verdict, not a fallthrough. A brand-new namespace, a key
//      that never bought credit, a day with no stamps yet — those are real
//      states, and they are reachable ONLY through verifiedEmpty(), which the
//      judges below mint in exactly one situation: the store said 404 (the
//      readers return null for that and for nothing else). A document that is
//      present but unreadable is RED. "Nothing there" and "something there I
//      cannot read" never share a value.
//
// Not an endpoint: lives in lib/ (Vercel Hobby's 12-function cap counts api/).

"use strict";

const STATES = Object.freeze({
  RECORD: "verified_record", // a stored document was read and has the shape it must have
  EMPTY: "verified_empty",   // the store answered 404: nothing has been recorded yet
});

class VerdictRequiredError extends Error {
  constructor(where, got) {
    const shape = got === null ? "null" : Array.isArray(got) ? "array" : typeof got;
    super(
      `${where || "verdict"}: a verdict is required and none was given (got ${shape}) — ` +
      "refusing to build an answer from defaults"
    );
    this.name = "VerdictRequiredError";
    this.code = "verdict_required";
  }
}

class RedVerdictError extends Error {
  constructor(where, verdict) {
    super(`${where || "verdict"}: red verdict (${verdict.reason}) cannot be rendered as a success`);
    this.name = "RedVerdictError";
    this.code = "red_verdict";
    this.verdict = verdict;
  }
}

// ---- the three ways to mint a verdict ----
function verifiedRecord(what, extra) {
  return Object.freeze({ ...(extra || {}), ok: true, state: STATES.RECORD, what: String(what) });
}
function verifiedEmpty(what, extra) {
  return Object.freeze({ ...(extra || {}), ok: true, state: STATES.EMPTY, what: String(what) });
}
function red(what, reason, detail) {
  if (typeof reason !== "string" || !reason) {
    throw new VerdictRequiredError(`red(${what})`, reason);
  }
  return Object.freeze({ ok: false, what: String(what), reason, detail: detail ? String(detail) : null });
}

// Throws unless `v` is an object whose `ok` is an explicit boolean — and, when
// green, names WHICH green it is. `{}`, `undefined`, `{ok: 1}`, `{ok: true}`
// with no state: all thrown. Returns the verdict so it can be used inline.
function requireVerdict(v, where) {
  if (!v || typeof v !== "object" || Array.isArray(v) || typeof v.ok !== "boolean") {
    throw new VerdictRequiredError(where, v);
  }
  if (v.ok === true && v.state !== STATES.RECORD && v.state !== STATES.EMPTY) {
    throw new VerdictRequiredError(`${where || "verdict"} (green without a state)`, v.state);
  }
  if (v.ok === false && (typeof v.reason !== "string" || !v.reason)) {
    throw new VerdictRequiredError(`${where || "verdict"} (red without a reason)`, v.reason);
  }
  return v;
}

function requireGreen(v, where) {
  requireVerdict(v, where);
  if (!v.ok) throw new RedVerdictError(where, v);
  return v;
}

function isEmpty(v, where) {
  return requireVerdict(v, where).ok === true && v.state === STATES.EMPTY;
}

// The ONLY constructor of an `ok: true` body on the record-reading endpoints.
// `fields` may not smuggle its own `ok`.
function success(v, fields, where) {
  requireGreen(v, where || "success");
  if (fields && Object.prototype.hasOwnProperty.call(fields, "ok")) {
    throw new TypeError("success(): `ok` comes from the verdict, never from the fields");
  }
  return { ok: true, ...(fields || {}) };
}

// The red branch, as a response. 503: the store answered, and what it holds
// cannot be read as the record it should be. Never 200, never a 404 (a 404
// here would say "nothing recorded", which is the lie this file exists for).
function refusal(v, where) {
  requireVerdict(v, where || "refusal");
  if (v.ok) throw new TypeError("refusal(): verdict is green; there is nothing to refuse");
  return {
    status: 503,
    body: {
      ok: false,
      error: `stored ${v.what} is present but cannot be read as a valid record`,
      reason: v.reason,
      ...(v.detail ? { detail: v.detail } : {}),
      note:
        "this is NOT 'nothing recorded' and NOT a refutation: something is stored here and it does not have " +
        "the shape it must have, so this service declines to answer from it. The commit history of the " +
        "public repo is the authority.",
    },
  };
}

function isPlainObject(x) {
  return !!x && typeof x === "object" && !Array.isArray(x);
}

// ---- judges: a store read in, a verdict out ----
//
// `got` is exactly what the store readers return: null (404) or {json, sha}.
// `undefined` is neither — it means the caller never did the read — and throws.
function judgeRead(got, what) {
  if (got === undefined) throw new VerdictRequiredError(`judge(${what}): no store read was passed`, got);
  if (got === null) return verifiedEmpty(what);
  if (!isPlainObject(got) || !isPlainObject(got.json)) {
    return red(what, "not_a_json_object");
  }
  return null; // present and an object: the caller's shape rules decide
}

const CHAIN_RE = /^[0-9a-fA-F]{8,64}$/; // same rule as lib/_store.js CHAIN_RE (kept local: _store requires nothing from here, and this file requires nothing at all)

// A stored pin record (pins/<ns>/latest.json or a numbered seq record). Every
// record this service has ever written carries these four fields (they are in
// the first commit of api/pin.js), so none of them is "legacy-optional".
function judgePin(got, { what = "pin record", namespace = null } = {}) {
  const early = judgeRead(got, what);
  if (early) return early;
  const p = got.json;
  if (!Number.isSafeInteger(p.rows) || p.rows < 1) return red(what, "rows_unreadable");
  if (typeof p.chain !== "string" || !CHAIN_RE.test(p.chain)) return red(what, "chain_unreadable");
  if (!Number.isSafeInteger(p.seq) || p.seq < 1) return red(what, "seq_unreadable");
  if (namespace !== null && p.namespace !== namespace) return red(what, "namespace_mismatch");
  return verifiedRecord(what);
}

// A stored counter document (credit balance, monthly usage, a day's stamp
// budget). 404 -> verified empty, value 0. Present with a readable number ->
// that number. Present WITHOUT one -> red. `|| 0` is the expression this
// replaces: it read a damaged balance as "never bought anything", and a
// damaged usage counter as "has used nothing this month" — the second one
// fails OPEN.
function judgeCounter(got, field, { what = "counter", integer = false } = {}) {
  const early = judgeRead(got, what);
  if (early) return early.ok ? verifiedEmpty(what, { value: 0 }) : early;
  const n = got.json[field];
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0 || (integer && !Number.isInteger(n))) {
    return red(what, `${field}_unreadable`);
  }
  return verifiedRecord(what, { value: n });
}

// The number out of a counter verdict. Throws on red and on no-verdict, so a
// caller cannot reach a number without having looked.
function counterValue(v, where) {
  requireGreen(v, where || "counterValue");
  if (typeof v.value !== "number") throw new VerdictRequiredError(`${where || "counterValue"} (verdict carries no value)`, v.value);
  return v.value;
}

// A listing the GitHub API must answer with an array. A 200 that is not an
// array (the path is a file, or the body is not what we think it is) used to
// read as "an empty directory" — the listing twin of rows:0/chain:genesis.
function requireListing(body, what) {
  if (!Array.isArray(body)) {
    const err = new Error(`${what}: the store answered 200 but not with a listing — refusing to read that as empty`);
    err.code = "listing_unreadable";
    throw err;
  }
  return body;
}

module.exports = {
  STATES,
  VerdictRequiredError,
  RedVerdictError,
  verifiedRecord,
  verifiedEmpty,
  red,
  requireVerdict,
  requireGreen,
  isEmpty,
  success,
  refusal,
  judgePin,
  judgeCounter,
  counterValue,
  requireListing,
};
