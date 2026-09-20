#!/usr/bin/env node
// tools/seal_batch.js — the operator command that seals the open Merkle batch.
// MERKLE_BATCHING_DESIGN.md §11 Q3 ("Who runs the sealer"), §9 Phase 1.
//
// This is the scheduling answer, and lib/_sealer.js's header carries the full
// argument. The short version: api/ is at the Vercel Hobby 12-function cap
// (9e8b060), so a scheduled function is a 13th file and is not available;
// opportunistic sealing on an inbound pin is refused by the design itself
// ("starves a quiet witness"); a seal spends a write against the public pin
// repo, so a mode on a public endpoint would need a new operator-auth surface
// built before the first seal, and a command needs none — running it already
// requires the token the seal spends.
//
// OPERATOR COMMAND
//
//   GITHUB_PIN_TOKEN=...  \
//   GITHUB_PIN_REPO=dan8433-user/arcaeon-witness-pins \
//   GITHUB_USAGE_REPO=dan8433-user/arcaeon-witness-usage \
//   node tools/seal_batch.js
//
// Schedule it at or below batch_interval_seconds (60s default, §3.4) from the
// operator's own scheduler — cron, systemd timer, Windows Task Scheduler. The
// command is a single pass: it reads, decides, and exits. It holds no state
// between runs, because the state is the pending document.
//
// ONE SEALER AT A TIME (2026-09-20, lib/_claim.js)
//
// A seal takes a claim before it closes anything, so running this command twice
// at once — a double cron entry, a manual run landing on top of a scheduled one
// — is now safe: the second one exits 1 with reason `seal_claim_held` and
// writes nothing. It is still worth not doing on purpose; it is no longer a way
// to publish the same leaves under two roots. The claim is a LEASE, not a lock,
// and lib/_claim.js's header says exactly what that does and does not buy.
//
// A claim left behind by a killed sealer expires on its own (default 120s) and
// the next run takes it over. Nothing needs clearing by hand except a claim
// document that has been CORRUPTED — an unparseable `expires_at` is treated as
// live on purpose, so it holds the door until a human deletes the file.
//
// FLAGS
//   --margin=<seconds>     override seal_safety_margin (§3.4 trigger 3)
//   --now=<iso8601>        override the BATCH clock (testing / replay only).
//                          It does NOT move the claim's clock: a lease measures
//                          how long this run has really been alive, and a lease
//                          that moved with a replay clock would measure nothing.
//   --claim-ttl=<seconds>  override the claim lease length (default 120)
//   --quiet                exit code only, no JSON on stdout
//
// EXIT CODES — distinct on purpose, so a scheduler's own alerting can tell a
// quiet interval from a witness that cannot seal:
//   0  sealed, or a legitimate no-op (no open batch / trigger not fired)
//   1  REFUSED — nothing was PUBLISHED. Either a read failed and nothing at all
//      was written (fail-closed), or the claim stopped this run: another sealer
//      holds it (`seal_claim_held`), the claim store could not be read
//      (`claim_store_unreadable`), or this run's own lease expired mid-work and
//      it stood down one write short of the root (`claim_lost_before_root`).
//      In the last case the batch was closed and its leaves are held for the
//      next run, same as §10 T4.
//   2  the seal itself failed after the batch was closed. No root published;
//      the leaves are held and the next run absorbs them (§10 T4).
//
// It writes to the PUBLIC pin repo. It never deploys anything, never touches
// the OTS anchor path, and reads the pending document from the private usage
// repo the meter and balance already use.

"use strict";

function parseArgs(argv) {
  const out = { quiet: false };
  for (const a of argv) {
    if (a === "--quiet") out.quiet = true;
    else if (a.startsWith("--margin=")) out.margin = Number(a.slice(9));
    else if (a.startsWith("--claim-ttl=")) out.claimTtl = Number(a.slice(12));
    else if (a.startsWith("--now=")) out.now = new Date(a.slice(6));
    else if (a === "--help" || a === "-h") out.help = true;
    else {
      process.stderr.write(`seal_batch: unknown argument ${a}\n`);
      process.exit(64);
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(require("fs").readFileSync(__filename, "utf-8").split("\n").slice(1, 42).join("\n") + "\n");
    return 0;
  }
  if (!process.env.GITHUB_PIN_TOKEN) {
    process.stderr.write("seal_batch: GITHUB_PIN_TOKEN is not set — refusing to run a seal that cannot write\n");
    return 1;
  }
  if (args.margin !== undefined && !Number.isFinite(args.margin)) {
    process.stderr.write("seal_batch: --margin must be a number of seconds\n");
    return 64;
  }
  if (args.now && !Number.isFinite(args.now.getTime())) {
    process.stderr.write("seal_batch: --now must be an ISO 8601 timestamp\n");
    return 64;
  }

  const sealer = require("../lib/_sealer.js");
  const opts = {};
  if (args.margin !== undefined) opts.sealSafetyMarginSeconds = args.margin;
  if (args.now) opts.now = args.now;
  if (args.claimTtl !== undefined) opts.claimTtlSeconds = args.claimTtl;

  const result = await sealer.sealOnce(opts);
  if (!args.quiet) process.stdout.write(JSON.stringify(result, null, 2) + "\n");

  if (result.refused) return 1;
  if (result.failed) return 2;
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    // An unexpected throw is not a refusal — say so plainly rather than let it
    // be read as the fail-closed path working.
    process.stderr.write(`seal_batch: UNEXPECTED ${err && err.stack ? err.stack : err}\n`);
    process.exit(3);
  });
