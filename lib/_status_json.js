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
  // HEAD is a read and must answer like one. Uptime monitors and link checkers
  // default to HEAD; 405-ing them reports this endpoint as DOWN while it is in
  // fact serving 200. /api/health and /status never had this guard and always
  // answered HEAD correctly — these read endpoints now match them. Node drops
  // the body from a HEAD response on its own, so the handler needs no branch.
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.setHeader("allow", "GET, HEAD");
    return res.status(405).json({ error: "GET or HEAD only" });
  }

  const data = await gatherStatusData();

  const namespaces = data.rows.map((r) => {
    if (r.error) {
      return { namespace: r.ns, error: r.error };
    }
    return {
      namespace: r.ns,
      retired: r.retired === true,
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
      repo: require("../lib/_store.js").REPO,
      branch: require("../lib/_store.js").BRANCH,
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
      // retired namespaces are still counted in `namespaces` above (an
      // honest inventory total) but excluded from current/overdue/
      // not_gradeable/ever_missed_deadline and from the top-level `status`
      // verdict — see _status_data.js's loadRetiredNamespaces() comment.
      retired: data.retiredCount,
      retired_namespaces: data.retiredNamespaces,
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
    // Board item 26 — the daily self-anchor is an instrument that fires into
    // a void unless something reads it and says so out loud. This block is
    // that reader, phrased as the three facts a monitor needs: how stale
    // (age_hours), the verdict (status), and — same discipline as every
    // other gradeable field on this endpoint — cannot_determine instead of a
    // silent guess when anchors/ is unreadable or empty. Duplicates fields
    // already inside `anchor` above; kept as its own top-level key because
    // that's the literal shape asked for and it's the one field a monitor
    // scraping this JSON should have to find without knowing the rest of the
    // schema.
    ots_anchor: {
      date: data.anchor ? data.anchor.date : null,
      age_hours: data.anchorAgeHours,
      status: data.anchorStatus,
      stale_after_hours: 36,
      sha: data.anchor ? data.anchor.sha : null,
      has_ots_proof: data.anchor ? data.anchor.hasOts : null,
      claimed_at: data.anchor ? data.anchor.claimedAt : null,
      url: data.anchor ? data.anchor.txtUrl : null,
      error: data.anchorErr,
    },
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
