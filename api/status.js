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

const REPO_URL = `https://github.com/${store.REPO}`;
const BLOB = (path) => `${REPO_URL}/blob/${store.BRANCH}/${path}`;
const TREE = (path) => `${REPO_URL}/tree/${store.BRANCH}/${path}`;
const COMMITS = (path) => `${REPO_URL}/commits/${store.BRANCH}/${path}`;

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// Same cadence computation as api/latest.js — duplicated on purpose rather
// than imported, so a bug in one doesn't silently take the other down, and
// so a stranger diffing this page's status column against a raw
// `/api/latest?ns=<ns>` call is comparing two independent implementations
// of the same public rule, not one function rendered twice.
function cadenceStatus(pin) {
  const dueRaw = pin && typeof pin.next_pin_due_by === "string" ? pin.next_pin_due_by : null;
  const dueMs = dueRaw ? Date.parse(dueRaw) : NaN;
  if (!Number.isFinite(dueMs)) return { status: "legacy_no_deadline", dueRaw };
  const now = Date.now();
  if (now >= dueMs) {
    return { status: "overdue", dueRaw, overdueSeconds: Math.floor((now - dueMs) / 1000) };
  }
  return { status: "current", dueRaw };
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

function statusBadge(status, overdueSeconds) {
  if (status === "current") return `<span class="badge badge-green">current</span>`;
  if (status === "overdue") {
    return `<span class="badge badge-red">overdue${overdueSeconds != null ? ` &middot; ${esc(humanDuration(overdueSeconds))}` : ""}</span>`;
  }
  return `<span class="badge badge-grey">legacy (no deadline recorded)</span>`;
}

module.exports = async (req, res) => {
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
  let anchor = null;
  let anchorErr = null;
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
      const ageMs = renderedAt.getTime() - Date.parse(`${date}T00:00:00Z`);
      anchor = {
        date, hasOts, sha, claimedAt,
        staleDays: Number.isFinite(ageMs) ? Math.floor(ageMs / 86400000) : null,
        txtUrl: BLOB(`anchors/${latestName}`),
        otsUrl: hasOts ? BLOB(`anchors/${latestName}.ots`) : null,
        folderUrl: TREE("anchors"),
      };
    }
  } catch (err) {
    anchorErr = err.message;
  }

  // --- render -----------------------------------------------------------
  const overdueCount = rows.filter((r) => r.status === "overdue").length;
  const currentCount = rows.filter((r) => r.status === "current").length;
  const legacyCount = rows.filter((r) => r.status === "legacy_no_deadline").length;
  const errCount = rows.filter((r) => r.error).length;

  const overallOk = reachable && !nsErr && errCount === 0 && overdueCount === 0;
  const degraded = !reachable || nsErr || errCount > 0;

  const nsRowsHtml = rows.length
    ? rows.map((r) => {
        if (r.error) {
          return `<tr class="row-error">
            <td><code>${esc(r.ns)}</code></td>
            <td colspan="5">read error: ${esc(r.error)}</td>
          </tr>`;
        }
        const shortChain = r.chain.length > 16 ? `${r.chain.slice(0, 16)}…` : r.chain;
        return `<tr>
          <td><code>${esc(r.ns)}</code> <a class="src" href="${esc(r.historyUrl)}" title="commit history for this namespace">history</a></td>
          <td><a href="${esc(r.recordUrl)}" title="raw witnessed record on GitHub"><code>${esc(shortChain)}</code></a></td>
          <td>${r.rowsWitnessed != null ? esc(r.rowsWitnessed) : "&mdash;"}</td>
          <td><time datetime="${esc(r.pinnedAt || "")}">${esc(r.pinnedAt || "unknown")}</time></td>
          <td>${r.nextDueBy ? `<time datetime="${esc(r.nextDueBy)}">${esc(r.nextDueBy)}</time>` : "<em>none recorded</em>"}</td>
          <td>${statusBadge(r.status, r.overdueSeconds)}</td>
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
  }
  @media (prefers-color-scheme: dark){
    :root{
      --bg:#15140f; --panel:#1d1c16; --ink:#eae7de; --muted:#a8a496; --line:#332f24;
      --green-bg:#123420; --green-ink:#7fd99a; --red-bg:#3a1613; --red-ink:#f0a29c;
      --grey-bg:#2a281f; --grey-ink:#b8b4a6; --link:#7cc0e6; --code-bg:#221f18;
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
  code{background:var(--code-bg);padding:.1em .35em;border-radius:4px;font-size:.85em}
  pre{background:var(--code-bg);padding:.75rem 1rem;border-radius:6px;overflow-x:auto;font-size:.82rem}
  a{color:var(--link)}
  a.src{font-size:.78rem;opacity:.8}
  .badge{display:inline-block;padding:.15em .55em;border-radius:999px;font-size:.78rem;font-weight:600;white-space:nowrap}
  .badge-green{background:var(--green-bg);color:var(--green-ink)}
  .badge-red{background:var(--red-bg);color:var(--red-ink)}
  .badge-grey{background:var(--grey-bg);color:var(--grey-ink)}
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
      : `<span class="badge badge-red" style="font-size:.95rem">DEGRADED</span>`}
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
      <div class="stat"><span class="n">${currentCount}</span><span class="l">current</span></div>
      <div class="stat"><span class="n" style="${overdueCount ? "color:var(--red-ink)" : ""}">${overdueCount}</span><span class="l">overdue</span></div>
      <div class="stat"><span class="n">${legacyCount}</span><span class="l">legacy (no deadline)</span></div>
      <div class="stat"><span class="n">${obsCount}</span><span class="l">conflicts observed</span></div>
    </div>
    ${healthErr ? `<p class="muted">health check error: ${esc(healthErr)}</p>` : ""}
  </div>

  <h2>Namespaces &amp; pin cadence</h2>
  <p class="muted">Every namespace that has ever been pinned, its latest witnessed record, and whether it's inside its own declared cadence window right now. <strong>Overdue means a promised pin did not land</strong> &mdash; it does not by itself mean tampering (a witness can't tell dead from quiet). Recompute this yourself: <code>next_pin_due_by</code> vs. now, both readable from the raw record.</p>
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
