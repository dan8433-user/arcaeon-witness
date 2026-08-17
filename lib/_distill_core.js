// _distill_core.js — a byte-faithful JS port of arcaeon_distill's deterministic
// distillation core (Python source: C:/Users/USER/arcaeon-distill/arcaeon_distill/__init__.py,
// version 0.1.2), built for the hosted try-before-pip demo endpoint
// (api/distill.js). NOT the pip package — this file exists so an agent can
// try the distill() shape over HTTP with zero install. The pip package
// remains the source of truth; a receipt from this endpoint always carries
// `implementation:"js-port"` + `js_port_version` so nobody mistakes it for
// arcaeon-distill's own output (see api/distill.js).
//
// WHY A STRAIGHT "JSON.parse + walk + JSON.stringify" PORT WOULD LIE
// --------------------------------------------------------------------------
// The Python package's entire pitch is "same input, same budget, byte-
// identical output, every run, every machine." A naive JS reimplementation
// breaks that promise in two silent, structural ways the moment it crosses
// the language boundary:
//
//   1. Float formatting. Python's json.dumps(5.0) == "5.0"; JS's
//      JSON.stringify(5.0) == "5" (JS has one numeric type; the trailing
//      ".0" that marks "this was a float" is gone before your code ever
//      sees the value). Empirically verified against a live Python process
//      (see the batch this file's formatter is tested against): Python also
//      switches to scientific notation at different thresholds than JS
//      (decpt > 16 or decpt <= -4 for Python's repr-mode formatter, vs.
//      >= 1e21 / < 1e-6 for JS's default Number#toString) — so 1e17 prints
//      as "1e+17" in Python and "100000000000000000" in JS unless corrected.
//   2. Dict-key order. JSON objects preserve insertion order in Python
//      dicts unconditionally. Plain JS objects do NOT: a key that looks like
//      an array index (e.g. "2") gets silently reordered ahead of "foo" on
//      enumeration, regardless of insertion order. distill()'s wide-dict
//      head/tail truncation and its non-truncated pass-through both depend
//      on true insertion order, so this port represents every JSON object as
//      a `Map`, never a plain object, end to end.
//
// The fix for (1) is `_parseJSON` below: a hand-written recursive-descent
// parser that classifies each number token as PyInt or PyFloat by its
// lexical form (contains '.', 'e', or 'E' -> float; matches Python's own
// json.scanner rule) and a `_pyFloatRepr` formatter that reproduces
// CPython's shortest-round-trip presentation exactly (derived empirically:
// see the comment on `_pyFloatRepr`). The fix for (2) is `Map` everywhere a
// JSON object crosses this module.
//
// Residual, deliberately undefended edge cases (documented, not hidden --
// same spirit as the Python package's own "non-proofs" section):
//   - Python ints are arbitrary precision; this port keeps the original JSON
//     digit string verbatim for ints (PyInt.raw) rather than parsing to a
//     JS number, so huge integers round-trip exactly EXCEPT "-0" (JSON
//     permits it; Python's int(-0) == 0, so both sides normalize it to "0" —
//     this port matches that one normalization deliberately).
//   - Key sort order for the receipt's canonical digest compares strings by
//     Unicode CODE POINT (via a codePointAt-based comparator), matching
//     Python's `str.__lt__`, not JS's default UTF-16-code-unit sort. This
//     only diverges from a naive JS sort on keys containing astral-plane
//     characters (emoji, rare CJK extensions) — vanishingly unlikely in
//     tool-output keys, but cheap to get right, so it's done right.
//   - Lone (unpaired) UTF-16 surrogates in strings are not specially
//     handled; both runtimes' behavior here is itself murky and it is not
//     realistic tool-output content.
"use strict";

const crypto = require("crypto");

const SCHEMA = "arcaeon-distill:receipt:v1";
const JS_PORT_VERSION = "0.1.0"; // this file's own version, independent of the pip package's __version__
const PY_PACKAGE_VERSION_TARGET = "0.1.2"; // the arcaeon_distill version this port was built against

// ---------------------------------------------------------------------------
// PyInt / PyFloat — tagged wrappers so a JSON number keeps the int-vs-float
// distinction Python's parser makes lexically. Everything else in this
// module treats these as opaque scalars (never arithmetic operands) --
// exactly how the Python original treats str/int/float/bool/None: pass
// through untouched by the walk, format only at serialization time.
// ---------------------------------------------------------------------------
class PyInt {
  constructor(raw) {
    // Normalize "-0" -> "0" the same way Python's int("-0") == 0 does, so
    // json.dumps(int("-0")) == "0" on both sides.
    this.raw = raw === "-0" ? "0" : raw;
  }
}
class PyFloat {
  constructor(value, raw) {
    this.value = value; // JS double
    this.raw = raw; // original token text, for NaN/Infinity detection
  }
}

function isNaNToken(raw) {
  return raw === "NaN" || raw === "Infinity" || raw === "-Infinity";
}

// ---------------------------------------------------------------------------
// _pyFloatRepr — reproduce CPython's float repr() presentation exactly.
//
// Derived empirically (not from memory of the C source) by comparing
// `repr(x)`/`json.dumps(x)` against JS's `x.toExponential()` across a battery
// of magnitudes; the shortest-round-trip DIGIT sequence is provably the same
// on both runtimes (both implement "shortest decimal that round-trips this
// IEEE-754 double" -- there's one answer to that question), so only the
// PRESENTATION differs: notation switch point, exponent zero-padding,
// trailing ".0" for whole-number floats. Confirmed test battery: 5.0, 100.0,
// 0.5, 3.14, -12.7, 1e16, 1e17, 1e20, 1e21, 1e-4, 1e-5, 1e-7, 1.5e300, -0.0,
// 123456789012345.0, 1234567890123456.0, 12345678901234567.0, 2.5e-10, 1e100
// -- see api/distill.js's equivalence harness for the live cross-check.
// ---------------------------------------------------------------------------
function pyFloatRepr(v) {
  if (Number.isNaN(v)) return "NaN";
  if (v === Infinity) return "Infinity";
  if (v === -Infinity) return "-Infinity";

  const negative = v < 0 || Object.is(v, -0);
  const abs = Math.abs(v);

  if (abs === 0) return negative ? "-0.0" : "0.0";

  // toExponential() with no argument: shortest digit string that round-trips,
  // per ECMA-262 -- the JS-side equivalent of CPython's dtoa mode-0 shortest.
  const exp = abs.toExponential(); // e.g. "1e+16", "1.5e+300", "3.14e+0"
  const m = /^(\d)(?:\.(\d+))?e([+-]\d+)$/.exec(exp);
  if (!m) throw new Error(`pyFloatRepr: unexpected toExponential() shape ${exp}`);
  const digits = m[1] + (m[2] || "");
  const E = parseInt(m[3], 10); // value = digits[0].digits[1:] * 10^E
  const decpt = E + 1; // CPython's dtoa "decimal point position" convention

  let body;
  if (decpt > 16 || decpt <= -4) {
    // scientific notation
    const mantissa = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits[0];
    const expSign = E >= 0 ? "+" : "-";
    const expAbs = String(Math.abs(E)).padStart(2, "0");
    body = `${mantissa}e${expSign}${expAbs}`;
  } else if (decpt <= 0) {
    body = `0.${"0".repeat(-decpt)}${digits}`;
  } else if (decpt >= digits.length) {
    body = `${digits}${"0".repeat(decpt - digits.length)}.0`;
  } else {
    body = `${digits.slice(0, decpt)}.${digits.slice(decpt)}`;
  }
  return negative ? `-${body}` : body;
}

// ---------------------------------------------------------------------------
// Hand-written JSON parser -- preserves int/float lexical distinction (PyInt
// vs PyFloat) and represents every object as a Map (insertion-order-safe;
// see the module-header comment on why plain JS objects are unsafe here).
// Accepts NaN/Infinity/-Infinity tokens the same way Python's json.loads
// does by default (allow_nan=True on the loads side) -- distill()'s own
// admission check rejects them afterward, matching the Python package.
// ---------------------------------------------------------------------------
function parseJSON(text) {
  let i = 0;
  const n = text.length;

  function err(msg) {
    throw new SyntaxError(`${msg} at position ${i}`);
  }
  function skipWs() {
    while (i < n && (text[i] === " " || text[i] === "\t" || text[i] === "\n" || text[i] === "\r")) i++;
  }
  function parseValue() {
    skipWs();
    if (i >= n) err("Unexpected end of input");
    const c = text[i];
    if (c === "{") return parseObject();
    if (c === "[") return parseArray();
    if (c === '"') return parseString();
    if (c === "-" || (c >= "0" && c <= "9")) return parseNumber();
    if (text.startsWith("true", i)) { i += 4; return true; }
    if (text.startsWith("false", i)) { i += 5; return false; }
    if (text.startsWith("null", i)) { i += 4; return null; }
    if (text.startsWith("NaN", i)) { i += 3; return new PyFloat(NaN, "NaN"); }
    if (text.startsWith("Infinity", i)) { i += 8; return new PyFloat(Infinity, "Infinity"); }
    if (text.startsWith("-Infinity", i)) { i += 9; return new PyFloat(-Infinity, "-Infinity"); }
    err(`Unexpected token ${JSON.stringify(c)}`);
  }
  function parseObject() {
    i++; // {
    const map = new Map();
    skipWs();
    if (text[i] === "}") { i++; return map; }
    for (;;) {
      skipWs();
      if (text[i] !== '"') err("Expected string key");
      const key = parseString();
      skipWs();
      if (text[i] !== ":") err("Expected ':'");
      i++;
      const val = parseValue();
      map.set(key, val);
      skipWs();
      if (text[i] === ",") { i++; continue; }
      if (text[i] === "}") { i++; break; }
      err("Expected ',' or '}'");
    }
    return map;
  }
  function parseArray() {
    i++; // [
    const arr = [];
    skipWs();
    if (text[i] === "]") { i++; return arr; }
    for (;;) {
      arr.push(parseValue());
      skipWs();
      if (text[i] === ",") { i++; continue; }
      if (text[i] === "]") { i++; break; }
      err("Expected ',' or ']'");
    }
    return arr;
  }
  function parseString() {
    i++; // opening "
    let out = "";
    while (true) {
      if (i >= n) err("Unterminated string");
      const c = text[i];
      if (c === '"') { i++; break; }
      if (c === "\\") {
        i++;
        const e = text[i];
        if (e === '"') out += '"';
        else if (e === "\\") out += "\\";
        else if (e === "/") out += "/";
        else if (e === "b") out += "\b";
        else if (e === "f") out += "\f";
        else if (e === "n") out += "\n";
        else if (e === "r") out += "\r";
        else if (e === "t") out += "\t";
        else if (e === "u") {
          const hex = text.slice(i + 1, i + 5);
          out += String.fromCharCode(parseInt(hex, 16));
          i += 4;
        } else err(`Invalid escape \\${e}`);
        i++;
      } else {
        out += c;
        i++;
      }
    }
    return out;
  }
  function parseNumber() {
    const start = i;
    if (text[i] === "-") i++;
    while (i < n && text[i] >= "0" && text[i] <= "9") i++;
    let isFloat = false;
    if (text[i] === ".") {
      isFloat = true;
      i++;
      while (i < n && text[i] >= "0" && text[i] <= "9") i++;
    }
    if (text[i] === "e" || text[i] === "E") {
      isFloat = true;
      i++;
      if (text[i] === "+" || text[i] === "-") i++;
      while (i < n && text[i] >= "0" && text[i] <= "9") i++;
    }
    const raw = text.slice(start, i);
    if (raw === "" || raw === "-") err("Invalid number");
    return isFloat ? new PyFloat(parseFloat(raw), raw) : new PyInt(raw);
  }

  const value = parseValue();
  skipWs();
  if (i !== n) err("Unexpected trailing content");
  return value;
}

// ---------------------------------------------------------------------------
// Canonical + working JSON stringify. `sortKeys` selects the receipt-digest
// path (Python: sort_keys=True); the working/content path (what the caller
// actually gets back) preserves the Map's own insertion order, matching
// Python's default dict serialization. Both use compact separators
// (",", ":") and never escape non-ASCII (ensure_ascii=False), matching the
// Python original's json.dumps calls throughout distill().
// ---------------------------------------------------------------------------
function compareCodePoints(a, b) {
  const ai = Array.from(a); // iterates by code point, not UTF-16 code unit
  const bi = Array.from(b);
  const len = Math.min(ai.length, bi.length);
  for (let k = 0; k < len; k++) {
    const ca = ai[k].codePointAt(0);
    const cb = bi[k].codePointAt(0);
    if (ca !== cb) return ca - cb;
  }
  return ai.length - bi.length;
}

function jdump(value, sortKeys) {
  if (value === null || value === undefined) return "null";
  if (value === true) return "true";
  if (value === false) return "false";
  if (typeof value === "string") return JSON.stringify(value); // string escaping matches (verified empirically)
  if (value instanceof PyInt) return value.raw;
  if (value instanceof PyFloat) {
    if (Number.isNaN(value.value) || !Number.isFinite(value.value)) {
      throw new RangeError("Out of range float values are not JSON compliant (NaN/Infinity)");
    }
    return pyFloatRepr(value.value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => jdump(v, sortKeys)).join(",")}]`;
  }
  if (value instanceof Map) {
    let keys = Array.from(value.keys());
    if (sortKeys) keys = keys.slice().sort(compareCodePoints);
    return `{${keys.map((k) => `${JSON.stringify(k)}:${jdump(value.get(k), sortKeys)}`).join(",")}}`;
  }
  throw new TypeError(`jdump: unhandled value type ${typeof value}`);
}

// ---------------------------------------------------------------------------
// digests -- self-describing, same recipe as the Python fallback path
// (arcaeon_ledger is a Python-only optional dependency; this port always
// takes the fallback branch, which is what a pip-less caller gets on the
// Python side too when arcaeon-ledger isn't installed).
// ---------------------------------------------------------------------------
function digestBytesRaw(buf) {
  return "sha256:raw-bytes:v1:" + crypto.createHash("sha256").update(buf).digest("hex");
}
function digestJsonC14n(value) {
  const canon = Buffer.from(jdump(value, true), "utf-8");
  return "sha256:json-c14n:v1:" + crypto.createHash("sha256").update(canon).digest("hex");
}
function digestValue(v) {
  if (typeof v === "string") return digestBytesRaw(Buffer.from(v, "utf-8"));
  return digestJsonC14n(v);
}

function nowIso() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

// ---------------------------------------------------------------------------
// estimate_tokens -- same ~1-token-per-4-chars heuristic as the Python
// original, over the SAME serialization (compact, unsorted, ensure_ascii
// false) it uses for dict/list input.
// ---------------------------------------------------------------------------
function estimateTokens(data) {
  if (data === null || data === undefined) return 0;
  let text;
  if (Array.isArray(data) || data instanceof Map) {
    text = jdump(data, false);
  } else if (typeof data === "string") {
    text = data;
  } else {
    text = String(data);
  }
  if (!text) return 0;
  return Math.max(1, Math.floor(text.length / 4));
}

function charBudget(tokenBudget) {
  return Math.max(1, tokenBudget * 4);
}

// ---------------------------------------------------------------------------
// Admission gate -- the port's equivalent of _reject_undistillable. Given
// this module's own parser already refuses anything that isn't valid JSON
// (no arbitrary objects, no sets -- JS has no ambiguous str()-of-object
// path to begin with), the only two live checks left are: NaN/Infinity
// (rejected exactly like the Python original), and a reference cycle
// (impossible to construct from parsed JSON text alone -- parseJSON always
// builds a fresh tree -- but tool_output can also arrive as an
// already-parsed dict/list value if this module is ever called directly
// rather than via the HTTP text body, so the cycle guard stays, ported
// faithfully with the same on-path/cleared two-set design as the Python
// original's H2 fix).
// ---------------------------------------------------------------------------
const EXIT_MARKER = Symbol("exit");

function rejectUndistillable(value, path = "input") {
  const stack = [[value, path]];
  const onPath = new Set();
  const cleared = new Set();
  while (stack.length) {
    const [v, at] = stack.pop();
    if (v === EXIT_MARKER) {
      onPath.delete(at);
      cleared.add(at);
      continue;
    }
    if (v === null || v === undefined || typeof v === "string" || typeof v === "boolean") continue;
    if (v instanceof PyInt) continue;
    if (v instanceof PyFloat) {
      if (Number.isNaN(v.value) || !Number.isFinite(v.value)) {
        throw new RangeError(`${at}: NaN/Infinity is not JSON and has no stable serialization; use null or a string instead`);
      }
      continue;
    }
    if (Array.isArray(v) || v instanceof Map) {
      if (onPath.has(v)) throw new RangeError(`${at}: input contains a reference cycle`);
      if (cleared.has(v)) continue;
      onPath.add(v);
      stack.push([EXIT_MARKER, v]);
      if (v instanceof Map) {
        for (const [k, sub] of v.entries()) {
          stack.push([sub, `${at}[${JSON.stringify(k)}]`]);
        }
      } else {
        v.forEach((sub, idx) => stack.push([sub, `${at}[${idx}]`]));
      }
      continue;
    }
    throw new TypeError(`${at}: ${typeof v} has no deterministic serialization`);
  }
}

// ---------------------------------------------------------------------------
// JSON strategy -- ported from _walk_json / _distill_json.
// ---------------------------------------------------------------------------
const DEFAULT_STR_CAP = 300;
const DEFAULT_LIST_CAP = 20;
const DEFAULT_DICT_CAP = 200;
const MIN_STR_CAP = 20;
const MIN_LIST_CAP = 2;
const MIN_DICT_CAP = 4;
const MAX_SHRINK_ITERS = 12;
const DICT_DROP_MARKER_KEY = "__distilled_dropped_keys__";

function walkJson(obj, strCap, listCap, dictCap, path, drops) {
  if (obj instanceof Map) {
    if (obj.size > dictCap) {
      const items = Array.from(obj.entries());
      const headN = Math.floor((dictCap + 1) / 2);
      const tailN = dictCap - headN;
      const head = items.slice(0, headN);
      const tailStart = items.length - tailN;
      const tail = tailN ? items.slice(tailStart) : [];
      const droppedItems = items.slice(headN, tailStart);

      const result = new Map();
      for (const [k, v] of head) {
        result.set(k, walkJson(v, strCap, listCap, dictCap, path ? `${path}.${k}` : String(k), drops));
      }
      result.set(DICT_DROP_MARKER_KEY, new PyInt(String(droppedItems.length)));
      for (const [k, v] of tail) {
        result.set(k, walkJson(v, strCap, listCap, dictCap, path ? `${path}.${k}` : String(k), drops));
      }
      const droppedBlob = new Map(droppedItems);
      drops.push({
        kind: "dict_truncated",
        path: path || "$",
        digest: digestJsonC14n(droppedBlob),
        dropped_bytes: Buffer.byteLength(jdump(droppedBlob, false), "utf-8"),
        dropped_count: droppedItems.length,
      });
      return result;
    }
    const result = new Map();
    for (const [k, v] of obj.entries()) {
      result.set(k, walkJson(v, strCap, listCap, dictCap, path ? `${path}.${k}` : String(k), drops));
    }
    return result;
  }
  if (Array.isArray(obj)) {
    if (obj.length > listCap) {
      const headN = Math.floor((listCap + 1) / 2);
      const tailN = listCap - headN;
      const head = obj.slice(0, headN).map((it, i) => walkJson(it, strCap, listCap, dictCap, `${path}[${i}]`, drops));
      const tailStart = obj.length - tailN;
      const tail = tailN
        ? obj.slice(tailStart).map((it, j) => walkJson(it, strCap, listCap, dictCap, `${path}[${tailStart + j}]`, drops))
        : [];
      const droppedSlice = obj.slice(headN, tailStart);
      const marker = `...+${droppedSlice.length} more items`;
      drops.push({
        kind: "list_truncated",
        path: path || "$",
        digest: digestJsonC14n(droppedSlice),
        dropped_bytes: Buffer.byteLength(jdump(droppedSlice, false), "utf-8"),
        dropped_count: droppedSlice.length,
      });
      return [...head, marker, ...tail];
    }
    return obj.map((it, i) => walkJson(it, strCap, listCap, dictCap, `${path}[${i}]`, drops));
  }
  if (typeof obj === "string") {
    if (obj.length > strCap) {
      const cut = obj.slice(strCap);
      drops.push({
        kind: "string_truncated",
        path: path || "$",
        digest: digestBytesRaw(Buffer.from(cut, "utf-8")),
        dropped_bytes: Buffer.byteLength(cut, "utf-8"),
        dropped_count: cut.length,
      });
      return obj.slice(0, strCap) + `...+${cut.length} more chars`;
    }
    return obj;
  }
  return obj;
}

function distillJson(parsed, charBudgetN) {
  let strCap = DEFAULT_STR_CAP, listCap = DEFAULT_LIST_CAP, dictCap = DEFAULT_DICT_CAP;
  let content = parsed, drops = [];
  for (let iter = 0; iter < MAX_SHRINK_ITERS; iter++) {
    drops = [];
    content = walkJson(parsed, strCap, listCap, dictCap, "", drops);
    const size = jdump(content, false).length;
    if (size <= charBudgetN || (strCap <= MIN_STR_CAP && listCap <= MIN_LIST_CAP && dictCap <= MIN_DICT_CAP)) break;
    strCap = Math.max(MIN_STR_CAP, Math.floor(strCap / 2));
    listCap = Math.max(MIN_LIST_CAP, Math.floor(listCap / 2));
    dictCap = Math.max(MIN_DICT_CAP, Math.floor(dictCap / 2));
  }
  return [content, drops, drops.length > 0];
}

// ---------------------------------------------------------------------------
// Tabular strategy -- ported from _is_row_list / _looks_tabular_text /
// _distill_rows / _distill_tabular_rows / _distill_tabular_text.
// ---------------------------------------------------------------------------
const DEFAULT_ROW_CAP = 40;
const MIN_ROW_CAP = 4;

function isRowList(data) {
  if (!Array.isArray(data) || data.length < 2) return false;
  if (data.every((r) => r instanceof Map)) return true;
  if (data.every((r) => Array.isArray(r))) {
    const lens = new Set(data.map((r) => r.length));
    return lens.size <= 2;
  }
  return false;
}

function looksTabularText(s) {
  const lines = s.replace(/^\n+|\n+$/g, "").split("\n").filter((ln) => ln.trim());
  if (lines.length < 3) return false;
  for (const delim of ["\t", "|", ","]) {
    const counts = lines.map((ln) => ln.split(delim).length - 1);
    if (counts[0] > 0 && new Set(counts).size <= 2) return true;
  }
  return false;
}

function distillRows(rows, rowCap) {
  if (rows.length <= rowCap) return [rows, 0, null, 0];
  const headN = Math.floor((rowCap + 1) / 2);
  const tailN = rowCap - headN;
  const dropped = tailN ? rows.slice(headN, rows.length - tailN) : rows.slice(headN);
  const kept = rows.slice(0, headN).concat(tailN ? rows.slice(rows.length - tailN) : []);
  const blob = Buffer.from(jdump(dropped, false), "utf-8");
  return [kept, dropped.length, digestJsonC14n(dropped), blob.length];
}

function distillTabularRows(data, charBudgetN) {
  let rowCap = DEFAULT_ROW_CAP;
  let drops = [];
  let keptOut = data;
  for (let iter = 0; iter < MAX_SHRINK_ITERS; iter++) {
    const [kept, nDropped, digest, dbytes] = distillRows(data, rowCap);
    drops = [];
    if (nDropped) {
      const headN = Math.floor((rowCap + 1) / 2);
      const marker = data[0] instanceof Map ? new Map([["__distilled_dropped_rows__", new PyInt(String(nDropped))]]) : [`...+${nDropped} rows dropped...`];
      keptOut = kept.slice(0, headN).concat([marker], kept.slice(headN));
      drops.push({ kind: "rows_dropped", path: "$", digest, dropped_bytes: dbytes, dropped_count: nDropped });
    } else {
      keptOut = kept;
    }
    const size = jdump(keptOut, false).length;
    if (size <= charBudgetN || rowCap <= MIN_ROW_CAP) return [keptOut, drops, drops.length > 0];
    rowCap = Math.max(MIN_ROW_CAP, Math.floor(rowCap / 2));
  }
  return [keptOut, drops, drops.length > 0];
}

function distillTabularText(s, charBudgetN) {
  const lines = s.replace(/^\n+|\n+$/g, "").split("\n");
  if (!lines.length) return [s, [], false];
  const header = lines[0];
  let bodyStart = 1;
  let sepLine = null;
  if (lines.length > 1 && /^[\s|:-]+$/.test(lines[1])) {
    sepLine = lines[1];
    bodyStart = 2;
  }
  const body = lines.slice(bodyStart);

  let rowCap = DEFAULT_ROW_CAP;
  for (;;) {
    let keptBody, dropped;
    if (body.length <= rowCap) {
      keptBody = body;
      dropped = [];
    } else {
      const headN = Math.floor((rowCap + 1) / 2);
      const tailN = rowCap - headN;
      dropped = tailN ? body.slice(headN, body.length - tailN) : body.slice(headN);
      const markerLine = `...+${dropped.length} rows dropped...`;
      keptBody = body.slice(0, headN).concat([markerLine], tailN ? body.slice(body.length - tailN) : []);
    }
    const prefix = sepLine !== null ? [header, sepLine] : [header];
    const out = prefix.concat(keptBody).join("\n");
    if (out.length <= charBudgetN || rowCap <= MIN_ROW_CAP || !dropped.length) {
      const drops = [];
      if (dropped.length) {
        const blob = Buffer.from(dropped.join("\n"), "utf-8");
        drops.push({ kind: "rows_dropped", path: "$", digest: digestBytesRaw(blob), dropped_bytes: blob.length, dropped_count: dropped.length });
      }
      return [out, drops, drops.length > 0];
    }
    rowCap = Math.max(MIN_ROW_CAP, Math.floor(rowCap / 2));
  }
}

// ---------------------------------------------------------------------------
// Free-text strategy -- ported from _split_sentences / _distill_text.
// ---------------------------------------------------------------------------
const SENTENCE_SPLIT = /(?<=[.!?])\s+/;
const WORD = /[a-z0-9]+/g;

function splitSentences(text) {
  const parts = text.trim().split(SENTENCE_SPLIT).map((p) => p.trim());
  return parts.filter((p) => p);
}
function wordsOf(s) {
  return new Set((s.toLowerCase().match(WORD) || []));
}

function distillText(text, charBudgetN, query) {
  const sentences = splitSentences(text);
  const n = sentences.length;
  if (n === 0) return [text, [], false];
  if (text.length <= charBudgetN) return [text, [], false];

  const queryWords = query ? wordsOf(query) : new Set();

  function score(i, s) {
    const pos = Math.max(1.0 / (i + 1), 1.0 / (n - i));
    let overlap = 0;
    if (queryWords.size) {
      const sw = wordsOf(s);
      for (const w of sw) if (queryWords.has(w)) overlap++;
    }
    return pos + 2.0 * overlap;
  }

  const ranked = Array.from({ length: n }, (_, i) => i).sort((a, b) => {
    const sa = score(a, sentences[a]);
    const sb = score(b, sentences[b]);
    if (sb !== sa) return sb - sa; // descending score
    return a - b; // ascending index tie-break
  });

  const keptIdx = new Set();
  let used = 0;
  for (const i of ranked) {
    const cost = sentences[i].length + 1;
    if (used + cost > charBudgetN && keptIdx.size) continue;
    keptIdx.add(i);
    used += cost;
    if (used >= charBudgetN) break;
  }
  if (keptIdx.size === 0) keptIdx.add(ranked[0]);

  const pieces = [];
  let prev = -2;
  for (let i = 0; i < n; i++) {
    if (keptIdx.has(i)) {
      if (prev !== -2 && i !== prev + 1) pieces.push("[...]");
      pieces.push(sentences[i]);
      prev = i;
    }
  }
  const out = pieces.join(" ");
  const droppedSentences = sentences.filter((_, i) => !keptIdx.has(i));
  const drops = [];
  if (droppedSentences.length) {
    const blob = Buffer.from(droppedSentences.join(" "), "utf-8");
    drops.push({ kind: "sentences_dropped", path: "text", digest: digestBytesRaw(blob), dropped_bytes: blob.length, dropped_count: droppedSentences.length });
  }
  return [out, drops, drops.length > 0];
}

// ---------------------------------------------------------------------------
// distill() -- the public entry point. Mirrors the Python signature:
// distill(toolOutput, {budget, schemaHint, query, receipt}). `toolOutput`
// here is EITHER raw JSON/table/text as a JS string (the HTTP body's
// `content` field, parsed internally to preserve the int/float distinction)
// OR an already-parsed Map/Array/string/PyInt/PyFloat value.
// ---------------------------------------------------------------------------
const VALID_HINTS = new Set(["json", "tabular", "text"]);

function detectStrategy(toolOutput, schemaHint) {
  if (schemaHint !== undefined && schemaHint !== null) {
    if (!VALID_HINTS.has(schemaHint)) {
      throw new RangeError(`schema_hint must be one of json, tabular, text; got ${JSON.stringify(schemaHint)}`);
    }
    if (schemaHint === "json" && typeof toolOutput === "string") {
      try {
        return ["json", parseJSON(toolOutput)];
      } catch (e) {
        throw new RangeError("schema_hint='json' but tool_output is not valid JSON text");
      }
    }
    return [schemaHint, toolOutput];
  }

  if (Array.isArray(toolOutput) || toolOutput instanceof Map) {
    if (Array.isArray(toolOutput) && isRowList(toolOutput)) return ["tabular", toolOutput];
    return ["json", toolOutput];
  }

  if (typeof toolOutput === "string") {
    const stripped = toolOutput.trim();
    if (stripped[0] === "{" || stripped[0] === "[") {
      try {
        const parsed = parseJSON(stripped);
        if (Array.isArray(parsed) && isRowList(parsed)) return ["tabular", parsed];
        return ["json", parsed];
      } catch (e) {
        // fall through to text/tabular-text detection
      }
    }
    if (looksTabularText(toolOutput)) return ["tabular", toolOutput];
    return ["text", toolOutput];
  }

  throw new TypeError(`distill() cannot accept ${typeof toolOutput}: no deterministic serialization.`);
}

function receiptFull(fullValue) {
  let b;
  if (typeof fullValue === "string") b = Buffer.from(fullValue, "utf-8");
  else b = Buffer.from(jdump(fullValue, true), "utf-8");
  return { digest: digestValue(fullValue), bytes: b.length };
}

/**
 * distill(toolOutput, opts) -> {content, strategy, budget_tokens,
 *   est_tokens_before, est_tokens_after, truncated, receipt}
 *
 * `toolOutput`: string (JSON/CSV/TSV/markdown-table/free text) or an
 * already-parsed Map/Array/string/PyInt/PyFloat tree.
 * `opts.budget`: positive integer token budget (default 2000).
 * `opts.schemaHint`: "json" | "tabular" | "text", forces detection.
 * `opts.query`: relevance string for the text strategy.
 * `opts.receipt`: compute a DropReceipt (default true).
 */
function distill(toolOutput, opts = {}) {
  const budget = opts.budget === undefined ? 2000 : opts.budget;
  const schemaHint = opts.schemaHint;
  const query = opts.query;
  const wantReceipt = opts.receipt === undefined ? true : opts.receipt;

  if (!(typeof budget === "number") || Number.isNaN(budget) || budget <= 0) {
    throw new RangeError("budget must be a positive integer (tokens)");
  }
  rejectUndistillable(toolOutput);

  const [strategy, working] = detectStrategy(toolOutput, schemaHint);
  const cbudget = charBudget(budget);

  let content, drops, truncated;
  if (strategy === "json") {
    [content, drops, truncated] = distillJson(working, cbudget);
  } else if (strategy === "tabular") {
    if (typeof working === "string") {
      [content, drops, truncated] = distillTabularText(working, cbudget);
    } else if (!Array.isArray(working)) {
      throw new TypeError(`schema_hint='tabular' needs a list of row dicts or table text, got ${typeof working}`);
    } else {
      [content, drops, truncated] = distillTabularRows(working, cbudget);
    }
  } else if (strategy === "text") {
    [content, drops, truncated] = distillText(String(working), cbudget, query);
  } else {
    throw new Error(`unreachable strategy ${strategy}`);
  }

  const estBefore = estimateTokens(toolOutput);
  const estAfter = estimateTokens(content);

  let rcpt = null;
  if (wantReceipt) {
    rcpt = {
      schema: SCHEMA,
      strategy,
      budget_tokens: budget,
      full: receiptFull(toolOutput),
      distilled: receiptFull(content),
      drops,
      truncated,
      created_at: nowIso(),
      implementation: "js-port",
      js_port_version: JS_PORT_VERSION,
      py_package_version_target: PY_PACKAGE_VERSION_TARGET,
    };
  }

  return {
    content,
    strategy,
    budget_tokens: budget,
    est_tokens_before: estBefore,
    est_tokens_after: estAfter,
    truncated,
    receipt: rcpt,
  };
}

// Convert the Map/PyInt/PyFloat tree this module works in into plain
// JS values (plain objects, JS numbers) suitable for JSON.stringify in the
// HTTP response layer. Done ONLY at the API boundary -- everything upstream
// of this stays in the Map/PyInt/PyFloat representation so the determinism
// guarantees above hold all the way through the distill pipeline.
function toPlain(value) {
  if (value === null || value === undefined) return value;
  if (value instanceof PyInt) {
    // Safe-integer fast path; falls back to string form only if the literal
    // int digit count exceeds JS's safe-integer range (Python ints are
    // arbitrary precision -- rare in tool output, but don't silently lose
    // precision if it happens).
    const n = Number(value.raw);
    return Number.isSafeInteger(n) ? n : value.raw;
  }
  if (value instanceof PyFloat) return value.value;
  if (Array.isArray(value)) return value.map(toPlain);
  if (value instanceof Map) {
    const out = {};
    for (const [k, v] of value.entries()) out[k] = toPlain(v);
    return out;
  }
  return value; // string, boolean
}

module.exports = {
  distill,
  parseJSON,
  jdump,
  toPlain,
  pyFloatRepr,
  PyInt,
  PyFloat,
  SCHEMA,
  JS_PORT_VERSION,
  PY_PACKAGE_VERSION_TARGET,
};
