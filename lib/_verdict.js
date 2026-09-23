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
//   4. (2026-09-22) A green is bound to a read. judgeRead is the only thing
//      that issues a read_id, and every green verdict carries the read_id of
//      the store read it was judged from. requireVerdict / requireGreen /
//      success() refuse a green that carries no read_id, or one this module
//      did not mint. A hand-built {ok: true, state: "verified_record"} cannot
//      be rendered: there is no public constructor of a green any more.
//   5. (2026-09-22) judgeRead never returns null. A read that is present and
//      an object used to come back as null ("the caller's shape rules
//      decide"), which a future raw caller could read as green: the default
//      rule 1 forbids, reintroduced one layer down. It now comes back as the
//      typed verdict `present_unchecked`, which is NOT green; requireGreen
//      refuses it by name. Only a judge with shape rules (judgePin,
//      judgeCounter, judgeWith) turns it into a record or a red.
//   Rules 4 and 5 were raised by atomic-raven on the Colony (post 42b8d6e0);
//   our reply, comment 43bed67b, said we would make them as he described.
//
// Not an endpoint: lives in lib/ (Vercel Hobby's 12-function cap counts api/).

"use strict";

const STATES = Object.freeze({
  RECORD: "verified_record", // a stored document was read and has the shape it must have
  EMPTY: "verified_empty",   // the store answered 404: nothing has been recorded yet
  UNCHECKED: "present_unchecked", // the store answered with an object; no shape rule has judged it. NOT green.
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

// A green that was not minted from a judged read. Subclass of
// VerdictRequiredError on purpose: an unbound green is not a verdict.
class UnboundVerdictError extends VerdictRequiredError {
  constructor(where, why) {
    super(where, undefined);
    this.message =
      `${where || "verdict"}: green verdict is not bound to a store read (${why}) — ` +
      "only a judge over a read that judgeRead issued can mint a green";
    this.name = "UnboundVerdictError";
    this.code = "verdict_unbound";
  }
}

// A present read that no shape rule has judged, handed to something that
// needed green. Named, so the log says WHICH mistake it was.
class PresentUncheckedError extends Error {
  constructor(where, v) {
    super(
      `${where || "verdict"}: the store read of ${v.what} is present but no shape rule has judged it ` +
      "(present_unchecked) — refusing to treat 'present and an object' as green"
    );
    this.name = "PresentUncheckedError";
    this.code = "present_unchecked";
    this.verdict = v;
  }
}

// ---- read binding ----
// ISSUED_READS holds every read_id judgeRead has handed out. BOUND maps each
// verdict this module minted from a read to that read_id. Both are private:
// nothing outside this file can add to them, so a verdict object built
// anywhere else (a literal, a spread copy, a frozen clone) is never in BOUND.
const ISSUED_READS = new Set();
const BOUND = new WeakMap();
let readSeq = 0;

function issueReadId() {
  readSeq += 1;
  const id = `read-${readSeq.toString(36)}`;
  ISSUED_READS.add(id);
  return id;
}

function mintBound(body, readId) {
  if (typeof readId !== "string" || !ISSUED_READS.has(readId)) {
    throw new UnboundVerdictError(`mint(${body.what})`, "read_id was not issued by judgeRead");
  }
  const v = Object.freeze({ ...body, read_id: readId });
  BOUND.set(v, readId);
  return v;
}

// ---- minting ----
// Greens are minted only here, only from a read_id judgeRead issued. There is
// no exported verifiedRecord / verifiedEmpty any more (until 2026-09-22 there
// was, and api/fulfill.js and lib/_stamp.js used it to mint greens with no
// store read behind them).
function verifiedRecord(what, readId, extra) {
  return mintBound({ ...(extra || {}), ok: true, state: STATES.RECORD, what: String(what) }, readId);
}
function verifiedEmpty(what, readId, extra) {
  return mintBound({ ...(extra || {}), ok: true, state: STATES.EMPTY, what: String(what) }, readId);
}
function presentUnchecked(what, readId) {
  return mintBound({ ok: false, state: STATES.UNCHECKED, what: String(what), reason: STATES.UNCHECKED }, readId);
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
  if (v.ok === true || v.state === STATES.UNCHECKED) {
    // Rule 4: a green (and a present_unchecked, which claims a read) must be
    // the very object this module minted from an issued read.
    if (typeof v.read_id !== "string" || !v.read_id) throw new UnboundVerdictError(where, "no read_id");
    if (!ISSUED_READS.has(v.read_id)) throw new UnboundVerdictError(where, `read_id ${v.read_id} was not issued by judgeRead`);
    if (BOUND.get(v) !== v.read_id) throw new UnboundVerdictError(where, "verdict was not minted by a judge");
  }
  return v;
}

function requireGreen(v, where) {
  requireVerdict(v, where);
  if (v.state === STATES.UNCHECKED) throw new PresentUncheckedError(where, v);
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
//
// Never returns null (rule 5). Three answers, all verdicts:
//   verified_empty     the store said 404                        (green, bound)
//   red                present but not a JSON object              (not green)
//   present_unchecked  present and an object; shape NOT judged    (not green, bound)
// Damaged reads reach this function one way only: valid-but-partial JSON
// (a non-200/404 and an unparseable body both throw in the store readers),
// which is why the third answer must not be green.
function judgeRead(got, what) {
  if (got === undefined) throw new VerdictRequiredError(`judge(${what}): no store read was passed`, got);
  const readId = issueReadId();
  if (got === null) return verifiedEmpty(what, readId);
  if (!isPlainObject(got) || !isPlainObject(got.json)) {
    return red(what, "not_a_json_object");
  }
  return presentUnchecked(what, readId);
}

// The one door from present_unchecked to a record: a shape rule. `rule(json)`
// returns a reason string (red), or an object of extra verdict fields /
// `true` (green). Anything else is a rule that did not decide, and throws.
// `onEmpty(readId)` lets a judge give its 404 a value (a counter's 0).
function judgeWith(got, what, rule, onEmpty) {
  if (typeof rule !== "function") throw new VerdictRequiredError(`judgeWith(${what}): a shape rule`, rule);
  const first = judgeRead(got, what);
  if (first.state === STATES.EMPTY) return onEmpty ? onEmpty(first.read_id) : first;
  if (first.state !== STATES.UNCHECKED) return first; // red from judgeRead
  const out = rule(got.json);
  if (typeof out === "string" && out) return red(what, out);
  if (out === true) return verifiedRecord(what, first.read_id);
  if (isPlainObject(out) && !("ok" in out) && !("state" in out) && !("read_id" in out)) {
    return verifiedRecord(what, first.read_id, out);
  }
  throw new VerdictRequiredError(`judgeWith(${what}): the shape rule returned neither a reason nor a pass`, out);
}

const CHAIN_RE = /^[0-9a-fA-F]{8,64}$/; // same rule as lib/_store.js CHAIN_RE (kept local: _store requires nothing from here, and this file requires nothing at all)

// A stored pin record (pins/<ns>/latest.json or a numbered seq record). Every
// record this service has ever written carries these four fields (they are in
// the first commit of api/pin.js), so none of them is "legacy-optional".
function judgePin(got, { what = "pin record", namespace = null } = {}) {
  // judgeRead (inside judgeWith) answers 404 / not-an-object; present_unchecked
  // goes on to these shape rules and comes out verifiedRecord or red.
  return judgeWith(got, what, (p) => {
    if (!Number.isSafeInteger(p.rows) || p.rows < 1) return "rows_unreadable";
    if (typeof p.chain !== "string" || !CHAIN_RE.test(p.chain)) return "chain_unreadable";
    if (!Number.isSafeInteger(p.seq) || p.seq < 1) return "seq_unreadable";
    if (namespace !== null && p.namespace !== namespace) return "namespace_mismatch";
    return true;
  });
}

// A stored counter document (credit balance, monthly usage, a day's stamp
// budget). 404 -> verified empty, value 0. Present with a readable number ->
// that number. Present WITHOUT one -> red. `|| 0` is the expression this
// replaces: it read a damaged balance as "never bought anything", and a
// damaged usage counter as "has used nothing this month" — the second one
// fails OPEN.
function judgeCounter(got, field, { what = "counter", integer = false } = {}) {
  return judgeWith(got, what, (json) => {
    const n = json[field];
    if (typeof n !== "number" || !Number.isFinite(n) || n < 0 || (integer && !Number.isInteger(n))) {
      return `${field}_unreadable`;
    }
    return { value: n };
  }, (readId) => verifiedEmpty(what, readId, { value: 0 }));
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
  UnboundVerdictError,
  PresentUncheckedError,
  red,
  requireVerdict,
  requireGreen,
  isEmpty,
  success,
  refusal,
  judgeRead,
  judgeWith,
  judgePin,
  judgeCounter,
  counterValue,
  requireListing,
};
