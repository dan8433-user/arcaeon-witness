// GET /status — public trust surface for the Arcaeon hosted witness.
//
// This is a relying-party page, not marketing. Everything on it is a
// server-side read of the same public sources a stranger could read
// themselves: the pin repo's contents API and commit history. No number
// here is asserted from memory or from our own database — it's fetched at
// request time, same as /api/latest and /api/health, so the page can't say
// anything the API itself couldn't independently confirm five seconds
// later. Rendered server-side (not client-fetched) so it works with JS off
// and can't be spoofed by a stale cached client bundle.
//
// Registered under Vercel's default routing as GET /api/status; a rewrite
// in vercel.json maps the public path /status to it (see that file for why).

"use strict";

const store = require("./_store.js");
const { gatherStatusData, humanDuration, BLOB, TREE, REPO_URL } = require("./_status_data.js");

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function statusBadge(status, overdueSeconds) {
  if (status === "current") return `<span class="badge badge-green">current</span>`;
  if (status === "publisher_heartbeat_current") {
    return `<span class="badge badge-blue">heartbeat &middot; content unchanged</span>`;
  }
  if (status === "overdue") {
    return `<span class="badge badge-red">overdue${overdueSeconds != null ? ` &middot; ${esc(humanDuration(overdueSeconds))}` : ""}</span>`;
  }
  // Ungradeable. Deliberately NOT the neutral grey it used to be: grey in a
  // column of green reads as "fine, nothing to see." This one has to read as
  // an open question, because that is what it is.
  return `<span class="badge badge-amber">&#9888; cadence not gradeable</span>`;
}

module.exports = async (req, res) => {
  const {
    renderedAt, reachable, healthErr,
    rows, nsErr,
    obsCount, obsSample, obsErr,
    anchor, anchorErr,
    overdueCount, currentCount, heartbeatCount, ungradeableCount, missedEverCount,
    degraded, indeterminate, overallOk,
    namespaces,
  } = await gatherStatusData();

  // --- render -----------------------------------------------------------
  const nsRowsHtml = rows.length
    ? rows.map((r) => {
        if (r.error) {
          return `<tr class="row-error">
            <td><code>${esc(r.ns)}</code></td>
            <td colspan="5">read error: ${esc(r.error)}</td>
          </tr>`;
        }
        const shortChain = r.chain.length > 16 ? `${r.chain.slice(0, 16)}…` : r.chain;
        const unchangedFor =
          r.headFirstSeenAt && Number.isFinite(Date.parse(r.headFirstSeenAt))
            ? humanDuration(Math.floor((renderedAt.getTime() - Date.parse(r.headFirstSeenAt)) / 1000))
            : null;
        // A retained miss is shown on EVERY later render, including a namespace
        // that is healthy again — renewal moves the deadline, never this.
        const missedFlag = r.everMissed
          ? `<div class="flag-missed" title="a deadline passed unmet; retained permanently in the record">missed a deadline${r.missedCount ? ` &times;${esc(r.missedCount)}` : ""}${r.missedDueAt ? ` &middot; last <time datetime="${esc(r.missedDueAt)}">${esc(r.missedDueAt)}</time>` : ""}</div>`
          : "";
        const heartbeatDetail = r.heartbeat
          ? `<div class="muted-sm">publisher heartbeat &mdash; head unchanged${unchangedFor ? ` for ${esc(unchangedFor)}` : ""}${r.renewalsSinceAdvance ? `, ${esc(r.renewalsSinceAdvance)} renewal${r.renewalsSinceAdvance === 1 ? "" : "s"} since the last advance` : ""}</div>`
          : "";
        return `<tr${r.gradeable === false ? ' class="row-ungradeable"' : ""}>
          <td><code>${esc(r.ns)}</code> <a class="src" href="${esc(r.historyUrl)}" title="commit history for this namespace">history</a></td>
          <td><a href="${esc(r.recordUrl)}" title="raw witnessed record on GitHub"><code>${esc(shortChain)}</code></a></td>
          <td>${r.rowsWitnessed != null ? esc(r.rowsWitnessed) : "&mdash;"}</td>
          <td><time datetime="${esc(r.pinnedAt || "")}">${esc(r.pinnedAt || "unknown")}</time></td>
          <td>${r.nextDueBy ? `<time datetime="${esc(r.nextDueBy)}">${esc(r.nextDueBy)}</time>` : "<em>none declared &mdash; nothing to grade</em>"}</td>
          <td>${statusBadge(r.status, r.overdueSeconds)}${heartbeatDetail}${
            r.gradeable === false
              ? `<div class="muted-sm">predates the cadence field &mdash; this row is <strong>not</strong> a pass; <code>cadence_gradeable:false</code> in the API</div>`
              : ""
          }${missedFlag}</td>
          <td><a class="src" href="${esc(r.apiUrl)}">/api/latest</a></td>
        </tr>`;
      }).join("\n")
    : `<tr><td colspan="7">${nsErr ? `namespace listing failed: ${esc(nsErr)}` : "no namespaces pinned yet"}</td></tr>`;

  const obsListHtml = obsSample.length
    ? `<ul class="obs-list">${obsSample.map((o) => {
        const v = o.obs;
        const label = v
          ? `<code>${esc(v.claimed && v.claimed.namespace)}</code> at rows=${esc(v.claimed && v.claimed.rows)} &mdash; ${esc(v.verdict || "conflict")}`
          : "(could not read record content)";
        return `<li>${label} &middot; <a href="${esc(o.url)}">raw record</a></li>`;
      }).join("\n")}</ul>${obsCount > obsSample.length ? `<p class="muted">${obsCount - obsSample.length} more not sampled here &mdash; see the full folder.</p>` : ""}`
    : "";

  let anchorHtml;
  if (anchorErr) {
    anchorHtml = `<p>anchor listing failed: ${esc(anchorErr)}. <a href="${TREE("anchors")}">see the anchors/ folder directly</a>.</p>`;
  } else if (!anchor) {
    anchorHtml = `<p>no daily anchor recorded yet &mdash; <strong>anchor: see pins repo</strong>. <a href="${TREE("anchors")}">anchors/ folder</a>.</p>`;
  } else {
    const staleWarn = anchor.staleDays != null && anchor.staleDays > 1;
    anchorHtml = `
      <p>
        Last daily anchor: <strong>${esc(anchor.date)}</strong>
        ${staleWarn ? `<span class="badge badge-red">${anchor.staleDays}d old</span>` : `<span class="badge badge-green">recent</span>`}
      </p>
      <p class="muted">
        Recorded HEAD: <code>${anchor.sha ? esc(anchor.sha.slice(0, 16)) + "&hellip;" : "unreadable"}</code>
        ${anchor.claimedAt ? `at ${esc(anchor.claimedAt)}` : ""}
        &middot; OTS proof file: ${anchor.hasOts ? `<a href="${esc(anchor.otsUrl)}">present, verify yourself</a>` : `<strong>not yet committed</strong>`}
      </p>
      <p class="muted">
        We do not run <code>ots verify</code> server-side to render this page (that would make the
        page trust its own process instead of a stranger's). Pull the repo and verify locally:
      </p>
      <pre>pip install opentimestamps-client
git clone ${esc(REPO_URL)}
ots verify anchors/${esc(anchor.date)}-head.txt.ots</pre>
      <p><a href="${esc(anchor.txtUrl)}">raw anchor file</a> &middot; <a href="${TREE("anchors")}">all anchors</a></p>
    `;
  }

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>arcaeon-witness — status</title>
<meta name="robots" content="index,follow">
<style>
  :root{
    --bg:#f7f7f5; --panel:#ffffff; --ink:#1a1a18; --muted:#5f5c56; --line:#e2ded4;
    --green-bg:#e6f4ea; --green-ink:#1e6b34; --red-bg:#fbe7e6; --red-ink:#a3271f;
    --grey-bg:#eceae4; --grey-ink:#5a564e; --link:#0a5c8a; --code-bg:#f0eee7;
    --amber-bg:#fdf1d8; --amber-ink:#8a5a08; --amber-line:#d9a441;
    --blue-bg:#e6eef8; --blue-ink:#1f4e79;
  }
  @media (prefers-color-scheme: dark){
    :root{
      --bg:#15140f; --panel:#1d1c16; --ink:#eae7de; --muted:#a8a496; --line:#332f24;
      --green-bg:#123420; --green-ink:#7fd99a; --red-bg:#3a1613; --red-ink:#f0a29c;
      --grey-bg:#2a281f; --grey-ink:#b8b4a6; --link:#7cc0e6; --code-bg:#221f18;
      --amber-bg:#3a2c0d; --amber-ink:#f0c76a; --amber-line:#8a6a1e;
      --blue-bg:#152a3d; --blue-ink:#8fc2ee;
    }
  }
  *{box-sizing:border-box}
  body{
    margin:0; background:var(--bg); color:var(--ink);
    font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;
    padding:2rem 1rem 4rem;
  }
  .wrap{max-width:960px;margin:0 auto}
  header{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:.5rem;margin-bottom:.25rem}
  h1{font-size:1.4rem;margin:0}
  h2{font-size:1.05rem;margin:2rem 0 .5rem;border-bottom:1px solid var(--line);padding-bottom:.3rem}
  .sub{color:var(--muted);font-size:.9rem;margin:.25rem 0 1.5rem}
  .panel{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:1rem 1.25rem;margin-bottom:1.25rem}
  table{width:100%;border-collapse:collapse;font-size:.88rem}
  th,td{text-align:left;padding:.45rem .5rem;border-bottom:1px solid var(--line);vertical-align:top}
  th{color:var(--muted);font-weight:600;font-size:.78rem;text-transform:uppercase;letter-spacing:.02em}
  tr.row-error td{color:var(--red-ink)}
  /* Ungradeable rows are visually SEPARATE from healthy ones, not a quieter
     shade of them: hatched ground + an amber rule, so the eye stops here
     instead of sliding past a grey badge in a column of green ones. */
  tr.row-ungradeable td{
    background:repeating-linear-gradient(135deg,var(--amber-bg),var(--amber-bg) 7px,transparent 7px,transparent 14px);
  }
  tr.row-ungradeable td:first-child{border-left:4px solid var(--amber-line)}
  .muted-sm{color:var(--muted);font-size:.78rem;margin-top:.25rem;max-width:22rem}
  .flag-missed{
    margin-top:.3rem;font-size:.75rem;font-weight:600;color:var(--red-ink);
    background:var(--red-bg);border-radius:4px;padding:.1em .45em;display:inline-block;
  }
  code{background:var(--code-bg);padding:.1em .35em;border-radius:4px;font-size:.85em}
  pre{background:var(--code-bg);padding:.75rem 1rem;border-radius:6px;overflow-x:auto;font-size:.82rem}
  a{color:var(--link)}
  a.src{font-size:.78rem;opacity:.8}
  .badge{display:inline-block;padding:.15em .55em;border-radius:999px;font-size:.78rem;font-weight:600;white-space:nowrap}
  .badge-green{background:var(--green-bg);color:var(--green-ink)}
  .badge-red{background:var(--red-bg);color:var(--red-ink)}
  .badge-grey{background:var(--grey-bg);color:var(--grey-ink)}
  .badge-amber{background:var(--amber-bg);color:var(--amber-ink);border:1px dashed var(--amber-line)}
  .badge-blue{background:var(--blue-bg);color:var(--blue-ink)}
  .muted{color:var(--muted);font-size:.88rem}
  .stat-row{display:flex;flex-wrap:wrap;gap:1.5rem;margin:.5rem 0}
  .stat{min-width:8rem}
  .stat .n{font-size:1.6rem;font-weight:700;display:block}
  .stat .l{color:var(--muted);font-size:.78rem;text-transform:uppercase;letter-spacing:.03em}
  footer{margin-top:2.5rem;padding-top:1.25rem;border-top:1px solid var(--line);color:var(--muted);font-size:.85rem}
  footer p{margin:.5rem 0}
  .obs-list{margin:.5rem 0;padding-left:1.2rem;font-size:.88rem}
  .scroll{overflow-x:auto}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>arcaeon-witness &mdash; status</h1>
    ${overallOk
      ? `<span class="badge badge-green" style="font-size:.95rem">OK</span>`
      : degraded
        ? `<span class="badge badge-red" style="font-size:.95rem">DEGRADED</span>`
        : `<span class="badge badge-amber" style="font-size:.95rem">&#9888; INDETERMINATE &middot; ${ungradeableCount} namespace${ungradeableCount === 1 ? "" : "s"} not gradeable</span>`}
  </header>
  <p class="sub">
    Rendered <time datetime="${renderedAt.toISOString()}">${renderedAt.toISOString()}</time> (UTC, this request).
    Backing store: <a href="${esc(REPO_URL)}"><code>${esc(store.REPO)}</code></a> (public), branch
    <code>${esc(store.BRANCH)}</code>. This page reads the same public sources you can read yourself &mdash;
    every number below links to its raw source.
  </p>

  <div class="panel">
    <div class="stat-row">
      <div class="stat"><span class="n">${reachable ? "reachable" : "unreachable"}</span><span class="l">pin store (<a href="/api/health">/api/health</a>)</span></div>
      <div class="stat"><span class="n">${namespaces.length}</span><span class="l">namespaces</span></div>
      <div class="stat"><span class="n">${currentCount}</span><span class="l">current (head advanced)</span></div>
      <div class="stat"><span class="n">${heartbeatCount}</span><span class="l">heartbeat only</span></div>
      <div class="stat"><span class="n" style="${overdueCount ? "color:var(--red-ink)" : ""}">${overdueCount}</span><span class="l">overdue</span></div>
      <div class="stat"><span class="n" style="${ungradeableCount ? "color:var(--amber-ink)" : ""}">${ungradeableCount}</span><span class="l">not gradeable</span></div>
      <div class="stat"><span class="n">${missedEverCount}</span><span class="l">ever missed a deadline</span></div>
      <div class="stat"><span class="n">${obsCount}</span><span class="l">conflicts observed</span></div>
    </div>
    ${healthErr ? `<p class="muted">health check error: ${esc(healthErr)}</p>` : ""}
    ${ungradeableCount ? `<p class="muted"><strong>${ungradeableCount} namespace${ungradeableCount === 1 ? " is" : "s are"} not gradeable</strong> &mdash; ${ungradeableCount === 1 ? "its latest record predates" : "their latest records predate"} the cadence field, so no deadline was ever declared and none is being invented now. That is <em>cannot determine</em>, not <em>pass</em>: the API returns <code>cadence_gradeable:false</code> and any consumer gating on cadence must apply its own not-determined policy. ${ungradeableCount === 1 ? "It becomes" : "They become"} gradeable again on the next pin or renewal &mdash; forward only, never retroactively.</p>` : ""}
    ${missedEverCount ? `<p class="muted"><strong>${missedEverCount} namespace${missedEverCount === 1 ? " has" : "s have"} missed a deadline at some point.</strong> A renewal refreshes the deadline; it never erases the miss. The missed window stays in the record permanently and is shown below even for namespaces that are healthy again.</p>` : ""}
  </div>

  <h2>Namespaces &amp; pin cadence</h2>
  <p class="muted">Every namespace that has ever been pinned, its latest witnessed record, and whether it's inside its own declared cadence window right now. <strong>Overdue means a promised pin did not land</strong> &mdash; it does not by itself mean tampering (a witness can't tell dead from quiet). Recompute this yourself: <code>next_pin_due_by</code> vs. now, both readable from the raw record.</p>
  <p class="muted">Four statuses, and the difference between them is the point:
    <span class="badge badge-green">current</span> the head advanced inside the window &middot;
    <span class="badge badge-blue">heartbeat</span> the publisher renewed the deadline while the content stayed exactly the same (alive, not active) &middot;
    <span class="badge badge-red">overdue</span> a promised record did not land &middot;
    <span class="badge badge-amber">&#9888; not gradeable</span> the record predates the cadence field and declared no deadline, so there is nothing to grade &mdash; <strong>cannot determine, not pass</strong> (<code>cadence_gradeable:false</code>). Nothing is backfilled to close that gap.</p>
  <div class="panel scroll">
    <table>
      <thead><tr><th>namespace</th><th>digest</th><th>rows</th><th>pinned at</th><th>next due by</th><th>status</th><th>live check</th></tr></thead>
      <tbody>${nsRowsHtml}</tbody>
    </table>
  </div>

  <h2>Conflict observations</h2>
  <p class="muted">A same-rows/different-chain submission never overwrites the accepted head &mdash; it's rejected and appended to an append-only log instead, so a detected conflict attempt can't quietly disappear even though it failed. <a href="${TREE("observations")}">browse observations/</a> directly.</p>
  <div class="panel">
    <p><strong>${obsCount}</strong> conflict${obsCount === 1 ? "" : "s"} observed, ever.${obsErr ? ` (count may be incomplete: ${esc(obsErr)})` : ""}</p>
    ${obsListHtml}
  </div>

  <h2>Bitcoin anchor (OpenTimestamps)</h2>
  <p class="muted">GitHub's commit clock is the first witness; once a day the pin repo's own HEAD commit is stamped with OpenTimestamps and the proof is committed back into the same public repo &mdash; a second, independent clock that doesn't trust us either.</p>
  <div class="panel">${anchorHtml}</div>

  <footer>
    <p><strong>What this page proves:</strong> the pins are public, the cadence math is reproducible by anyone, and the conflict log can't quietly disappear a detected problem. Every link above goes to the same GitHub history a stranger can clone and check independently &mdash; nothing here is asserted from a database only we can read.</p>
    <p><strong>Auth honesty (Stage-0):</strong> every write here &mdash; pin <em>and</em> renewal &mdash; is authorized by a bearer key and nothing else. That is not owner-signature auth: it proves a key-holder acted, not that the log's owner did. Anyone holding the key can renew a deadline. Owner-signature auth is the Stage-1 requirement and is <strong>not built yet</strong>; until it is, read <code>heartbeat</code> as "a key-holder was alive and asserting nothing changed." Responses carry <code>auth_level:"bearer-stage0"</code> so this can't be mistaken for something stronger.</p>
    <p><strong>What it does not prove:</strong> that logged content is true (a chain notarizes a fingerprint, not a fact), anything about the gap between pins (a witness only sees what's sent to it), or that we never lose data. Full scope and the standing challenge to break this: <a href="/PRACTICES.md">PRACTICES.md</a>.</p>
    <p class="muted">Stage-0: single region, single operator, no SLA. Source: <a href="${esc(REPO_URL)}">${esc(store.REPO)}</a>.</p>
  </footer>
</div>
</body>
</html>`;

  res.setHeader("cache-control", "no-store");
  res.setHeader("content-type", "text/html; charset=utf-8");
  return res.status(200).send(html);
};
