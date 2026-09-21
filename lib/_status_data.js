// _status_data.js — the ONE data-gathering pass behind /status, GET
// /api/status.json, and GET /api/badge (board items 21 + 25, 2026-08-14).
// Underscore prefix = not routed as a serverless function by Vercel.
//
// Extracted out of api/status.js's original inline gathering code so the
// HTML page, the JSON twin, and the badge can't drift from EACH OTHER —
// they all call gatherStatusData() and render its one return value three
// different ways.
//
// cadenceStatus() below is a DELIBERATE, SEPARATE reimplementation of the
// same cadence math that lives in api/_store.js's computeCadenceFields
// (used by api/latest.js and api/verify.js) — not imported, not shared with
// it. This independence predates the refactor (api/status.js's original
// comment: "duplicated on purpose rather than imported, so a bug in one
// doesn't silently take the other down, and so a stranger diffing this
// page's status column against a raw /api/latest call is comparing two
// independent implementations of the same public rule, not one function
// rendered twice"). That reasoning still holds after this refactor — it's
// just now factored so status.js/status.json/badge share ONE copy of the
// independent implementation instead of each hand-copying it a second time.

"use strict";

const store = require("./_store.js");
const keys = require("./_keys.js");
const verdict = require("./_verdict.js");

// WITNESS_RETIRED_NS: comma-separated namespace names to exclude from the
// health VERDICT (overdue/current/ungradeable counts, and therefore
// degraded/indeterminate/overallOk) while still LISTING them, tagged
// `retired:true`, in every rendering (status.js's table, status.json.js's
// namespaces array, and implicitly badge.js via the counts it reads from
// here). This exists for exactly one honest reason: a namespace can go
// permanently stale on purpose — a demo/self-test namespace nobody is
// renewing anymore — and that is not the same failure as a live publisher's
// feed going dark. Before this, a retired demo namespace sat "overdue"
// forever and painted the whole public badge red for a problem that isn't
// one. The fix is not to delete or hide the record (the pin history stays
// exactly as it is, in the public repo, forever) — it's to stop grading it.
// Retirement is additive and reversible: remove a name from the env var and
// its next read is graded again, same as any other namespace.
function loadRetiredNamespaces() {
  const raw = process.env.WITNESS_RETIRED_NS || "";
  return new Set(
    raw.split(",").map((s) => s.trim()).filter(Boolean)
  );
}

const REPO_URL = `https://github.com/${store.REPO}`;
const BLOB = (path) => `${REPO_URL}/blob/${store.BRANCH}/${path}`;
const TREE = (path) => `${REPO_URL}/tree/${store.BRANCH}/${path}`;
const COMMITS = (path) => `${REPO_URL}/commits/${store.BRANCH}/${path}`;

// Independent cadence read — see module comment above for why this is not
// store.computeCadenceFields.
function cadenceStatus(pin) {
  // No record, no grade. Every guard below is `pin && ...`, so a missing pin
  // used to grade as "legacy_no_deadline" — absence dressed as age.
  if (!pin || typeof pin !== "object" || Array.isArray(pin)) {
    throw new verdict.VerdictRequiredError("cadenceStatus: a pin record", pin);
  }
  const dueRaw = pin && typeof pin.next_pin_due_by === "string" ? pin.next_pin_due_by : null;
  const dueMs = dueRaw ? Date.parse(dueRaw) : NaN;
  const heartbeat = !!(pin && pin.record_kind === "publisher_heartbeat");
  if (!Number.isFinite(dueMs)) {
    return { status: "legacy_no_deadline", gradeable: false, heartbeat, dueRaw };
  }
  const now = Date.now();
  if (now >= dueMs) {
    return {
      status: "overdue", gradeable: true, heartbeat, dueRaw,
      overdueSeconds: Math.floor((now - dueMs) / 1000),
    };
  }
  return {
    status: heartbeat ? "publisher_heartbeat_current" : "current",
    gradeable: true, heartbeat, dueRaw,
  };
}

async function gatherStatusData() {
  const renderedAt = new Date();

  // --- health -------------------------------------------------------
  let reachable = false;
  let healthErr = null;
  try {
    reachable = await store.repoReachable();
  } catch (err) {
    healthErr = err.message;
  }

  // --- namespaces + latest pin per namespace -------------------------
  const retiredSet = loadRetiredNamespaces();
  let namespaces = [];
  let nsErr = null;
  const rows = [];
  try {
    const entries = await store.listDir("pins");
    namespaces = entries.filter((e) => e.type === "dir").map((e) => e.name).sort();
    for (const ns of namespaces) {
      const retired = retiredSet.has(ns);
      const reference = isReferenceNamespace(ns);
      try {
        const got = await store.getFile(`pins/${ns}/latest.json`);
        if (!got) {
          rows.push({ ns, retired, reference, error: "no latest.json (namespace directory exists, no pin recorded)" });
          continue;
        }
        // Verdict before row (lib/_verdict.js). A latest.json that is present
        // but is not a pin record used to pass every typeof-guard below and
        // land on the board as status "legacy_no_deadline": a damaged head
        // counted as an OLD one (yellow), not as an error (red). `got` cannot
        // be the verified-empty case here; that returned just above.
        const pinVerdict = verdict.judgePin(got, { what: `pins/${ns}/latest.json`, namespace: ns });
        if (!pinVerdict.ok) {
          rows.push({ ns, retired, reference, error: `latest.json is present but is not a readable pin record (${pinVerdict.reason})` });
          continue;
        }
        verdict.requireGreen(pinVerdict, "status row");
        const pin = got.json;
        const cad = cadenceStatus(pin);
        const seqName = Number.isInteger(pin.seq) ? String(pin.seq).padStart(8, "0") : null;
        rows.push({
          ns,
          retired,
          reference,
          rowsWitnessed: pin.rows,
          chain: pin.chain,
          pinnedAt: pin.pinned_at,
          nextDueBy: cad.dueRaw,
          status: cad.status,
          gradeable: cad.gradeable,
          heartbeat: cad.heartbeat,
          headFirstSeenAt: typeof pin.head_first_seen_at === "string" ? pin.head_first_seen_at : null,
          renewalsSinceAdvance: Number.isInteger(pin.renewals_since_advance) ? pin.renewals_since_advance : null,
          everMissed: pin.ever_missed_deadline === true,
          missedDueAt: typeof pin.missed_due_at === "string" ? pin.missed_due_at : null,
          missedCount: Number.isInteger(pin.missed_deadline_count) ? pin.missed_deadline_count : null,
          overdueSeconds: cad.overdueSeconds,
          recordUrl: seqName ? BLOB(`pins/${ns}/${seqName}.json`) : BLOB(`pins/${ns}/latest.json`),
          historyUrl: COMMITS(`pins/${ns}`),
          apiUrl: `/api/latest?ns=${encodeURIComponent(ns)}`,
        });
      } catch (err) {
        rows.push({ ns, retired, reference, error: err.message });
      }
    }
  } catch (err) {
    nsErr = err.message;
  }

  // --- conflict observations -----------------------------------------
  // null, not 0. Zero conflicts is a CLAIM ("we looked, there are none") and
  // it may only be made by the line below that actually counted. It used to
  // start at 0, so an unreadable tree reported conflicts_observed: 0 under an
  // overall ok:true — the absence of a read, rendered as the absence of
  // conflicts.
  let obsCount = null;
  let obsSample = [];
  let obsErr = null;
  try {
    const tree = await store.getTree();
    const obsFiles = tree
      .filter((t) => t.type === "blob" && t.path.startsWith("observations/") && t.path.endsWith(".json"))
      .sort((a, b) => (a.path < b.path ? 1 : -1)); // filenames are ISO timestamps -> lexical desc = newest first
    obsCount = obsFiles.length;
    // Only fetch content for a bounded sample (cost boundary) — the count
    // and the folder link are the honest primary signal either way.
    const SAMPLE_MAX = 10;
    for (const f of obsFiles.slice(0, SAMPLE_MAX)) {
      try {
        const got = await store.getFile(f.path);
        obsSample.push({ path: f.path, obs: got ? got.json : null, url: BLOB(f.path) });
      } catch {
        obsSample.push({ path: f.path, obs: null, url: BLOB(f.path) });
      }
    }
  } catch (err) {
    obsErr = err.message;
  }

  // --- OTS Bitcoin anchor state ---------------------------------------
  // Board item 26: the daily self-anchor (bridge/arcaeon/ots_anchor.py, Task
  // Scheduler "velouria-ots-anchor", 03:15 UTC-local daily) is an instrument
  // that fires into a void unless something reads it and says so out loud.
  // anchorStatus is ALWAYS one of "current" | "stale" | "cannot_determine" —
  // never left unset — so a caller never has to infer freshness from the
  // presence/absence of other fields. "stale" (>36h — half again the 24h
  // cadence, so one slow run doesn't false-alarm) folds into `degraded`;
  // "cannot_determine" (anchors/ unreadable, OR readable but empty — either
  // way freshness is unknowable, not merely unwitnessed) folds into
  // `indeterminate`, same discipline as an ungradeable pin below.
  const ANCHOR_STALE_HOURS = 36;
  let anchor = null;
  let anchorErr = null;
  let anchorStatus = "cannot_determine";
  let anchorAgeHours = null;
  try {
    const entries = await store.listDir("anchors");
    const names = entries.filter((e) => e.type === "file").map((e) => e.name);
    const txts = names
      .filter((n) => /^\d{4}-\d{2}-\d{2}-head\.txt$/.test(n))
      .sort()
      .reverse();
    if (txts.length) {
      const latestName = txts[0];
      const date = latestName.slice(0, 10);
      const hasOts = names.includes(`${latestName}.ots`);
      let sha = null, claimedAt = null;
      try {
        const raw = await store.getRawFile(`anchors/${latestName}`);
        if (raw) {
          const parts = raw.text.trim().split(/\s+/);
          sha = parts[0] || null;
          claimedAt = parts[1] || null;
        }
      } catch { /* non-fatal — the file listing itself is still shown */ }
      // Prefer the timestamp claimed inside the file (second-precision); fall
      // back to the filename's date at UTC midnight only if that's unreadable
      // — either way age is measured, never assumed.
      const claimedMs = claimedAt ? Date.parse(claimedAt) : NaN;
      const refMs = Number.isFinite(claimedMs) ? claimedMs : Date.parse(`${date}T00:00:00Z`);
      const ageMs = renderedAt.getTime() - refMs;
      anchorAgeHours = Number.isFinite(ageMs) ? Math.round((ageMs / 3600000) * 10) / 10 : null;
      anchorStatus = anchorAgeHours === null
        ? "cannot_determine"
        : (anchorAgeHours > ANCHOR_STALE_HOURS ? "stale" : "current");
      anchor = {
        date, hasOts, sha, claimedAt,
        ageHours: anchorAgeHours,
        status: anchorStatus,
        staleDays: Number.isFinite(ageMs) ? Math.floor(ageMs / 86400000) : null,
        txtUrl: BLOB(`anchors/${latestName}`),
        otsUrl: hasOts ? BLOB(`anchors/${latestName}.ots`) : null,
        folderUrl: TREE("anchors"),
      };
    }
    // else: dir readable, but no anchor file ever landed — anchorStatus stays
    // "cannot_determine" (freshness unknowable, not merely "none yet").
  } catch (err) {
    anchorErr = err.message;
    anchorStatus = "cannot_determine";
  }

  // Every count below that feeds the health verdict (degraded/indeterminate/
  // overallOk) excludes retired namespaces on purpose (see
  // loadRetiredNamespaces() above) — `rows` itself is untouched, so nothing
  // is hidden from the listing, only from the pass/fail judgment.
  const gradedRows = rows.filter((r) => !r.retired);
  const retiredCount = rows.length - gradedRows.length;
  const overdueCount = gradedRows.filter((r) => r.status === "overdue").length;
  const currentCount = gradedRows.filter((r) => r.status === "current").length;
  const heartbeatCount = gradedRows.filter((r) => r.status === "publisher_heartbeat_current").length;
  const ungradeableCount = gradedRows.filter((r) => r.gradeable === false).length;
  const missedEverCount = gradedRows.filter((r) => r.everMissed).length;
  const errCount = gradedRows.filter((r) => r.error).length;

  // Three states, not two. An ungradeable namespace is not a failure — but it
  // is not an OK either. A stale anchor is a real failure (the daily self-
  // anchor job stopped); "cannot_determine" anchor freshness gets the same
  // non-failure-but-not-OK treatment as an ungradeable pin.
  const anchorStale = anchorStatus === "stale";
  const anchorUnknown = anchorStatus === "cannot_determine";
  // THE ZERO FLOOR (pre-invite adversarial audit, 2026-08-23). Without it, a
  // store holding NOTHING rendered overallOk:true and a green badge reading
  // "ok · 0 ns · 0 overdue" — because with no namespaces there are no errors,
  // no overdue, and nothing ungradeable, so every failure counter was zero and
  // zero read as health. "0 found" and "0 looked at" printed identically, on
  // the status board whose entire job is telling you whether the watched thing
  // is fine.
  //
  // A watcher that watches nothing is not OK. It has no evidence either way,
  // which is exactly what `indeterminate` is for. This is the same missing
  // floor as the mutation harness's MIN_CASES, one surface over: an aggregate
  // verdict over an empty set is not a result.
  const nothingWatched = gradedRows.length === 0;
  const degraded = !reachable || !!nsErr || errCount > 0 || overdueCount > 0 || anchorStale;
  // An uncounted conflict log cannot be green: "0 conflicts" and "could not
  // count" are different sentences, and only the first one is good news.
  const conflictsUnknown = obsCount === null;
  const indeterminate = !degraded && (ungradeableCount > 0 || anchorUnknown || nothingWatched || conflictsUnknown);
  const overallOk = !degraded && !indeterminate;

  return {
    renderedAt,
    reachable, healthErr,
    namespaces, rows, nsErr,
    obsCount, obsSample, obsErr,
    anchor, anchorErr, anchorStatus, anchorAgeHours,
    overdueCount, currentCount, heartbeatCount, ungradeableCount, missedEverCount, errCount,
    nothingWatched, conflictsUnknown,
    retiredCount, retiredNamespaces: [...retiredSet],
    degraded, indeterminate, overallOk,
    repoUrl: REPO_URL,
  };
}

// The board's one-word verdict, for /status, /api/status.json and /api/badge.
// All three used to write `degraded ? "degraded" : indeterminate ?
// "indeterminate" : "ok"` — a ternary whose FALLTHROUGH is green, so a data
// object that simply lacked the fields (undefined, undefined) read as "ok".
// Here green is a branch that has to be taken: three explicit booleans,
// exactly one of them true, or it throws (lib/_verdict.js).
function overallWord(data) {
  const flags = ["degraded", "indeterminate", "overallOk"];
  for (const k of flags) {
    if (!data || typeof data[k] !== "boolean") {
      throw new verdict.VerdictRequiredError(`overallWord: data.${k}`, data && data[k]);
    }
  }
  if (flags.filter((k) => data[k]).length !== 1) {
    throw new verdict.VerdictRequiredError("overallWord: exactly one of degraded/indeterminate/overallOk must be true", data.overallOk);
  }
  if (data.degraded) return "degraded";
  if (data.indeterminate) return "indeterminate";
  return "ok";
}

function humanDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const parts = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (!d && m) parts.push(`${m}m`);
  return parts.length ? parts.join(" ") : "<1m";
}

// ---- reference namespaces (2026-09-19) --------------------------------------
// The operator pins its OWN logs here continuously, so that anyone can watch
// the cadence hold without being a customer. Those rows are tagged "reference"
// on the status page and in status.json. The tag does two jobs at once: it
// says what these rows are FOR, and it stops a row count from being read as a
// customer count. It replaced a paragraph that announced "every namespace
// traces to one operator root" -- forum candour that had drifted onto a
// product surface (owner's call, 2026-09-19: a status page reports the
// service, it does not editorialise about adoption). A namespace is a
// reference namespace when it starts with one of these prefixes; a customer's
// namespace is simply untagged.
//
// SINGLE SOURCE OF TRUTH (2026-09-20, second-lineage review): this list is
// DERIVED from lib/_keys.js's RESERVED_BRAND_STEMS, not a separate literal.
// It used to be its own env-overridable list (WITNESS_REFERENCE_NS_PREFIXES,
// default "velouria-,arcaeon-") that happened to match the claim-time
// reservation by coincidence, not by construction — an operator setting that
// env var to add a stem would make the page call it "ours" WITHOUT also
// reserving it at claim time, so a customer could still claim that exact
// stem and be tagged as the operator. That gap is the bug this fix closes,
// so the override is REMOVED rather than kept: the only way to change what
// the page calls "ours" is to change what claiming reserves, in one place.
const REFERENCE_PREFIXES = keys.RESERVED_BRAND_STEMS.map((stem) => `${stem}-`);
// Exact names, for operator logs that do not carry a brand stem. Generic stems
// like "test-" or "demo-" are deliberately NOT prefixes: a customer may choose
// one, and a customer's row must never be tagged as ours (second-lineage
// review, 2026-09-20, objection 3).
const REFERENCE_EXACT = (process.env.WITNESS_REFERENCE_NS_EXACT || "test-freeplan-smoke")
  .split(",").map((x) => x.trim()).filter(Boolean);

function isReferenceNamespace(ns) {
  const n = String(ns);
  return REFERENCE_EXACT.includes(n) || REFERENCE_PREFIXES.some((pre) => n.startsWith(pre));
}

module.exports = {
  isReferenceNamespace, gatherStatusData, overallWord, cadenceStatus, humanDuration, BLOB, TREE, COMMITS, REPO_URL };
