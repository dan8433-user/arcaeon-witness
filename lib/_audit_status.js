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

"use strict";

const store = require("./_store.js");
const { deriveAuditState, recordsForNamespace, badgeString, lineUnder, aggregateLine, checkedOfLine, STATES } = require("./_audit_state.js");
const { targetNamespace } = require("./_check_record.js");

const FLAG = "WITNESS_AUDIT_STATE";
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
    const derived = deriveAuditState(recordsForNamespace(records, ns), {
      ownKeys, ownKeysUnknown, withdrawnTools, withdrawnKeys, nowSeconds,
    });
    byNs[ns] = { ...derived, ns, partial, read_errors: readErrors, misfiled, records_listed: paths.length };
  }

  return { byNs, ownKeysUnknown, notes, readsUsed, nowSeconds };
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
    return `<span class="badge badge-amber">&#9888; NOT FULLY READ</span><div class="muted-sm">${esc(derived.records_listed)} check record${derived.records_listed === 1 ? "" : "s"} listed, not all read this render; no state is derived over partial evidence.</div>`;
  }
  const badge = badgeString(derived);
  const line = lineUnder(derived, { rerun: rerunCommand(derived.ns) });
  const extras = [];
  if (derived.counts.could_not_look) extras.push(`${derived.counts.could_not_look} attempted check${derived.counts.could_not_look === 1 ? "" : "s"} could not complete`);
  if (derived.counts.unverifiable) extras.push(`${derived.counts.unverifiable} record${derived.counts.unverifiable === 1 ? "" : "s"} ignored: bad signature, shape, or clock`);
  if (derived.counts.broken_withdrawn) extras.push(`${derived.counts.broken_withdrawn} BROKEN from a withdrawn tool or key, kept on the record`);
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

const AUDIT_CSS = `
  .badge-grey-outline{background:transparent;color:var(--grey-ink);border:1px solid var(--grey-ink)}
  .audit-line{max-width:28rem}
  .audit-headline{margin:.25rem 0}
`;

module.exports = {
  FLAG, OPERATOR_KEYS_PATH, WITHDRAWN_TOOLS_PATH, MAX_RECORD_READS,
  auditStateEnabled, gatherAuditStates, renderAuditCell, renderAuditSummary, rerunCommand, AUDIT_CSS,
};
