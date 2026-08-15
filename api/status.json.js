// GET /api/status.json — machine-readable twin of GET /status (board item 21).
//
// Vercel strips only the file's outer extension when routing, so
// api/status.json.js -> GET /api/status.json.
//
// Same underlying data as the HTML page — both call api/_status_data.js's
// gatherStatusData() so they can't drift apart — rendered as a stable JSON
// schema instead of a table. cadence math here is the SAME deliberately-
// independent reimplementation status.js uses (see _status_data.js's module
// comment for why it's independent from api/latest.js / api/verify.js's
// computation, not this file's choice to make).

"use strict";

const { gatherStatusData } = require("./_status_data.js");

module.exports = async (req, res) => {
  if (req.method !== "GET") {
    res.setHeader("allow", "GET");
    return res.status(405).json({ error: "GET only" });
  }

  const data = await gatherStatusData();

  const namespaces = data.rows.map((r) => {
    if (r.error) {
      return { namespace: r.ns, error: r.error };
    }
    return {
      namespace: r.ns,
      rows: r.rowsWitnessed,
      chain: r.chain,
      pinned_at: r.pinnedAt,
      next_pin_due_by: r.nextDueBy,
      status: r.status,
      cadence_gradeable: r.gradeable,
      heartbeat: r.heartbeat,
      head_first_seen_at: r.headFirstSeenAt,
      renewals_since_advance: r.renewalsSinceAdvance,
      ever_missed_deadline: r.everMissed,
      missed_due_at: r.missedDueAt,
      missed_deadline_count: r.missedCount,
      overdue_by_seconds: r.overdueSeconds ?? null,
      record_url: r.recordUrl,
      history_url: r.historyUrl,
      api_url: r.apiUrl,
    };
  });

  const out = {
    ok: data.overallOk,
    status: data.degraded ? "degraded" : data.indeterminate ? "indeterminate" : "ok",
    rendered_at: data.renderedAt.toISOString(),
    store: {
      kind: "public-github-repo",
      repo: require("./_store.js").REPO,
      branch: require("./_store.js").BRANCH,
      reachable: data.reachable,
    },
    summary: {
      namespaces: data.namespaces.length,
      current: data.currentCount,
      heartbeat_only: data.heartbeatCount,
      overdue: data.overdueCount,
      not_gradeable: data.ungradeableCount,
      ever_missed_deadline: data.missedEverCount,
      conflicts_observed: data.obsCount,
    },
    namespaces,
    conflict_observations: {
      count: data.obsCount,
      sample: data.obsSample.map((o) => ({ path: o.path, record: o.obs, url: o.url })),
      note: data.obsCount > data.obsSample.length
        ? `${data.obsCount - data.obsSample.length} more not sampled here — see conflict_observations.count and browse observations/ in the pin repo`
        : undefined,
    },
    anchor: data.anchor,
    errors: {
      namespace_listing: data.nsErr,
      observations: data.obsErr,
      anchor: data.anchorErr,
      health: data.healthErr,
    },
    repo_url: data.repoUrl,
    note: "same data as GET /status, rendered as JSON; every field here is a server-side read of the same public pin repo a stranger can clone and check independently",
  };

  res.setHeader("cache-control", "no-store");
  return res.status(200).json(out);
};
