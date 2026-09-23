// _audit_status.js — the /status page's audit-state column: read the check
// records from the public pins repo, derive one state per namespace, render.
// Underscore prefix = not routed as a serverless function by Vercel.
//
// FEATURE FLAG: WITNESS_AUDIT_STATE=1 (default off). With the flag off this
// module is never called and api/status.js renders byte-for-byte what it
// rendered before. With it on, every namespace row leads with its audit
// state (BLIND for every namespace that exists today) and the cadence badge
// follows it, so a green "current" can no longer stand alone and read as
// "checked" (design page finding, api/status.js:29).
//
// What it reads, all from the same public repo the rest of the page reads:
//   checks/OPERATOR_KEYS.json      {"keys":[{"key":"ed25519:...","name":...}]}
//                                  every key the operator controls (B5). If
//                                  this file is absent or unreadable, every
//                                  key is treated as ours: CHECKED is then
//                                  unreachable, because an undeclared key
//                                  set is not evidence of independence.
//   checks/WITHDRAWN_TOOLS.json    {"tools":["name@version"],"keys":["ed25519:..."]}
//                                  B6 immediate demotion. Absent = nothing
//                                  withdrawn. Unreadable = treated as absent
//                                  and said so (a read error must not clear
//                                  a BROKEN; it also must not invent one).
//   checks/<type>/<ns>/*.json      the check records (lib/_check_record.js)
//
// Cost boundary: one recursive tree read, then one contents read per check
// record up to MAX_RECORD_READS per render. A namespace whose records were
// not all read is marked `partial` and renders "NOT FULLY READ" instead of a
// state — a state over half the evidence is not a state.
//
// OUTSIDE SOURCES (slice 2). A stranger's signed check record reaches this
// page without a pull request: the operator lists the stranger's own public
// location in WITNESS_CHECK_SOURCES (comma-separated), and every render reads
// that location's `checks/**` read-only and folds the records in. Not an
// api/ endpoint on purpose: api/ is at the Vercel Hobby 12-function cap.
//   https://github.com/<owner>/<repo>[/tree/<ref>]   listed through the git
//        trees API (unauthenticated, or WITNESS_CHECK_SOURCES_TOKEN; NEVER the
//        pin token), read through raw.githubusercontent.com
//   https://raw.githubusercontent.com/<owner>/<repo>/<ref>   same as above
//   https://<any other base>                          listed from
//        <base>/checks/INDEX.json {"paths":["checks/pin/<ns>/....json", ...]}
// Rules: a source record is evidence under exactly the same rules as a repo
// record (signature, shape, clock, filed under its own namespace), and the
// KEY decides what it can reach: a key in OPERATOR_KEYS.json is ours and
// reaches SELF-CHECKED at most, wherever the file was fetched from; with the
// declaration unreadable nothing reaches CHECKED. A source cannot mark
// anything withdrawn and cannot declare keys. Budget: MAX_SOURCE_FETCHES
// fetches per render across every source (listings included), each capped at
// MAX_SOURCE_BYTES and SOURCE_TIMEOUT_MS, redirects refused. Fail closed: a
// source that cannot be listed leaves every namespace NOT FULLY READ (we
// cannot say which namespaces it holds evidence about, and one of them may
// be a BROKEN); a listed record not read in budget leaves ITS namespace NOT
// FULLY READ.

"use strict";

const store = require("./_store.js");
const { deriveAuditState, recordsForNamespace, badgeString, lineUnder, aggregateLine, checkedOfLine, countStates, STATES } = require("./_audit_state.js");
const { targetNamespace } = require("./_check_record.js");

const FLAG = "WITNESS_AUDIT_STATE";
const SOURCES_ENV = "WITNESS_CHECK_SOURCES";
const SOURCES_TOKEN_ENV = "WITNESS_CHECK_SOURCES_TOKEN";
const MAX_SOURCES = 8;
const MAX_SOURCE_FETCHES = 40;
const MAX_SOURCE_BYTES = 64 * 1024;
const SOURCE_TIMEOUT_MS = 5000;
const OPERATOR_KEYS_PATH = "checks/OPERATOR_KEYS.json";
const WITHDRAWN_TOOLS_PATH = "checks/WITHDRAWN_TOOLS.json";
const MAX_RECORD_READS = 100;
const CHECK_PATH = /^checks\/(pin|observation)\/([^/]+)\/[^/]+\.json$/;

function auditStateEnabled(env = process.env) {
  const v = String(env[FLAG] || "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "on";
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// The command a reader runs to move a namespace out of BLIND themselves.
function rerunCommand(ns) {
  return `py verify.py https://github.com/${store.REPO} --json > out.json && node tools/check_and_sign.js --from-json out.json --repo https://github.com/${store.REPO} --namespace ${ns} --key your.pem`;
}

function envOwnKeys(env = process.env) {
  return String(env.WITNESS_OPERATOR_CHECK_KEYS || "").split(",").map((s) => s.trim()).filter(Boolean);
}

// ---------------------------------------------------------------------------
// outside sources
// ---------------------------------------------------------------------------
const GH_REPO_URL = /^https:\/\/github\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?(?:\/tree\/([A-Za-z0-9._\/-]+?))?\/?$/;
const RAW_GH_URL = /^https:\/\/raw\.githubusercontent\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._\/-]+?)\/?$/;

function githubSource(url, owner, repo, ref) {
  if (ref.split("/").some((seg) => seg === "" || seg === "." || seg === "..")) return { url, invalid: true, reason: "bad ref" };
  return {
    url, kind: "github",
    listUrl: `https://api.github.com/repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
    rawBase: `https://raw.githubusercontent.com/${owner}/${repo}/${ref}`,
  };
}

// One source string -> a descriptor, or {invalid:true, reason}. https only.
function parseSource(raw) {
  const url = String(raw || "").trim();
  let m = GH_REPO_URL.exec(url);
  if (m) return githubSource(url, m[1], m[2], m[3] || "main");
  m = RAW_GH_URL.exec(url);
  if (m) return githubSource(url, m[1], m[2], m[3]);
  let u;
  try { u = new URL(url); } catch { return { url, invalid: true, reason: "not a URL" }; }
  if (u.protocol !== "https:") return { url, invalid: true, reason: "not https" };
  if (u.username || u.password || u.search || u.hash) return { url, invalid: true, reason: "credentials, query or fragment in URL" };
  if (u.hostname === "github.com" || u.hostname === "raw.githubusercontent.com") return { url, invalid: true, reason: "GitHub URL not in a recognised repo form" };
  const base = url.replace(/\/+$/, "");
  return { url, kind: "index", listUrl: `${base}/checks/INDEX.json`, rawBase: base };
}

function envSources(env = process.env) {
  return String(env[SOURCES_ENV] || "").split(",").map((s) => s.trim()).filter(Boolean);
}

// Read a response body, refusing past maxBytes. Streams when it can so an
// oversized body is cut off rather than buffered whole.
async function readCapped(r, maxBytes) {
  const len = Number(r.headers && typeof r.headers.get === "function" ? r.headers.get("content-length") : NaN);
  if (Number.isFinite(len) && len > maxBytes) throw new Error(`body over ${maxBytes} bytes`);
  if (r.body && typeof r.body.getReader === "function") {
    const reader = r.body.getReader();
    const chunks = [];
    let n = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      n += value.length;
      if (n > maxBytes) {
        try { await reader.cancel(); } catch { /* already closed */ }
        throw new Error(`body over ${maxBytes} bytes`);
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks).toString("utf-8");
  }
  const text = typeof r.text === "function" ? await r.text() : Buffer.from(await r.arrayBuffer()).toString("utf-8");
  if (Buffer.byteLength(text, "utf-8") > maxBytes) throw new Error(`body over ${maxBytes} bytes`);
  return text;
}

// One budgeted GET. Throws an error with .budget = true when the budget is spent.
async function budgetedGet(url, ctx, headers = {}) {
  if (ctx.used >= ctx.max) {
    const e = new Error("fetch budget spent");
    e.budget = true;
    throw e;
  }
  ctx.used += 1;
  const opts = { headers: { "user-agent": "arcaeon-witness-status", ...headers }, redirect: "error" };
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") opts.signal = AbortSignal.timeout(ctx.timeoutMs);
  const r = await ctx.fetch(url, opts);
  if (!r || !r.ok) throw new Error(`GET ${url} -> ${r ? r.status : "no response"}`);
  return readCapped(r, ctx.maxBytes);
}

// List one source's file paths. Throws on anything short of a full listing.
async function listSource(src, ctx) {
  if (src.kind === "github") {
    const h = { accept: "application/vnd.github+json" };
    // Its own token env var, never the pin token: a source read must not be
    // able to borrow the write credential (the store_target_no_borrow rule).
    const tok = ctx.env[SOURCES_TOKEN_ENV];
    if (tok) h.authorization = `Bearer ${tok}`;
    const body = JSON.parse(await budgetedGet(src.listUrl, ctx, h));
    if (!body || !Array.isArray(body.tree)) throw new Error("tree listing malformed");
    if (body.truncated === true) throw new Error("tree listing truncated");
    return body.tree.filter((t) => t && t.type === "blob" && typeof t.path === "string").map((t) => t.path);
  }
  const body = JSON.parse(await budgetedGet(src.listUrl, ctx));
  if (!body || !Array.isArray(body.paths)) throw new Error("checks/INDEX.json has no paths array");
  return body.paths.filter((p) => typeof p === "string");
}

// Read every listed check record about one of `namespaces` from every
// configured source, within budget. No store access; only ctx.fetch.
// Returns { byNs: Map ns -> [record], partialNs: Set, allPartial,
//           ignoredByNs: Map ns -> n, sources: [...], notes: [...], used }.
async function gatherSourceRecords(namespaces, opts = {}) {
  const env = opts.env || process.env;
  const wanted = new Set(namespaces);
  const ctx = {
    fetch: opts.fetchImpl || ((...a) => fetch(...a)),
    used: 0,
    max: Number.isInteger(opts.maxFetches) ? opts.maxFetches : MAX_SOURCE_FETCHES,
    maxBytes: Number.isInteger(opts.maxBytes) ? opts.maxBytes : MAX_SOURCE_BYTES,
    timeoutMs: SOURCE_TIMEOUT_MS,
    env,
  };
  const byNs = new Map();
  const ignoredByNs = new Map();
  const partialNs = new Set();
  const notes = [];
  const sources = [];
  let allPartial = false;

  const list = envSources(env);
  if (list.length > MAX_SOURCES) {
    allPartial = true;
    notes.push(`${list.length} outside check sources are configured and at most ${MAX_SOURCES} are read, so no state below is derived.`);
  }
  for (const raw of list.slice(0, MAX_SOURCES)) {
    const src = parseSource(raw);
    const info = { url: src.url, kind: src.kind || null, status: "read", listed: 0, read: 0, errors: 0 };
    sources.push(info);
    if (src.invalid) {
      // An unusable entry is a configuration error, not a source that holds
      // no evidence. Fail closed, like an unlistable one.
      info.status = `refused: ${src.reason}`;
      allPartial = true;
      notes.push(`Outside check source ${src.url} was refused (${src.reason}), so no state below is derived.`);
      continue;
    }
    let paths;
    try {
      paths = await listSource(src, ctx);
    } catch (err) {
      const why = err.budget ? "fetch budget spent" : err.message;
      info.status = `not listed: ${why}`;
      allPartial = true;
      notes.push(`Outside check source ${src.url} could not be listed (${why}). It may hold evidence about any namespace, including a BROKEN, so no state below is derived.`);
      continue;
    }
    const mine = [];
    for (const p of paths) {
      const m = CHECK_PATH.exec(p);
      if (m && wanted.has(m[2])) mine.push({ path: p, ns: m[2] });
    }
    mine.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    info.listed = mine.length;
    for (const { path: p, ns } of mine) {
      let text;
      try {
        text = await budgetedGet(`${src.rawBase}/${p}`, ctx);
      } catch (err) {
        info.errors += 1;
        partialNs.add(ns);
        if (err.budget) info.status = "partly read: fetch budget spent";
        continue;
      }
      info.read += 1;
      let rec = null;
      try { rec = JSON.parse(text); } catch { rec = null; }
      // Same filing rule as the repo: a record filed under one namespace but
      // targeting another is evidence for neither.
      if (rec && targetNamespace(rec) === ns) {
        if (!byNs.has(ns)) byNs.set(ns, []);
        byNs.get(ns).push(rec);
      } else {
        ignoredByNs.set(ns, (ignoredByNs.get(ns) || 0) + 1);
      }
    }
    if (info.errors && info.status === "read") info.status = "partly read";
  }
  return { byNs, partialNs, allPartial, ignoredByNs, sources, notes, used: ctx.used };
}

// Two copies of one signed record (the repo's and a source's) are one piece
// of evidence. Keyed on the signature; a record with no sig is never merged
// (it is unverifiable either way and must be counted as such).
function dedupeBySig(records) {
  const seen = new Set();
  const out = [];
  for (const r of records) {
    const sig = r && typeof r.sig === "string" && r.sig ? r.sig : null;
    if (sig) {
      if (seen.has(sig)) continue;
      seen.add(sig);
    }
    out.push(r);
  }
  return out;
}

// namespaces: the list the status page already gathered.
// Returns { byNs: {ns -> derived}, ownKeysUnknown, notes:[...], readsUsed }.
async function gatherAuditStates(namespaces, opts = {}) {
  const nowSeconds = Number.isInteger(opts.nowSeconds) ? opts.nowSeconds : Math.floor(Date.now() / 1000);
  const notes = [];

  // --- operator keys ------------------------------------------------------
  let ownKeys = new Set(envOwnKeys(opts.env));
  let ownKeysUnknown = false;
  try {
    const got = await store.getFile(OPERATOR_KEYS_PATH);
    if (!got) {
      ownKeysUnknown = true;
      notes.push(`${OPERATOR_KEYS_PATH} is not published, so no key can be told apart from ours; every result is read as self-checked at most.`);
    } else {
      const keys = got.json && Array.isArray(got.json.keys) ? got.json.keys : null;
      if (!keys) {
        ownKeysUnknown = true;
        notes.push(`${OPERATOR_KEYS_PATH} is malformed (no keys array); every result is read as self-checked at most.`);
      } else {
        for (const k of keys) if (k && typeof k.key === "string") ownKeys.add(k.key);
      }
    }
  } catch (err) {
    ownKeysUnknown = true;
    notes.push(`${OPERATOR_KEYS_PATH} could not be read (${err.message}); every result is read as self-checked at most.`);
  }

  // --- withdrawn tools / keys -------------------------------------------
  let withdrawnTools = new Set();
  let withdrawnKeys = new Set();
  try {
    const got = await store.getFile(WITHDRAWN_TOOLS_PATH);
    if (got && got.json) {
      if (Array.isArray(got.json.tools)) withdrawnTools = new Set(got.json.tools.filter((t) => typeof t === "string"));
      if (Array.isArray(got.json.keys)) withdrawnKeys = new Set(got.json.keys.filter((t) => typeof t === "string"));
    }
  } catch (err) {
    notes.push(`${WITHDRAWN_TOOLS_PATH} could not be read (${err.message}); nothing is treated as withdrawn.`);
  }

  // --- the records ----------------------------------------------------------
  const byNsPaths = new Map();
  let treeErr = null;
  try {
    const tree = await store.getTree();
    for (const t of tree) {
      if (t.type !== "blob") continue;
      const m = CHECK_PATH.exec(t.path);
      if (!m) continue;
      const ns = m[2];
      if (!byNsPaths.has(ns)) byNsPaths.set(ns, []);
      byNsPaths.get(ns).push(t.path);
    }
  } catch (err) {
    treeErr = err.message;
    notes.push(`check records could not be listed (${err.message}); no state below is derived from evidence.`);
  }

  // --- outside sources (read-only, budgeted, fail closed) -----------------
  const src = await gatherSourceRecords(namespaces, {
    env: opts.env, fetchImpl: opts.fetchImpl, maxFetches: opts.maxSourceFetches,
  });
  for (const n of src.notes) notes.push(n);

  let readsUsed = 0;
  const byNs = {};
  for (const ns of namespaces) {
    const paths = (byNsPaths.get(ns) || []).slice().sort();
    const records = [];
    let partial = !!treeErr;
    let readErrors = 0;
    let misfiled = 0;
    for (const p of paths) {
      if (readsUsed >= MAX_RECORD_READS) { partial = true; break; }
      readsUsed += 1;
      try {
        const got = await store.getFile(p);
        if (got && got.json) {
          // A record filed under one namespace but targeting another is not
          // evidence for either. Counted, never folded in.
          if (targetNamespace(got.json) === ns) records.push(got.json);
          else misfiled += 1;
        }
      } catch {
        readErrors += 1;
        partial = true;
      }
    }
    // Outside-source records join the repo's under the same rules; the key,
    // not the location, decides what they can reach (ownKeys above).
    const fromSources = src.byNs.get(ns) || [];
    const sourcePartial = src.allPartial || src.partialNs.has(ns);
    const derived = deriveAuditState(dedupeBySig(recordsForNamespace(records.concat(fromSources), ns)), {
      ownKeys, ownKeysUnknown, withdrawnTools, withdrawnKeys, nowSeconds,
    });
    byNs[ns] = {
      ...derived, ns, partial: partial || sourcePartial, source_partial: sourcePartial,
      read_errors: readErrors, misfiled, records_listed: paths.length,
      source_records: fromSources.length, source_ignored: src.ignoredByNs.get(ns) || 0,
    };
  }

  return { byNs, ownKeysUnknown, notes, readsUsed, nowSeconds, sources: src.sources, sourceFetchesUsed: src.used };
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------
const BADGE_CLASS = {
  [STATES.BLIND]: "badge-grey",
  [STATES.SELF_CHECKED]: "badge-grey-outline",
  [STATES.CHECKED]: "badge-green",
  [STATES.STALE]: "badge-amber",
  [STATES.BROKEN]: "badge-red",
};

// One namespace's audit cell: the badge, then the line under it. The state
// word is always printed; color never carries meaning alone.
function renderAuditCell(derived) {
  if (!derived) return `<span class="badge badge-amber">&#9888; NOT FULLY READ</span><div class="muted-sm">no audit data was gathered for this row</div>`;
  if (derived.partial) {
    return `<span class="badge badge-amber">&#9888; NOT FULLY READ</span><div class="muted-sm">${esc(derived.records_listed)} check record${derived.records_listed === 1 ? "" : "s"} listed, not all read this render${derived.source_partial ? " (an outside check source was not fully read)" : ""}; no state is derived over partial evidence.</div>`;
  }
  const badge = badgeString(derived);
  const line = lineUnder(derived, { rerun: rerunCommand(derived.ns) });
  const extras = [];
  if (derived.counts.could_not_look) extras.push(`${derived.counts.could_not_look} attempted check${derived.counts.could_not_look === 1 ? "" : "s"} could not complete`);
  if (derived.counts.unverifiable) extras.push(`${derived.counts.unverifiable} record${derived.counts.unverifiable === 1 ? "" : "s"} ignored: bad signature, shape, or clock`);
  if (derived.counts.broken_withdrawn) extras.push(`${derived.counts.broken_withdrawn} BROKEN from a withdrawn tool or key, kept on the record`);
  if (derived.source_records) extras.push(`${derived.source_records} record${derived.source_records === 1 ? "" : "s"} read from outside check sources, judged by key like any other`);
  if (derived.source_ignored) extras.push(`${derived.source_ignored} file${derived.source_ignored === 1 ? "" : "s"} from outside check sources ignored: unparseable, or about another namespace`);
  if (derived.misfiled) extras.push(`${derived.misfiled} record${derived.misfiled === 1 ? "" : "s"} filed here but targeting another namespace, ignored`);
  return `<span class="badge ${BADGE_CLASS[derived.state]}" title="audit state, derived from published check records">${esc(badge)}</span>` +
    `<div class="muted-sm audit-line">${esc(line)}</div>` +
    (extras.length ? `<div class="muted-sm">${esc(extras.join(" · "))}</div>` : "");
}

// The BLIND-first aggregate and the "N of M" headline, plus the notes.
function renderAuditSummary(audit, { noun = "namespaces" } = {}) {
  const deriveds = Object.values(audit.byNs).filter((d) => !d.partial);
  const partialCount = Object.values(audit.byNs).length - deriveds.length;
  const lines = [
    `<p class="audit-headline"><strong>${esc(checkedOfLine(deriveds, { noun }))}</strong> ${esc(aggregateLine(deriveds, { noun }))}${partialCount ? ` ${partialCount} not fully read.` : ""}</p>`,
    `<p class="muted">An audit state is a property of the record's history, derived only from published, signed check records (<code>checks/</code> in the pin repo). It is on a different axis from the cadence badge: cadence says whether a promised pin landed; the audit state says whether anyone ever looked at the record, and who. Every state is a stamp of UNALTERED at most, never of truth. Grey <span class="badge badge-grey">BLIND</span> means no one has looked. <span class="badge badge-grey-outline">SELF-CHECKED</span> means only our own keys have. Green needs a key not declared as ours, within 30 days.</p>`,
  ];
  for (const n of audit.notes) lines.push(`<p class="muted">${esc(n)}</p>`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// JSON (the /api/status.json twin carries the same states as the page)
// ---------------------------------------------------------------------------
const NOT_FULLY_READ = "NOT_FULLY_READ";

// One namespace's audit block. A partial namespace carries NO state, only
// NOT_FULLY_READ, exactly as the page renders it: a machine reader must not
// be able to pick a state out of a render the page refused to derive.
function auditNamespaceJson(derived) {
  if (!derived) return { state: NOT_FULLY_READ, badge: "NOT FULLY READ", line: "no audit data was gathered for this row" };
  const common = {
    records_listed: derived.records_listed,
    read_errors: derived.read_errors,
    misfiled: derived.misfiled,
    source_records: derived.source_records || 0,
    source_ignored: derived.source_ignored || 0,
  };
  if (derived.partial) {
    return { state: NOT_FULLY_READ, badge: "NOT FULLY READ", line: "check records were not all read this render; no state is derived over partial evidence", source_partial: derived.source_partial === true, ...common };
  }
  return {
    state: derived.state,
    badge: badgeString(derived),
    line: lineUnder(derived, { rerun: rerunCommand(derived.ns) }),
    stale_reason: derived.stale_reason,
    counts: derived.counts,
    last_outside_verified_at: derived.last_outside_verified_at,
    last_own_verified_at: derived.last_own_verified_at,
    last_broken_at: derived.last_broken_at,
    days_since_outside_verified: derived.days_since_outside_verified,
    outside_keys: derived.outside_keys,
    broken_evidence: derived.broken_evidence,
    ...common,
  };
}

function auditSummaryJson(audit, { noun = "namespaces" } = {}) {
  const all = Object.values(audit.byNs);
  const deriveds = all.filter((d) => !d.partial);
  const c = countStates(deriveds);
  return {
    enabled: true,
    headline: checkedOfLine(deriveds, { noun }),
    aggregate: aggregateLine(deriveds, { noun }),
    // BLIND first, as on the page. not_fully_read is outside the denominator.
    counts: { blind: c.blind, self_checked: c.self_checked, checked: c.checked, stale: c.stale, broken: c.broken, derived: c.total, not_fully_read: all.length - deriveds.length },
    own_keys_unknown: audit.ownKeysUnknown,
    notes: audit.notes,
    sources: audit.sources || [],
    fresh_window_days: 30,
    note: "audit state is a property of the record's history, derived only from signed check records; UNALTERED at most, never true. CHECKED needs a key not declared in checks/OPERATOR_KEYS.json.",
  };
}

const AUDIT_CSS = `
  .badge-grey-outline{background:transparent;color:var(--grey-ink);border:1px solid var(--grey-ink)}
  .audit-line{max-width:28rem}
  .audit-headline{margin:.25rem 0}
`;

module.exports = {
  FLAG, OPERATOR_KEYS_PATH, WITHDRAWN_TOOLS_PATH, MAX_RECORD_READS,
  SOURCES_ENV, SOURCES_TOKEN_ENV, MAX_SOURCES, MAX_SOURCE_FETCHES, MAX_SOURCE_BYTES, NOT_FULLY_READ,
  auditStateEnabled, gatherAuditStates, renderAuditCell, renderAuditSummary, rerunCommand, AUDIT_CSS,
  parseSource, gatherSourceRecords, dedupeBySig, auditNamespaceJson, auditSummaryJson,
};
