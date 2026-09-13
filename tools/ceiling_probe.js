#!/usr/bin/env node
// ceiling_probe.js — measure GitHub's SECONDARY rate limit for sustained
// contents-API WRITES to one branch.
//
// ============================ SCRATCH REPO ONLY ============================
// This script writes junk commits until GitHub refuses them. It must NEVER be
// pointed at the live pin repo, for two independent reasons:
//
//   1. It dirties an append-only public log whose entire value is that its
//      history is meaningful.
//   2. GitHub enforces secondary rate limits PER AUTHENTICATED IDENTITY, not
//      per repository. Tripping the limit anywhere puts the SERVING token into
//      a cooldown. Using a scratch repo does not avoid the cooldown — it only
//      avoids the junk history. Run this in a window where nobody is pinning.
//
// The guard below refuses to run unless the target repo name contains "probe".
// That is a tripwire, not a safety net: the operator is still responsible for
// pointing this at a throwaway repository.
// ==========================================================================
//
// Plan: memory/PROBE_PLAN_witness_write_ceiling_2026-09-13.md (velouria canon)
// Question: MERKLE_BATCHING_DESIGN.md §1 / §11 open question 1.
//
// Usage:  node tools/ceiling_probe.js [--repo <name>] [--keep] [--plan a|b]
//   --repo  scratch repo name (default arcaeon-ceiling-probe-<today>); MUST
//           contain "probe"
//   --keep  do not delete the scratch repo at the end (default is to delete)
//   --plan  a = small sequential until refusal (default)
//           b = 4 KB sequential, then a CONCURRENT burst
//
// On concurrency (added after plan-a run 1, 2026-09-13): a sequential probe
// measures a RATE from one writer. Production does not have that shape — many
// serverless instances share one token and their writes overlap. GitHub's
// secondary limiter reacts to concurrency as well as rate, so plan b exists to
// probe the shape we actually ship.
//
// The token is read from GITHUB_PIN_TOKEN (env, else the repo-root .env) —
// the same variable lib/_store.js reads. Its value is never printed or logged.

"use strict";

const fs = require("fs");
const path = require("path");

const API = "https://api.github.com";
const UA = "arcaeon-ceiling-probe";

// ---- caps. The probe stops itself; it does not rely on the operator. ----
const GLOBAL_CAP_MS = 15 * 60 * 1000; // whole probe
const RUN_CAP_MS = 6 * 60 * 1000; // one sustained-write run
const RUN_CAP_REQUESTS = 800; // one sustained-write run
const RECOVERY_CAP_MS = 5 * 60 * 1000; // stop and report rather than wait
const RECOVERY_POLL_MS = 5000;
const PRIMARY_FLOOR = 500; // stop if the hourly budget gets this low

const SMALL_BYTES = 64;
const LARGE_BYTES = 4096;

const started = Date.now();
const elapsed = () => Date.now() - started;

// ---------------------------------------------------------------- token ----
function readToken() {
  if (process.env.GITHUB_PIN_TOKEN) return process.env.GITHUB_PIN_TOKEN.trim();
  const envPath = path.join(__dirname, "..", ".env");
  if (!fs.existsSync(envPath)) {
    throw new Error("GITHUB_PIN_TOKEN not in env and no .env at repo root");
  }
  const line = fs
    .readFileSync(envPath, "utf8")
    .split(/\r?\n/)
    .find((l) => l.startsWith("GITHUB_PIN_TOKEN="));
  if (!line) throw new Error("GITHUB_PIN_TOKEN not found in .env");
  return line.slice("GITHUB_PIN_TOKEN=".length).trim().replace(/^["']|["']$/g, "");
}

const TOKEN = readToken();

function headers(extra) {
  return {
    authorization: `Bearer ${TOKEN}`,
    accept: "application/vnd.github+json",
    "user-agent": UA,
    "x-github-api-version": "2022-11-28",
    ...(extra || {}),
  };
}

// Redact anything token-shaped before any string leaves this process.
function redact(s) {
  if (!s) return s;
  return String(s)
    .split(TOKEN)
    .join("<REDACTED_TOKEN>")
    .replace(/gh[pousr]_[A-Za-z0-9]{10,}/g, "<REDACTED_TOKEN>");
}

function log(...parts) {
  console.log(redact(parts.join(" ")));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ----------------------------------------------------------------- args ----
const argv = process.argv.slice(2);
function arg(name, fallback) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}
const KEEP = argv.includes("--keep");
const PLAN = arg("--plan", "a");
const today = new Date().toISOString().slice(0, 10);
const REPO_NAME = arg("--repo", `arcaeon-ceiling-probe-${today}`);

// ---------------------------------------------------------------- guard ----
if (!/probe/i.test(REPO_NAME)) {
  console.error(
    `REFUSING: scratch repo name ${JSON.stringify(REPO_NAME)} does not contain "probe".\n` +
      "This script writes junk commits until GitHub refuses them. It is scratch-repo only."
  );
  process.exit(2);
}
const LIVE_REPO = process.env.GITHUB_PIN_REPO || "dan8433-user/arcaeon-witness-pins";
if (LIVE_REPO.split("/").pop().toLowerCase() === REPO_NAME.toLowerCase()) {
  console.error("REFUSING: target equals the live pin repo.");
  process.exit(2);
}

// --------------------------------------------------------- http helpers ----
function rateHeaders(r) {
  return {
    limit: r.headers.get("x-ratelimit-limit"),
    remaining: r.headers.get("x-ratelimit-remaining"),
    reset: r.headers.get("x-ratelimit-reset"),
    retryAfter: r.headers.get("retry-after"),
    // GitHub sends this on some secondary-limit responses instead of retry-after
    resource: r.headers.get("x-ratelimit-resource"),
  };
}

function isSecondary(status, body) {
  if (status !== 403 && status !== 429) return false;
  return /secondary rate limit|abuse detection/i.test(body || "");
}

// One contents-API PUT creating a new file. Returns a classified result.
async function put(owner, repo, filePath, contentBytes, message) {
  const content = Buffer.from("x".repeat(contentBytes)).toString("base64");
  const t0 = Date.now();
  const r = await fetch(`${API}/repos/${owner}/${repo}/contents/${filePath}`, {
    method: "PUT",
    headers: headers({ "content-type": "application/json" }),
    body: JSON.stringify({ message, branch: "main", content }),
  });
  const text = await r.text().catch(() => "");
  return {
    status: r.status,
    ok: r.ok,
    ms: Date.now() - t0,
    body: text,
    rate: rateHeaders(r),
    secondary: isSecondary(r.status, text),
  };
}

// ------------------------------------------------------------- the runs ----
// Sustained sequential PUTs until the first secondary-limit refusal.
async function sustainedRun(owner, repo, label, bytes, pathPrefix, capMs) {
  const RUN_CAP_MS = capMs || 6 * 60 * 1000;
  log(`\n--- run ${label}: sustained PUT, payload ${bytes} bytes ---`);
  const t0 = Date.now();
  let accepted = 0;
  let firstAcceptedAt = null;
  let lastAcceptedAt = null;
  const latencies = [];

  for (let i = 0; i < RUN_CAP_REQUESTS; i++) {
    if (Date.now() - t0 > RUN_CAP_MS) {
      return { label, bytes, accepted, outcome: "run_cap_time", windowMs: Date.now() - t0, latencies };
    }
    if (elapsed() > GLOBAL_CAP_MS) {
      return { label, bytes, accepted, outcome: "global_cap", windowMs: Date.now() - t0, latencies };
    }

    const res = await put(
      owner,
      repo,
      `${pathPrefix}/${String(i).padStart(5, "0")}.txt`,
      bytes,
      `probe ${label} ${i}`
    );
    latencies.push(res.ms);

    if (res.ok) {
      accepted++;
      if (firstAcceptedAt === null) firstAcceptedAt = Date.now();
      lastAcceptedAt = Date.now();
      if (accepted % 20 === 0) {
        log(
          `  accepted=${accepted} t=${((Date.now() - t0) / 1000).toFixed(1)}s ` +
            `primary_remaining=${res.rate.remaining}`
        );
      }
      // Primary (hourly) limit guard — stop before we start measuring the
      // wrong ceiling.
      if (res.rate.remaining !== null && Number(res.rate.remaining) < PRIMARY_FLOOR) {
        return {
          label,
          bytes,
          accepted,
          outcome: "primary_limit_near",
          primaryRemaining: Number(res.rate.remaining),
          windowMs: lastAcceptedAt - (firstAcceptedAt || t0),
          latencies,
        };
      }
      continue;
    }

    if (res.secondary) {
      log(`  FIRST SECONDARY-LIMIT REFUSAL after ${accepted} accepted writes`);
      return {
        label,
        bytes,
        accepted,
        outcome: "secondary_limit",
        status: res.status,
        body: redact(res.body),
        retryAfter: res.rate.retryAfter,
        primaryRemaining: res.rate.remaining,
        firstAcceptedAt,
        lastAcceptedAt,
        windowMs: (lastAcceptedAt || t0) - (firstAcceptedAt || t0),
        latencies,
      };
    }

    // Anything else is an unexpected failure: report, do not retry-spiral.
    return {
      label,
      bytes,
      accepted,
      outcome: "unexpected_status",
      status: res.status,
      body: redact(res.body).slice(0, 800),
      windowMs: (lastAcceptedAt || t0) - (firstAcceptedAt || t0),
      latencies,
    };
  }

  return { label, bytes, accepted, outcome: "run_cap_requests", windowMs: Date.now() - t0, latencies };
}

// N writers racing on one branch with one token — the production shape.
// Stops the whole burst on the first secondary-limit refusal any worker sees.
async function concurrentBurst(owner, repo, workers, bytes, capMs, pathPrefix) {
  log(`\n--- burst: ${workers} concurrent writers, payload ${bytes} bytes, cap ${capMs / 1000}s ---`);
  const t0 = Date.now();
  const state = { accepted: 0, stop: false, refusal: null, other: null, statuses: {} };

  async function worker(w) {
    for (let i = 0; !state.stop; i++) {
      if (Date.now() - t0 > capMs || elapsed() > GLOBAL_CAP_MS) return;
      const res = await put(owner, repo, `${pathPrefix}/w${w}_${i}.txt`, bytes, `burst w${w} ${i}`);
      state.statuses[res.status] = (state.statuses[res.status] || 0) + 1;
      if (res.ok) {
        state.accepted++;
        if (res.rate.remaining !== null && Number(res.rate.remaining) < PRIMARY_FLOOR) {
          state.stop = true;
          state.other = { outcome: "primary_limit_near", remaining: Number(res.rate.remaining) };
        }
        continue;
      }
      if (res.secondary) {
        state.stop = true;
        state.refusal = {
          acceptedBefore: state.accepted,
          atMs: Date.now() - t0,
          status: res.status,
          body: redact(res.body),
          retryAfter: res.rate.retryAfter,
          primaryRemaining: res.rate.remaining,
        };
        log(`  SECONDARY-LIMIT REFUSAL: ${state.accepted} accepted, t=${((Date.now() - t0) / 1000).toFixed(1)}s`);
        return;
      }
      // 409/422 create-races between workers are expected; keep going.
      if (res.status === 409 || res.status === 422) continue;
      state.stop = true;
      state.other = { outcome: "unexpected_status", status: res.status, body: redact(res.body).slice(0, 400) };
      return;
    }
  }

  await Promise.all(Array.from({ length: workers }, (_, w) => worker(w)));
  const windowMs = Date.now() - t0;
  return {
    workers,
    bytes,
    accepted: state.accepted,
    windowMs,
    perMinute: Math.round((state.accepted / windowMs) * 60000),
    statusCounts: state.statuses,
    outcome: state.refusal ? "secondary_limit" : state.other ? state.other.outcome : "burst_cap_time",
    refusal: state.refusal,
    note: state.other || undefined,
  };
}

// Poll one write every RECOVERY_POLL_MS until it succeeds, or give up.
async function measureRecovery(owner, repo, pathPrefix) {
  log(`\n--- recovery: polling one PUT every ${RECOVERY_POLL_MS / 1000}s ---`);
  const t0 = Date.now();
  let attempts = 0;
  while (Date.now() - t0 < RECOVERY_CAP_MS) {
    if (elapsed() > GLOBAL_CAP_MS) return { outcome: "global_cap", ms: Date.now() - t0, attempts };
    await sleep(RECOVERY_POLL_MS);
    attempts++;
    const res = await put(owner, repo, `${pathPrefix}/r${attempts}.txt`, SMALL_BYTES, `recovery probe ${attempts}`);
    log(`  attempt ${attempts} at t+${((Date.now() - t0) / 1000).toFixed(0)}s -> ${res.status}`);
    if (res.ok) return { outcome: "recovered", ms: Date.now() - t0, attempts };
    if (!res.secondary) {
      return { outcome: "unexpected_status", status: res.status, body: redact(res.body).slice(0, 400), ms: Date.now() - t0, attempts };
    }
  }
  return { outcome: "recovery_cap_exceeded", ms: Date.now() - t0, attempts };
}

// ------------------------------------------------------------------ main ---
async function main() {
  const summary = { probe: "github_contents_write_ceiling", date: today, runs: {} };

  // whoami — account type matters for the number's scope
  const who = await fetch(`${API}/user`, { headers: headers() });
  const whoJson = await who.json();
  summary.account = { login: whoJson.login, type: whoJson.type, plan: whoJson.plan && whoJson.plan.name };
  summary.primaryLimit = rateHeaders(who);
  log(`account: ${whoJson.login} (${whoJson.type}, plan ${whoJson.plan && whoJson.plan.name})`);
  log(`primary limit: ${summary.primaryLimit.limit}/hr, remaining ${summary.primaryLimit.remaining}`);

  const owner = whoJson.login;

  // create the scratch repo
  log(`\ncreating PRIVATE scratch repo ${owner}/${REPO_NAME}`);
  const create = await fetch(`${API}/user/repos`, {
    method: "POST",
    headers: headers({ "content-type": "application/json" }),
    body: JSON.stringify({
      name: REPO_NAME,
      private: true,
      auto_init: true,
      description: "Throwaway: GitHub contents-API write-ceiling probe. Delete on sight.",
    }),
  });
  const createBody = await create.text();
  log(`create -> ${create.status}`);
  if (!create.ok) {
    log(redact(createBody).slice(0, 600));
    process.exit(1);
  }
  summary.scratchRepo = { full_name: `${owner}/${REPO_NAME}`, created_status: create.status, private: true };

  let deleted = null;
  try {
    // wait for the auto_init commit to land
    for (let i = 0; i < 10; i++) {
      const r = await fetch(`${API}/repos/${owner}/${REPO_NAME}/contents/README.md?ref=main`, { headers: headers() });
      if (r.ok) break;
      await sleep(1000);
    }

    if (PLAN === "b") {
      // Plan b: payload sensitivity, then the concurrent (production) shape.
      summary.plan = "b";
      summary.runs.large = await sustainedRun(owner, REPO_NAME, "B/4KB", LARGE_BYTES, "b", 3 * 60 * 1000);
      if (summary.runs.large.outcome === "secondary_limit") {
        summary.recovery = await measureRecovery(owner, REPO_NAME, "rec");
      } else {
        summary.recovery = { outcome: "not_applicable", why: summary.runs.large.outcome };
        summary.runs.burst = await concurrentBurst(owner, REPO_NAME, 10, SMALL_BYTES, 120 * 1000, "c");
        if (summary.runs.burst.outcome === "secondary_limit") {
          summary.recovery = await measureRecovery(owner, REPO_NAME, "rec");
        }
      }
    } else {
      // Run A — small payload
      summary.plan = "a";
      summary.runs.small = await sustainedRun(owner, REPO_NAME, "A/small", SMALL_BYTES, "a");

      if (summary.runs.small.outcome === "secondary_limit") {
        summary.recovery = await measureRecovery(owner, REPO_NAME, "rec");
        if (summary.recovery.outcome === "recovered" && elapsed() < GLOBAL_CAP_MS - 60_000) {
          // Run B — same shape, 4 KB payload
          summary.runs.large = await sustainedRun(owner, REPO_NAME, "B/4KB", LARGE_BYTES, "b");
        } else {
          summary.runs.large = { outcome: "skipped", why: `recovery=${summary.recovery.outcome}, elapsed=${Math.round(elapsed() / 1000)}s` };
        }
      } else {
        summary.recovery = { outcome: "not_applicable", why: summary.runs.small.outcome };
        summary.runs.large = { outcome: "skipped", why: "run A never tripped the secondary limit" };
      }
    }
  } finally {
    if (KEEP) {
      log("\n--keep set: scratch repo NOT deleted");
    } else {
      log(`\ndeleting scratch repo ${owner}/${REPO_NAME}`);
      const del = await fetch(`${API}/repos/${owner}/${REPO_NAME}`, { method: "DELETE", headers: headers() });
      const delBody = await del.text().catch(() => "");
      deleted = { status: del.status, body: redact(delBody).slice(0, 200) };
      log(`delete -> ${del.status} ${del.status === 204 ? "(204 No Content = deleted)" : redact(delBody).slice(0, 200)}`);
      // Confirm it is gone.
      const check = await fetch(`${API}/repos/${owner}/${REPO_NAME}`, { headers: headers() });
      deleted.confirm_get_status = check.status;
      log(`confirm GET repo -> ${check.status} ${check.status === 404 ? "(404 = gone)" : ""}`);
    }
    summary.deletion = deleted || { skipped: true };
  }

  // strip raw latency arrays from the printed summary, keep the stats
  for (const k of Object.keys(summary.runs)) {
    const r = summary.runs[k];
    if (r && r.latencies) {
      const l = r.latencies;
      r.latency_ms = {
        n: l.length,
        median: l.slice().sort((a, b) => a - b)[Math.floor(l.length / 2)],
        mean: Math.round(l.reduce((a, b) => a + b, 0) / l.length),
      };
      delete r.latencies;
    }
  }
  summary.totalElapsedSec = Math.round(elapsed() / 1000);

  log("\n================ SUMMARY (JSON) ================");
  console.log(redact(JSON.stringify(summary, null, 2)));
}

main().catch((e) => {
  console.error(redact(e && e.stack ? e.stack : String(e)));
  process.exit(1);
});
