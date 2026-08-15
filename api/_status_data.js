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

const REPO_URL = `https://github.com/${store.REPO}`;
const BLOB = (path) => `${REPO_URL}/blob/${store.BRANCH}/${path}`;
const TREE = (path) => `${REPO_URL}/tree/${store.BRANCH}/${path}`;
const COMMITS = (path) => `${REPO_URL}/commits/${store.BRANCH}/${path}`;

// Independent cadence read — see module comment above for why this is not
// store.computeCadenceFields.
function cadenceStatus(pin) {
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
  let namespaces = [];
  let nsErr = null;
  const rows = [];
  try {
    const entries = await store.listDir("pins");
    namespaces = entries.filter((e) => e.type === "dir").map((e) => e.name).sort();
    for (const ns of namespaces) {
      try {
        const got = await store.getFile(`pins/${ns}/latest.json`);
        if (!got) {
          rows.push({ ns, error: "no latest.json (namespace directory exists, no pin recorded)" });
          continue;
        }
        const pin = got.json;
        const cad = cadenceStatus(pin);
        const seqName = Number.isInteger(pin.seq) ? String(pin.seq).padStart(8, "0") : null;
        rows.push({
          ns,
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
        rows.push({ ns, error: err.message });
      }
    }
  } catch (err) {
    nsErr = err.message;
  }

  // --- conflict observations -----------------------------------------
  let obsCount = 0;
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

  const overdueCount = rows.filter((r) => r.status === "overdue").length;
  const currentCount = rows.filter((r) => r.status === "current").length;
  const heartbeatCount = rows.filter((r) => r.status === "publisher_heartbeat_current").length;
  const ungradeableCount = rows.filter((r) => r.gradeable === false).length;
  const missedEverCount = rows.filter((r) => r.everMissed).length;
  const errCount = rows.filter((r) => r.error).length;

  // Three states, not two. An ungradeable namespace is not a failure — but it
  // is not an OK either. A stale anchor is a real failure (the daily self-
  // anchor job stopped); "cannot_determine" anchor freshness gets the same
  // non-failure-but-not-OK treatment as an ungradeable pin.
  const anchorStale = anchorStatus === "stale";
  const anchorUnknown = anchorStatus === "cannot_determine";
  const degraded = !reachable || !!nsErr || errCount > 0 || overdueCount > 0 || anchorStale;
  const indeterminate = !degraded && (ungradeableCount > 0 || anchorUnknown);
  const overallOk = !degraded && !indeterminate;

  return {
    renderedAt,
    reachable, healthErr,
    namespaces, rows, nsErr,
    obsCount, obsSample, obsErr,
    anchor, anchorErr, anchorStatus, anchorAgeHours,
    overdueCount, currentCount, heartbeatCount, ungradeableCount, missedEverCount, errCount,
    degraded, indeterminate, overallOk,
    repoUrl: REPO_URL,
  };
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

module.exports = { gatherStatusData, cadenceStatus, humanDuration, BLOB, TREE, COMMITS, REPO_URL };
