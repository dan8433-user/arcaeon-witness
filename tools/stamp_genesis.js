#!/usr/bin/env node
// tools/stamp_genesis.js — the WITNESSED BIRTH of the stamps log.
//
// THE PROBLEM. The stamps log gets its own repository (see STAMPS_OWN_REPO.md).
// A brand-new repository's history is exactly as old as its first commit, and
// its first commit's date is whatever its creator's machine and GitHub say it
// is. Nothing outside it vouches for when it began.
//
// THE MOVE. The old log dates the new one. This tool writes ONE record into
// the EXISTING pins repository saying: the stamps log's first commit carries
// this SHA and this date, observed at this time. That record lands as its own
// commit in the pins repo, in a history that already has months of public
// life behind it (its date is the operator's own clock, like every commit
// there; the pins repo's daily Bitcoin anchor is the independent clock). From then on, the
// stamps log's claimed birth has a fixed point in an older record — and a
// later change to either side would show in the public commit history of the
// repository it lives in.
//
// A tool, not an API function. api/ is at the Vercel Hobby 12-function cap
// (9e8b060, and lib/_stamp.js is co-hosted on api/verify.js for the same
// reason). This also runs exactly ONCE in the life of the log, which is a
// command, not an endpoint.
//
// SAFETY, IN THE ORDER IT MATTERS
//   - DRY RUN IS THE DEFAULT. Without --commit it prints the repository, the
//     branch, the path, the commit message and the exact bytes it would write,
//     and exits 0 having touched nothing.
//   - It NEVER creates a repository. Creating the stamps repo is the owner's
//     step, by hand, so that the account, the visibility and the name are his
//     decisions and not a script's.
//   - CREATE-ONLY. It writes with no sha, so if a genesis record already
//     exists at that path GitHub refuses the write and this tool reports it.
//     A birth record that could be overwritten would be worth nothing.
//   - It REFUSES to write the record into the stamps repo itself. A log
//     cannot witness its own birth; the whole point is that a different,
//     older record does it.
//
// USAGE
//   node tools/stamp_genesis.js --sha <40-hex> --date <iso8601> \
//        [--repo owner/stamps-repo] [--branch main] [--commit]
//
//   --sha     the stamps repo's FIRST commit SHA (git rev-list --max-parents=0 HEAD)
//   --date    that commit's committer date, ISO 8601
//             (git log -1 --format=%cI <sha>)
//   --repo    the stamps repo, owner/name. Defaults to $STAMP_REPO.
//   --branch  the stamps repo's default branch. Defaults to $STAMP_BRANCH or main.
//   --commit  actually write. Requires GITHUB_PIN_TOKEN, because the record
//             goes into the PINS repo.
//
// EXIT CODES
//   0  dry run printed, or the record was written
//   1  refused — a precondition failed, nothing was written
//   2  the write itself failed
//   64 bad arguments

"use strict";

// NOT under observations/: lib/_status_data.js counts every observations/*.json as a
// CONFLICT observation on the public status page (review catch, 2026-09-20).
const GENESIS_DIR = "genesis/stamp-log";

// The claim, worded to the public-claim gate: a change "would show"; nothing
// about being impossible to alter, nothing about independent or multiple
// witnesses, nothing implying anyone uses either log.
function buildGenesisRecord({ repo, branch, sha, date, observedAt, pinsRepo }) {
  return {
    kind: "sibling-log-genesis",
    v: 1,
    log: "arcaeon file stamps",
    repo,
    branch,
    first_commit_sha: sha,
    first_commit_date: date,
    observed_at: observedAt,
    observed_in: pinsRepo,
    scope: {
      shows:
        "This repository recorded, in a commit of its own, that the stamps log's first commit " +
        "carries this SHA and this date. The stamps log therefore existed no later than the time " +
        "of the commit that holds this record. A later change to either record would show in the " +
        "public commit history of the repository it lives in.",
      does_not_show:
        "That anything stamped in that log is true. That the stamps log is complete. That no other " +
        "log exists. Who operates either repository. Anything about how either log is used.",
    },
  };
}

function genesisPath(sha) {
  return `${GENESIS_DIR}/${sha}.json`;
}

// The exact bytes lib/_store.js's putFile would send, so the dry run prints
// the artifact and not a paraphrase of it.
function renderBody(record) {
  return JSON.stringify(record, null, 2) + "\n";
}

function parseArgs(argv) {
  const out = { commit: false };
  for (const a of argv) {
    if (a === "--commit") out.commit = true;
    else if (a === "--help" || a === "-h") out.help = true;
    else if (a.startsWith("--sha=")) out.sha = a.slice(6);
    else if (a.startsWith("--date=")) out.date = a.slice(7);
    else if (a.startsWith("--repo=")) out.repo = a.slice(7);
    else if (a.startsWith("--branch=")) out.branch = a.slice(9);
    else return { error: `unknown argument ${a}` };
  }
  return out;
}

// Splits "--sha <value>" style into "--sha=<value>" so both spellings work.
function normalizeArgv(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (/^--(sha|date|repo|branch)$/.test(a) && i + 1 < argv.length) {
      out.push(`${a}=${argv[i + 1]}`);
      i += 1;
    } else out.push(a);
  }
  return out;
}

const SHA_RE = /^[0-9a-f]{40}$/;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

// Pure: every precondition, checked without touching anything. Returns
// {ok:true, plan} or {ok:false, code, error}.
function plan(args, env) {
  const pinsRepo = (env.GITHUB_PIN_REPO || "dan8433-user/arcaeon-witness-pins").trim();
  const pinsBranch = (env.GITHUB_PIN_BRANCH || "main").trim();
  const repo = String(args.repo || env.STAMP_REPO || "").trim();
  const branch = String(args.branch || env.STAMP_BRANCH || "main").trim() || "main";
  const sha = String(args.sha || "").trim().toLowerCase();
  const date = String(args.date || "").trim();

  if (!repo) return { ok: false, code: 64, error: "no stamps repo: pass --repo owner/name or set STAMP_REPO" };
  if (!REPO_RE.test(repo)) return { ok: false, code: 64, error: `--repo must be owner/name (got ${repo})` };
  if (!SHA_RE.test(sha)) return { ok: false, code: 64, error: "--sha must be the stamps repo's first commit SHA, 40 hex characters" };
  if (!date) return { ok: false, code: 64, error: "--date is required (the first commit's ISO 8601 committer date)" };
  const t = Date.parse(date);
  if (!Number.isFinite(t)) return { ok: false, code: 64, error: `--date must be an ISO 8601 timestamp (got ${date})` };
  // A log cannot witness its own birth.
  if (repo === pinsRepo) {
    return {
      ok: false,
      code: 1,
      error:
        `refusing: the stamps repo and the pins repo are the same repository (${repo}). ` +
        "The genesis record exists so an OLDER, SEPARATE record dates the new log; written into " +
        "the same repository it would date nothing.",
    };
  }

  const observedAt = new Date().toISOString();
  const record = buildGenesisRecord({
    repo,
    branch,
    sha,
    date: new Date(t).toISOString(),
    observedAt,
    pinsRepo,
  });
  return {
    ok: true,
    plan: {
      target_repo: pinsRepo,
      target_branch: pinsBranch,
      path: genesisPath(sha),
      message: `stamps log genesis: ${repo} first commit ${sha.slice(0, 12)} (${record.first_commit_date})`,
      record,
      body: renderBody(record),
      create_only: true,
    },
  };
}

function renderDryRun(p) {
  return [
    "DRY RUN — nothing was written. Re-run with --commit to write it.",
    "",
    `  repository : ${p.target_repo}   (the EXISTING pins repo — the older record)`,
    `  branch     : ${p.target_branch}`,
    `  path       : ${p.path}`,
    `  mode       : create-only (no sha sent; an existing record at this path refuses the write)`,
    `  message    : ${p.message}`,
    "",
    "  file contents, exactly as they would be committed:",
    "",
    p.body.replace(/^/gm, "    "),
  ].join("\n");
}

async function main() {
  const parsed = parseArgs(normalizeArgv(process.argv.slice(2)));
  if (parsed.error) {
    process.stderr.write(`stamp_genesis: ${parsed.error}\n`);
    return 64;
  }
  if (parsed.help) {
    process.stdout.write(
      require("fs").readFileSync(__filename, "utf-8").split("\n").slice(1, 52).join("\n") + "\n"
    );
    return 0;
  }

  const res = plan(parsed, process.env);
  if (!res.ok) {
    process.stderr.write(`stamp_genesis: ${res.error}\n`);
    return res.code;
  }
  const p = res.plan;

  if (!parsed.commit) {
    process.stdout.write(renderDryRun(p) + "\n");
    return 0;
  }

  if (!process.env.GITHUB_PIN_TOKEN) {
    process.stderr.write(
      "stamp_genesis: GITHUB_PIN_TOKEN is not set — refusing to attempt a write that cannot succeed\n"
    );
    return 1;
  }

  const store = require("../lib/_store.js");
  try {
    // No sha, and no rebuild hook: create-only. If a genesis record already
    // exists at this path, putFile throws with err.conflict and we say so
    // rather than replacing a birth record.
    const out = await store.putFile(p.path, p.record, p.message, undefined);
    process.stdout.write(
      JSON.stringify(
        {
          written: true,
          repo: p.target_repo,
          path: p.path,
          commit: out && out.commit && out.commit.sha,
          history_url: `https://github.com/${p.target_repo}/commits/${p.target_branch}/${p.path}`,
        },
        null,
        2
      ) + "\n"
    );
    return 0;
  } catch (err) {
    if (err && err.conflict) {
      process.stderr.write(
        `stamp_genesis: a genesis record already exists at ${p.path} — refusing to replace it. ` +
          "A birth record that can be overwritten is worth nothing.\n"
      );
      return 1;
    }
    process.stderr.write(`stamp_genesis: write failed — ${err && err.message}\n`);
    return 2;
  }
}

module.exports = { buildGenesisRecord, genesisPath, renderBody, parseArgs, normalizeArgv, plan, renderDryRun, GENESIS_DIR };

// Only run when invoked directly, so the pure functions above are testable.
if (require.main === module) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(`stamp_genesis: UNEXPECTED ${err && err.stack ? err.stack : err}\n`);
      process.exit(3);
    });
}
