// GET /api/latest?ns=<namespace> — the most recent pin for a namespace.
//
// No auth: pins are public by design (that's the point of a public witness).
// Primary read path is the GitHub contents API (authoritative, no CDN lag);
// fallback is raw.githubusercontent with a cache-busting query — measured in
// practice, raw can serve stale content for MINUTES (its CDN largely ignores
// query-string cache-busters), so the response names which source served it
// and always points at the commit history as the authoritative record.

"use strict";

const store = require("./_store.js");

const HISTORY_BASE = `https://github.com/${store.REPO}/commits/${store.BRANCH}`;

module.exports = async (req, res) => {
  if (req.method !== "GET") {
    res.setHeader("allow", "GET");
    return res.status(405).json({ error: "GET only" });
  }

  const ns = (req.query && req.query.ns) || "";
  if (!store.NS_RE.test(ns)) {
    return res.status(400).json({ error: "ns must match [a-z0-9-]{1,64}" });
  }

  const path = `pins/${ns}/latest.json`;
  let pin = null;
  let source, note;

  // Primary: contents API — commit-fresh, no CDN cache.
  try {
    const got = await store.getFile(path);
    if (got === null) {
      return res.status(404).json({ error: `no pin recorded for namespace "${ns}"` });
    }
    pin = got.json;
    source = "github-contents-api";
    note = "read via the GitHub contents API (commit-fresh)";
  } catch {
    // Fallback: raw CDN with cache-buster. Honest note: raw can lag well
    // beyond the folk ~60s — the repo history is the source of truth.
    try {
      const r = await fetch(
        `https://raw.githubusercontent.com/${store.REPO}/${store.BRANCH}/${path}?cb=${Date.now()}`,
        { headers: { "cache-control": "no-cache" } }
      );
      if (r.status === 404) {
        return res.status(404).json({ error: `no pin recorded for namespace "${ns}"` });
      }
      if (!r.ok) {
        return res.status(502).json({ error: `pin store read failed: ${r.status}` });
      }
      pin = await r.json();
      source = "raw.githubusercontent";
      note = "served from the raw CDN, which can lag minutes behind the newest commit";
    } catch (err) {
      return res.status(502).json({ error: `pin store read error: ${err.message}` });
    }
  }

  // --- cadence-deadline status (excelsior's review) ---
  // "The public conflict log says what the witness saw; the deadline says
  // when absence has become unknowable." A verifier polling this endpoint
  // sees "overdue" without trusting our API — silence becomes a
  // stranger-gradeable alarm. This is visibility, not proof: a missed
  // cadence could mean tampering, or could mean the writer is dead,
  // compromised, or just done (availability and integrity are distinct).
  //
  // Three ORTHOGONAL fields, not one overloaded one:
  //   cadence_gradeable — can this record be graded against a deadline AT ALL?
  //   cadence_status    — the pure deadline verdict (current/overdue/legacy).
  //   head_state        — did the content actually move, or is this a
  //                       publisher heartbeat restating the same head?
  // `status` stays as the single combined verdict for naive consumers, and
  // resolves to the SAFE side in both new cases: a heartbeat is never reported
  // as plain "current", and an ungradeable record is never reported as passing.
  const now = Date.now();
  const dueRaw = pin && typeof pin.next_pin_due_by === "string" ? pin.next_pin_due_by : null;
  const dueMs = dueRaw ? Date.parse(dueRaw) : NaN;

  // (atomic-raven's objection, 2026-08-14: "a warning that cannot refuse is
  // telemetry, not a control.") A legacy record predates the cadence field: it
  // made no promise, so no promise can be graded. That is a REFUSAL to grade,
  // not a pass — and it has to be machine-readable, because a human-readable
  // status string that a gate ignores changes nothing downstream.
  const cadence_gradeable = Number.isFinite(dueMs);

  let cadence_status = "legacy_no_deadline";
  let overdue_by_seconds;
  if (cadence_gradeable) {
    if (now >= dueMs) {
      cadence_status = "overdue";
      overdue_by_seconds = Math.floor((now - dueMs) / 1000);
    } else {
      cadence_status = "current";
    }
  }

  // Records written before the renewal build carry no `record_kind`. That code
  // could only ever write on a genuine rows advance — it had no heartbeat path
  // — so "content_head_advance" is a factual read of those records, not a
  // guess; the provenance is stamped anyway rather than silently assumed.
  const recordKind = pin && typeof pin.record_kind === "string" ? pin.record_kind : null;
  const head_state =
    recordKind === "publisher_heartbeat" ? "publisher_heartbeat_current" : "content_head_advanced";

  let status;
  if (!cadence_gradeable) status = "legacy_no_deadline";
  else if (cadence_status === "overdue") status = "overdue";
  else if (head_state === "publisher_heartbeat_current") status = "publisher_heartbeat_current";
  else status = "current";

  res.setHeader("cache-control", "no-store");
  // Header form so a proxy or a gate can refuse without parsing the body.
  res.setHeader("x-cadence-gradeable", cadence_gradeable ? "true" : "false");

  const out = {
    ok: true,
    pin,
    next_pin_due_by: dueRaw,
    status,
    cadence_status,
    cadence_gradeable,
    head_state,
    source,
    freshness_note: `${note}; the authoritative record is the commit history at ${HISTORY_BASE}/pins/${ns}`,
    history: `${HISTORY_BASE}/pins/${ns}`,
  };
  if (!recordKind) {
    out.head_state_source = "inferred_pre_renewal_record (this record predates the heartbeat path, which could only write on a content advance)";
  }
  if (cadence_status === "overdue") out.overdue_by_seconds = overdue_by_seconds;

  if (!cadence_gradeable) {
    out.cadence_grade = "cannot_determine";
    out.gate_note =
      "REFUSE-SEMANTICS: this record predates the cadence field and declared no deadline, " +
      "so its cadence CANNOT be graded. A consumer gating on cadence MUST treat " +
      "cadence_gradeable:false as cannot_determine and apply its own not-determined policy — " +
      "it is NOT a pass. Nothing is backfilled to make this row look graded; the namespace " +
      "becomes gradeable again on its next pin or renewal, and never retroactively.";
  } else {
    out.cadence_grade = cadence_status === "current" ? "pass" : "fail";
  }

  // Heartbeat telemetry: how long the head has sat unchanged while the
  // publisher kept the deadline alive. This is the number that exposes a log
  // "kept current" for months without producing a single new row.
  const firstSeenRaw =
    pin && typeof pin.head_first_seen_at === "string" ? pin.head_first_seen_at : null;
  const firstSeenMs = firstSeenRaw ? Date.parse(firstSeenRaw) : NaN;
  if (Number.isFinite(firstSeenMs)) {
    out.head_first_seen_at = firstSeenRaw;
    out.content_unchanged_for_seconds = Math.max(0, Math.floor((now - firstSeenMs) / 1000));
  }
  if (Number.isInteger(pin && pin.renewals_since_advance)) {
    out.renewals_since_advance = pin.renewals_since_advance;
  }
  if (head_state === "publisher_heartbeat_current") {
    out.heartbeat_note =
      "The latest record is a publisher heartbeat: the deadline was renewed, the content head did NOT advance. " +
      "Do not read this as new activity — read it as 'a key-holder was alive and asserting nothing changed'.";
  }

  // A missed deadline is retained forever and surfaced on EVERY later read,
  // including reads of a namespace that is current again. Renewal moves the
  // deadline; it never moves this.
  if (pin && pin.ever_missed_deadline === true) {
    out.ever_missed_deadline = true;
    if (typeof pin.missed_due_at === "string") out.missed_due_at = pin.missed_due_at;
    if (typeof pin.first_missed_due_at === "string") out.first_missed_due_at = pin.first_missed_due_at;
    if (Number.isInteger(pin.missed_deadline_count)) out.missed_deadline_count = pin.missed_deadline_count;
  }
  if (pin && pin.had_ungradeable_history === true) out.had_ungradeable_history = true;

  // Both write paths are bearer-authorized and say so on every read.
  out.auth_level = (pin && pin.auth_level) || "bearer-stage0";
  out.auth_note = (pin && pin.auth_note) || store.AUTH_LEVEL_NOTE;

  return res.status(200).json(out);
};
