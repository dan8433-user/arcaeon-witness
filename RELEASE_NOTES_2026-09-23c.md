# Release notes — arcaeon-witness, 2026-09-23c release tree (release three: the audit state ON)

Branch `release-candidate-2026-09-23b`, worktree `C:/Users/USER/arcaeon-witness-rc3b`. Local only: nothing pushed, nothing deployed, no Vercel env written, no scheduled task registered, nothing published to the pins repo.

## What production is today

- Deployment `dpl_6uYScywM`, built from `8242bfa` (release two, `RELEASE_NOTES_2026-09-23b.md`). Previous: `dpl_4dBieifo` (`1266d39`).
- `8242bfa` is an ancestor of this tree. So are `983ce57` (the battery test), `f4ab63d` (`audit-state-slice2`) and `9eac76a` (`vocabulary-2026-09-23`).

## What changed over production

| Change | Commits | Touches live behaviour? |
|---|---|---|
| Battery case for the one `m > n` proof the RFC walk accepts without the size guard | `983ce57` | No, test only |
| Audit state slice 2: `tools/operator_keys.js`, `tools/self_check_daily.js`, outside check sources by URL (`WITNESS_CHECK_SOURCES`), the JSON twin carries audit states | `f4ab63d`, merged `739f18e` | **Only with `WITNESS_AUDIT_STATE` on.** Flag off: no read of `checks/`, no `audit` key |
| Vocabulary pass: `/api/verify` notes open with VERIFIED / BROKEN / COULD NOT LOOK; audit cell "NOT FULLY READ" becomes COULD NOT LOOK | `9eac76a`, merged `ca24220` | **Yes, text only:** the `note` (or `error`) string of `/api/verify` gains a leading word. No JSON field, `reason`, `witnessed` value or status code moves (pinned by `test/verify_vocabulary.test.js`) |
| Superseded test namespaces on the audit surfaces (`velouria-selftest`, the helm's call); daily self-check task installer | `f05c61e` | **Only with the flag on** |

### Merge conflicts and how they were resolved

- `audit-state-slice2`: no conflicts.
- `vocabulary-2026-09-23`: `CHANGELOG.md` (both entries kept) and `lib/_audit_status.js` (slice 2's outside-sources comment and its partial cell, which adds "(an outside check source was not fully read)", kept; the vocabulary pass's COULD NOT LOOK applied to that human text). One slice 2 test that read the cell text follows the word. **Not changed, on purpose:** the JSON twin's `state: "NOT_FULLY_READ"` and its `badge: "NOT FULLY READ"` (the vocabulary pass must not move a JSON field), and the summary's "N not fully read." suffix (the vocabulary branch never touched it). So the page cell says COULD NOT LOOK while the JSON badge and the summary suffix still say NOT FULLY READ. Wording, the helm's call; nothing reads those strings.

## The flag

`WITNESS_AUDIT_STATE`: `1`, `true` or `on` (trimmed, case-insensitive) turns it on; anything else, or unset, is off.

- **Off** (production today): `/status` and `/api/status.json` are byte-identical to `8242bfa` (proof below). `checks/` and `superseded/` are not read.
- **On:** every `/status` row leads with its audit state (BLIND / SELF-CHECKED / CHECKED / STALE / BROKEN, or COULD NOT LOOK where the evidence was not all read) and the cadence badge follows it as "cadence: ..."; the header panel carries the BLIND-first line ("0 of N namespaces checked by a key not declared as ours. N namespaces: a blind, b self-checked, c checked, d stale, e broken."). `/api/status.json` gains `namespaces[].audit` and a top-level `audit` (`headline`, `aggregate`, `counts`, `notes`, `sources`, `superseded_test_namespaces`). A namespace the page will not derive carries `state: "NOT_FULLY_READ"` and no state word. The flag changes nothing on `/api/badge`, the overall OK/DEGRADED word, or any write path.
- Related variables, all left **unset** by this release: `WITNESS_CHECK_SOURCES` (outside check locations; one unreadable source blanks every state, D15), `WITNESS_CHECK_SOURCES_TOKEN`, `WITNESS_OPERATOR_CHECK_KEYS`.

## `velouria-selftest`: superseded as a test namespace

The helm's decision: supersede it as a test namespace, visibly; it stays in the record; its state reads "TEST" if the design's vocabulary allows that without a new verdict word.

**It does not, so "TEST" was not added.** The design's B3 has five states, "derived, never set by hand", and a BROKEN is permanent unless it is shown wrong (D1). A TEST in the state slot would be a sixth word, set by our own declaration. That needs the helm's word; it is the one open question this release sends back.

What was built, using only words already on the record (D19): the supersede record `superseded/velouria-selftest.json` (`lib/_test_ns.js`: create-only, "removes nothing") plus a grey tag, the way the cadence column's `retired` tag works. The row keeps its derived state, is tagged **superseded test namespace**, and is left out of the headline and the aggregate. The page says why in one sentence. From the live pins tree plus the prepared pins commits plus today's eight self-check records (rendered locally, flag on):

```
velouria-selftest   BROKEN  [grey tag: superseded test namespace]   (counted: false)
headline: 0 of 7 namespaces checked by a key not declared as ours. 7 namespaces: 0 blind, 7 self-checked, 0 checked, 0 stale, 0 broken.

velouria-selftest is left out of the counts above because it was superseded as a test namespace on 2026-09-23
(superseded/velouria-selftest.json: the operator's own self-test namespace, pinned 2026-08-14 with placeholder
chain values; test data, not a customer's log); nothing in it is removed, and its audit state, BROKEN, stays on its row.
```

Control, without the supersede record: `8 namespaces: 0 blind, 7 self-checked, 0 checked, 0 stale, 1 broken.` (the slice 2 addendum's reading). On day one, before any self-check record is published, the same row reads BLIND, and the headline `7 namespaces: 7 blind, 0 self-checked, 0 checked, 0 stale, 0 broken.`

A supersede file that is present but not a readable v1 supersede record for that namespace is ignored and named in a note, and the row stays **counted**: a read error never takes a red out of the totals.

One seam: the record's `test_namespace` field reads `false` for `velouria-selftest`. That field means "carries a test prefix", and `test/no_delete_record.test.js` pins `velouria-selftest` as not test-prefixed; the supersede took the deliberate path the tool names for it (`--any-namespace`). The page's wording and the reason text say test data. The JSON twin does not repeat `test_namespace`.

## Tests

`npm test` (Node 24, `node --test "test/*.test.js"`): **689 tests, 689 pass, 0 fail, 0 todo.** Measured at each step: 678 after both merges (release two's 646, plus slice 2's 26 and the vocabulary pass's 6), 689 with `test/audit_superseded.test.js` (11).

Break arms, each run against the full suite on this tree and restored byte for byte (`git status` clean after the run):

| Arm | Mutation | Fail |
|---|---|---|
| Lying verifier | `lib/_check_record.js`: the Ed25519 signature check removed (a bad signature reads as good) | **4** (signature covers every field; tampered record counted not folded; tampered source file; counts) |
| Lying verifier | `lib/_audit_state.js`: derive always CHECKED | **48** |
| Forged proof | `lib/_logtree.js` `verifyConsistency` accepts any proof | **4** (refusal battery, follow.js agreement, both lying-verifier arms) |
| Forged proof | `lib/_logtree.js` `verifyInclusion` accepts any proof | **1** (inclusion refusals) |
| Forged proof | `lib/_merkle.js` `verifyInclusion` accepts any proof | **39** |
| Rewritten store | `lib/_stamp.js` `recordMatches` always true (a stamp stored at another record's path) | **6** (the S-1 CONTRACT 409 `record_mismatch` cases) |
| Rewritten store | `lib/_verdict.js` `judgeRead` returns null (a present-but-damaged read goes on) | **230** |
| Supersede | any file at `superseded/<ns>.json` is taken as a supersede record | **6** (fail-direction cases; the non-JSON case is not among them) |
| Supersede | superseded rows stay in the totals | **2** |

(Arm counts differ from release two's because the suite grew: derive-always-CHECKED was 29 at 646 tests, judgeRead-null 166.)

## Flag-off byte-identity

`WITNESS_AUDIT_STATE` unset, frozen clock `2026-09-23T12:00:00Z`, the same in-memory store, `/status` and `/api/status.json` rendered from `8242bfa` (`git archive`, identical to the release-two export `velouria/bridge/tmp/witness_release_2026-09-23b`) and from this tree:

| Store | HTML | JSON |
|---|---|---|
| Healthy (two namespaces, anchor present) | **identical**, 13184 bytes, sha256 `83e2322b…` | **identical**, 3561 bytes, `d6c0f6fe…` |
| Mixed (overdue, legacy no-deadline, heartbeat, retired via `WITNESS_RETIRED_NS`, one conflict observation, `velouria-selftest`), with `checks/OPERATOR_KEYS.json`, a BROKEN and a VERIFIED check record and `superseded/velouria-selftest.json` added to this tree's store only | **identical**, 19084 bytes, `f8fe474c…` | **identical**, 7795 bytes, `ca46b186…` |

Both trees made the same 22 store reads on the mixed render: flag off, this tree reads neither `checks/` nor `superseded/`.

## The public artefacts, prepared and NOT published

1. **`checks/OPERATOR_KEYS.json`**: `C:/Users/USER/arcaeon-witness-pins` (a fresh clone of `dan8433-user/arcaeon-witness-pins`; the genesis checkpoint was committed through the contents API from velouria's read-only mirror `bridge/state/logtree/pins_mirror.git`, which cannot carry a branch), branch `operator-keys-2026-09-23`, commit `b902769`, not pushed. Two public keys, generated by `tools/operator_keys.js --check-key <the self-check PEM> --declared-at 2026-09-23`:
   - `ed25519:0qHHQ/RYvaOKDSgFsDk4Lgj9i7t3KIDniO7uVwyBDTs=`, `arcaeon.io/witness-log/2026-09-22`, the witness-log checkpoint signer (its source verifier string equals `bridge/arcaeon/logtree_verifier_key.txt`);
   - `ed25519:cgMyBlr5L9O40w0kWM+2F5pv2niyYUAcka7emwxd8OE=`, the daily self-check key.
   Same branch, commit `b7c3cc8`: **`superseded/velouria-selftest.json`** (`last_seq` 4, read from the namespace's `latest.json`). Both stored with LF endings. One push publishes both: `git -C C:/Users/USER/arcaeon-witness-pins push origin operator-keys-2026-09-23:main` (a pins-repo write: Daniel's go). Neither path is a leaf in the witness log v1 (`lib/_logtree.js` eligible set), so the daily checkpoint is unaffected.
2. **Daily self-check task**: `tools/install_self_check_task.ps1` in this tree. Wires `node tools/self_check_daily.js --key <self-check PEM> --operator-keys <pins checkout>/checks/OPERATOR_KEYS.json --verify-py <verifier two> --out %USERPROFILE%\.arcaeon\self_check_out --write`, daily 03:30 (after the 02:45 checkpoint and 03:15 anchor). Parsed clean; not registered (`Get-ScheduledTask arcaeon-witness-self-check` finds nothing). The CLI itself was run today, dry and then with `--write` into the session scratchpad only: 8 records, 7 VERIFIED, 1 BROKEN (`velouria-selftest`), 0 skipped. **Gap:** nothing publishes the records into the pins repo's `checks/`; until something does, the audit column reads BLIND for every namespace. That publisher is not written.
3. This file.

## Before deploying

- **Push the pins branch first and read it back** (the two URLs in the read-back list). With the flag on and `OPERATOR_KEYS.json` absent, the page says so in a note and holds every key at SELF-CHECKED at most (D4): safe, but not the intended first view.
- **The re-run command under every BLIND badge names `verify.py`, which is not published** (slice 1 finding 2: "a door painted on a wall"). Turning the flag on shows that line on every row. Publishing verifier two, or pointing `rerunCommand` at its public home, is still open. This release does not fix it.
- Release two's standing item carries: the read-only pass over the live pins, usage and stamps repos for documents that break the verdict layer's shape assumptions.

## Environment write (the one change that turns it on)

Name `WITNESS_AUDIT_STATE`, value `1`, target `production`. Same REST shape the owner used for `WITNESS_LOG_SIGNER_KEY` (`docs/LOGTREE_KEY_RUNBOOK.md` section 2; the copy in `velouria/bridge/tmp/witness_release_2026-09-23b/docs/`). The token is read from the environment, never typed:

```
POST https://api.vercel.com/v10/projects/prj_A06c9220XDkqUt9PrKBJZ1YBNwPO/env?teamId=team_buKMBUUmpIrIkNbm6J16bJp9
Authorization: Bearer $VERCEL_TOKEN
Content-Type: application/json

{"key": "WITNESS_AUDIT_STATE", "value": "1", "type": "plain", "target": ["production"]}
```

`plain`, not `encrypted` as for the signer: the value is not a secret, and a `plain` value reads back in `GET /v9/projects/prj_A06c9220XDkqUt9PrKBJZ1YBNwPO/env?teamId=team_buKMBUUmpIrIkNbm6J16bJp9`, which is the check that it appears once, `target` `["production"]`, value `1`. If the POST answers a conflict, the variable already exists: read it back before touching it. The env change takes effect on the next deployment only, so write it immediately before the deploy below, not earlier (any other deploy in between would turn the flag on with whatever tree it carries).

## Deploy (one command, when Daniel says go)

Export made the same way as release two (`git archive` of the branch into `velouria/bridge/tmp/witness_release_<date>`, plus the project link). Prepared already at `C:/Users/USER/velouria/bridge/tmp/witness_release_2026-09-23c` from the branch tip (the commit that adds this file; `git -C C:/Users/USER/arcaeon-witness-rc3b rev-parse release-candidate-2026-09-23b` names it). If the branch moves, delete the directory and re-make it:

```bash
OUT=C:/Users/USER/velouria/bridge/tmp/witness_release_2026-09-23c
mkdir -p "$OUT" && git -C C:/Users/USER/arcaeon-witness-rc3b archive release-candidate-2026-09-23b | tar -x -C "$OUT"
mkdir -p "$OUT/.vercel" && cp C:/Users/USER/arcaeon-witness/.vercel/project.json "$OUT/.vercel/project.json"
```

With `VERCEL_TOKEN` in the environment:

```
npx.cmd --yes vercel@59.25.0 deploy --cwd C:/Users/USER/velouria/bridge/tmp/witness_release_2026-09-23c --prod --yes --scope arcaeon --archive=tgz
```

## Rollback target

`dpl_6uYScywM` (`8242bfa`, current production): `npx.cmd --yes vercel@59.25.0 rollback dpl_6uYScywM --scope arcaeon` with `VERCEL_TOKEN` set. Previous: `dpl_4dBieifo` (`1266d39`). Nothing in this tree writes to any store, so a rollback orphans nothing. The flag alone can also be turned off by deleting the variable (`DELETE /v9/projects/{id}/env/{envId}`) and redeploying. [Not verified here: that an instant rollback serves the old deployment with the env it was built with, which is Vercel's documented behaviour for env changes needing a new deployment. If the page still shows audit states after a rollback, delete the variable and redeploy.]

## Post-deploy read-back

Release two's six, then three for this release.

1. `GET https://witness.arcaeon.io/api/stamp?sha256=89fe2de58e7e9a07238b1a5f01bc4ea1347dfdf8005489e297d3279549d0e6aa` is **200**, `ok:true`, and the record's `sha256` is that exact value.
2. `GET /api/health` is **200**.
3. `GET /api/latest?ns=<a live namespace>` is **200** `ok:true`, and `/api/verify` on that namespace's current head is `witnessed:true`, now with a `note` that starts `VERIFIED: ` (the vocabulary pass; the field is unchanged).
4. `/status`: the cadence side unchanged against a capture taken just before the deploy (every row's cadence badge, now after "cadence:", the overall word, the stats). New and expected: the audit column and the audit panel. No `conflicts not counted`, no `?` in the conflicts stat, no `not a readable pin record` row. `/api/status.json` `status` and `conflicts_observed` match the pre-deploy capture.
5. `py C:/Users/USER/velouria/bridge/tmp/stamps_release/verify_stamps_live.py` reports **PASS**.
6. `GET https://witness.arcaeon.io/api/fulfill?session_id=cs_live_a12bGzwu6rBFgFbl7eyHQQQGNfgK2B8Yz2IuqU9Hhm83aiRfq0ugi734jo` with `Accept: application/json` is **200** with a non-null `namespace` and `prefix_resolved_from: "WITNESS_KEYS"`. Do not paste the key from the body anywhere.
7. **Audit-state status line.** `/api/status.json` has `audit.enabled: true`, `audit.own_keys_unknown: false`, and, with the pins branch pushed and no self-check records published yet, `audit.headline` `0 of 7 namespaces checked by a key not declared as ours.` and `audit.aggregate` `7 namespaces: 7 blind, 0 self-checked, 0 checked, 0 stale, 0 broken.` (if the live namespace set still matches today's eight), `counts.superseded_test: 1`, and `superseded_test_namespaces[0].namespace` `velouria-selftest`. The `/status` summary panel carries the one-sentence `velouria-selftest is left out of the counts above because it was superseded as a test namespace ...` line, and that row carries the grey `superseded test namespace` tag.
8. **`https://github.com/dan8433-user/arcaeon-witness-pins/blob/main/checks/OPERATOR_KEYS.json`** (and its raw twin) returns the two keys above, byte-equal to `b902769`'s file.
9. **`https://github.com/dan8433-user/arcaeon-witness-pins/blob/main/superseded/velouria-selftest.json`** returns the record from `b7c3cc8`.

If any of 1, 2, 3 or 5 fails, or 4 shows a new red cadence row, roll back to `dpl_6uYScywM` first and diagnose after. If only 7 is wrong, the cheaper fix is to delete `WITNESS_AUDIT_STATE` and redeploy.

## What I could not confirm

- The Vercel side: that `WITNESS_AUDIT_STATE` does not already exist, and rollback-with-env behaviour. No token was used.
- That the live namespace set at deploy time is still today's eight (the headline numbers in item 7 assume it).
- In a `git archive` export (no `.git`), one test fails by construction: `test/logtree_keygen.test.js` ".gitignore covers the suffix the tool insists on" runs `git check-ignore`, which exits 128 outside a repository. Seen on the `983ce57` export (646 tests, 645 pass); it passes in the worktree. Environment, not code.
- The exact script the owner ran for `WITNESS_LOG_SIGNER_KEY`: only its documented shape was found (runbook section 2; `bridge/arcaeon/CHANGELOG.md` records that the owner put the key on Vercel).

## Addendum: the self-check publisher (closes the gap in item 2 above, in code; nothing published)

`tools/publish_self_checks.js`, wired into the daily task. Still local only: not run live, no token read, nothing pushed, task not registered.

### What it does

It takes the records `tools/self_check_daily.js --write` left under its `--out` directory for a day (or `--days N` ending on `--date`) and puts each one, byte for byte, at the path the status page reads. **The reader is the contract:** `lib/_audit_status.js` lists the tree and reads every blob matching `^checks\/(pin|observation)\/([^/]+)\/[^/]+\.json$`, one record per file, and the file name is `lib/_check_record.js` `checkRecordPath(record)`: `checks/pin/<ns>/<checked_at with dashes>-<keyid8>.json`. There is no per-day bundle file; a bundle per day would not be read at all.

Before anything is sent, every record of the run must pass all of these, or **nothing** from that run is published (exit 2):

1. `verifyCheckRecord`: the design's record shape (unknown fields refused, public https inputs only), the Ed25519 signature over every field, not future-dated. Also refused: not JSON, or a UTF-8 byte-order mark.
2. Its local path equals `checkRecordPath(record)`, so the name and the content agree and a record cannot be filed under another namespace.
3. Its checker key is in the local `OPERATOR_KEYS.json` and, live only, in the **published** `checks/OPERATOR_KEYS.json` on `main`. If the published declaration is absent or lacks the key, the run is refused: a self-check under a key the public list does not name would read on the page as an outside check (design B5).

Live mode (`--publish`) is create-only and idempotent. It GETs every target path before the first PUT: 404 means create; 200 with the same git blob sha means already published, skipped; 200 with different bytes refuses the run (records are never overwritten). A second run over the same records makes no commit. A run that died between PUTs resumes on the next run. Auth and commit shape are the genesis checkpoint's (`velouria/bridge/arcaeon/logtree_checkpoint.py` through `ots_anchor._token` and `_gh`): the `GITHUB_TOKEN=` line of `C:/Users/USER/velouria/.env`, never on argv, never printed; `Authorization: Bearer`, `Accept: application/vnd.github+json`; one contents-API PUT (one commit) per file to `main` of `dan8433-user/arcaeon-witness-pins`. One addition: a `User-Agent` header, which GitHub requires and Python's urllib sends by itself but Node's fetch does not. Commit message: `checks: <RESULT> <ns> (self-check <checked_at>, key <keyid8>)`.

`checks/` is not in the witness log's eligible set (`lib/_logtree.js`: pins, observations, anchors), so these commits add no leaves and do not disturb the daily checkpoint.

### The daily task: write, then publish

`tools/install_self_check_task.ps1` now registers a task that runs `tools/self_check_daily_run.ps1` (new). The installer takes `-EnvFile` (default `%USERPROFILE%\velouria\.env`), checks that it exists, and never reads it. Step 1 is the unchanged write. Step 2 is `publish_self_checks.js --publish --days 7`, run even if step 1 exited 2 (one SKIPPED namespace still leaves the others written). The publish step **fails soft**: a non-zero exit is one log line (`PUBLISH FAILED SOFT (exit N); records stay in <OutDir>, the next run retries the last 7 days ...`), and the task's result stays the write step's code. Seven days back means a failed day is picked up by the next run at the cost of GETs only. Both scripts parse clean. The runner was run once offline against a scratch dir holding today's records, with a missing key and a token-less env file: write logged exit 2, publish validated the 8 records, stopped at the token read, logged the soft failure; no network.

One bug found and fixed while doing that: `Set-Location` moves only PowerShell's location, and a child `cmd.exe` starts in the process directory, so `node tools\...` resolved against the wrong folder. The runner now sets the process directory too and names both tools by absolute path.

### Dry run (the exact command; no token, no network)

```
node C:/Users/USER/arcaeon-witness-rc3b/tools/publish_self_checks.js --dir <self-check out dir> --operator-keys C:/Users/USER/arcaeon-witness-pins/checks/OPERATOR_KEYS.json --date 2026-09-23 --dry-run
```

Add `--show-bytes` to print each file's bytes. Per record it prints `WOULD PUT  main:<path>  <n> bytes  sha256 <hex>  blob <git blob sha>  <RESULT>` (the blob sha is what the live run compares against). On today's eight records (the 13:40:45Z run): 8 paths, 14911 bytes, 7 VERIFIED, 1 BROKEN, exit 0:

```
checks/pin/test-freeplan-smoke/2026-09-23T13-40-45Z-d751d8aa.json
checks/pin/velouria-audit-20260819/2026-09-23T13-40-45Z-d751d8aa.json
checks/pin/velouria-cadence-verify/2026-09-23T13-40-45Z-d751d8aa.json
checks/pin/velouria-canon/2026-09-23T13-40-45Z-d751d8aa.json
checks/pin/velouria-demo/2026-09-23T13-40-45Z-d751d8aa.json
checks/pin/velouria-metersmoke-1786722009/2026-09-23T13-40-45Z-d751d8aa.json
checks/pin/velouria-metersmoke-final/2026-09-23T13-40-45Z-d751d8aa.json
checks/pin/velouria-selftest/2026-09-23T13-40-45Z-d751d8aa.json   (BROKEN)
```

`d751d8aa` is `keyIdShort` of the declared self-check key `ed25519:cgMyBlr5...`. One blob sha was cross-checked against `git hash-object --no-filters`: equal.

### What the first live publish changes (pins branch pushed first; the publisher refuses otherwise)

- **Flag off (production today): nothing on the page changes.** The flag-off render does not read `checks/`. The pins repo gains 8 commits.
- **Flag on:** every counted namespace moves from BLIND to SELF-CHECKED, dated 2026-09-23. The headline stays `0 of 7 namespaces checked by a key not declared as ours.` (all eight records are under our own declared key, so CHECKED is not reachable, by design), and the aggregate moves from `7 namespaces: 7 blind, 0 self-checked, 0 checked, 0 stale, 0 broken.` to `7 namespaces: 0 blind, 7 self-checked, 0 checked, 0 stale, 0 broken.` The `velouria-selftest` row turns red BROKEN, keeps its grey `superseded test namespace` tag, and stays out of the counts. This is the reading already rendered locally above (live pins + prepared pins commits + these eight records). Read-back item 7's expected numbers are the pre-publish ones; after a publish, expect the self-checked line instead.

### Found, not fixed: the reader's read budget runs out on day 13

`lib/_audit_status.js` reads at most `MAX_RECORD_READS = 100` record files per render, across all namespaces, oldest path first, and a namespace whose records were not all read renders COULD NOT LOOK (`if (readsUsed >= MAX_RECORD_READS) { partial = true; break; }`). Eight records a day, never deleted (create-only), fill that budget in twelve days. Measured with the mock store and eight namespaces: with 12 days of records all eight read SELF-CHECKED; with 13 days the eighth reads COULD NOT LOOK, and one more namespace goes each day after. The supersede read spends from the same budget. **So the daily task should not be registered until the reader reads only what it needs** (for example the newest records per namespace, plus whatever a BROKEN needs to stay permanent), or the budget changes. That is a change to page code behind the flag, so it is the helm's call and is not in this commit.

### Tests

`test/publish_self_checks.test.js` (12): record-shape validation (a good record passes; not JSON, BOM, unsigned, unknown field, bad result, non-public input, wrong path, future-dated and undeclared key each refused with its own reason); day selection; the dry run (exact paths, lengths, sha256, blob sha and bytes printed; no token read; `fetch` replaced by a thrower and never called); exactly one of `--dry-run` / `--publish`; idempotence on a fake contents API (3 PUTs, then a second run with 0 PUTs and `0 created, 3 already published`, every GET before the first PUT); resume after a partial run; the create-only conflict refuses before any PUT; the published-declaration fence (absent, and key missing); a failed PUT; and the reader contract (what the stub received, seeded into the mock store, moves a namespace from BLIND to SELF-CHECKED and keeps a BROKEN red).

**Break arm:** a record whose `result` was flipped after signing is refused as `bad_signature (sig)` in both modes, with no token read, no GET and no PUT, and the good record in the same run waits too. Mutations, run and restored (`git status` clean after): the publisher ignoring `bad_signature` fails **1** (that arm); release three's lying-verifier arm (the signature check removed from `lib/_check_record.js`) now fails **5** (4 before, plus this arm).

`npm test`: **701 tests, 701 pass, 0 fail, 0 todo** (689 + 12).

### Still not confirmed

- A live run: no GitHub call was made. The contents-API behaviour relied on (404 for an absent path, `sha` = git blob sha on a GET, 201 on create) is GitHub's documented behaviour and what the genesis publisher relied on; here it was exercised only against a stub.
- That the token in velouria's `.env` still has contents-write on the pins repo (the genesis checkpoint used it; not re-checked, since checking means a network call with the token).
- The `rerun` field of today's records names a local path (`C:/Users/USER/velouria/projects/online_business/verifier_two/verify.py`). Publishing puts that string in a public repo: it shows a Windows user folder name and repeats the unpublished-verifier problem under "Before deploying". Not changed: the records are signed, and changing the field means changing the writer and re-running it.
- The session scratchpad holds two other record sets: 06:13:45Z today (same key) and 2026-09-22 19:45:00Z (a different key, `28865cfd`, not in `OPERATOR_KEYS.json`; the publisher would refuse it). Only the 13:40:45Z set is the one these notes name. A folder holding two runs of one day publishes both; the scheduled task's `-OutDir` holds only the task's own runs.

## Addendum: the two go-live blockers fixed (reader budget, local path in `rerun`); nothing published, nothing deployed

Commit `d903748` (code and tests) plus the commit that adds this addendum (docs). Still local only: no push, no deploy, no env write, task not registered, nothing in the pins repo.

### 1. The reader reads each key's newest records (D20)

`lib/_audit_status.js`, behind the same flag. Per namespace the record files are grouped by checker key (the `keyid8` in the file name), ordered newest first by the file-name timestamp, and the newest 3 of each key are read. Older same-key records are superseded (each check is a full re-run over the whole history) and do **not** make a namespace COULD NOT LOOK; the cell says "N older records not read: each checker key's newest 3 were, and a key's newer check supersedes its older ones", and the JSON twin carries `records_older_not_read`. Global cap `recordReadCap(n) = n * 13` (104 for 8 namespaces), a safety net only.

**One deliberate departure from the brief:** slots are per key, not per namespace. With K per namespace, our own daily self-check would push an outside BROKEN out of the read set within 3 days (D1 broken by our own schedule). Residual, pinned by a test and written up in D20: a key's own BROKEN followed by 3 later records from the same key is no longer read. If the helm wants D1 literal, the fix is the result in the file name (nothing is published yet, so the path scheme is still free) or a BROKEN index.

Measured on the mock store: 8 namespaces x 30 days (4 own-key only, 4 with an outside key as well) all derive, 4 SELF-CHECKED and 4 CHECKED, 0 COULD NOT LOOK, 36 reads; 8 x 60 days, all SELF-CHECKED, 24 reads.

### 2. `rerun` is portable (D21)

`lib/_check_record.js` refuses a backslash, a drive letter, or a home-directory path in `rerun` (`rerun_not_portable`) at sign and verify; the publisher checks it again in pre-flight. The writer (`tools/check_and_sign.js`, used by `self_check_daily.js`) writes `PUBLIC_VERIFIER` = `verify.py` instead of the local path. **Verifier two is not published anywhere** (pins repo `main` and `operator-keys-2026-09-23` trees, its README, this repo's docs, the design page all checked), so `verify.py` is the placeholder the page's `rerunCommand` already printed; when it has a public home, that one constant changes. The "Before deploying" item about the door painted on a wall still stands.

Writer re-run today into the session scratchpad (`scratchpad/self_check_out_rc3b_fix`, not the pins repo): 8 records at 14:44:51Z, 7 VERIFIED, 1 BROKEN (`velouria-selftest`), 0 skipped. Every `rerun` now reads `py verify.py https://github.com/dan8433-user/arcaeon-witness-pins --json > out.json && node tools/check_and_sign.js --from-json out.json --verify-py verify.py --repo https://github.com/dan8433-user/arcaeon-witness-pins --namespace <ns> --key your.pem`. `publish_self_checks.js --dry-run --date 2026-09-23` on them: 8 paths, 13935 bytes, exit 0:

```
checks/pin/test-freeplan-smoke/2026-09-23T14-44-51Z-d751d8aa.json
checks/pin/velouria-audit-20260819/2026-09-23T14-44-51Z-d751d8aa.json
checks/pin/velouria-cadence-verify/2026-09-23T14-44-51Z-d751d8aa.json
checks/pin/velouria-canon/2026-09-23T14-44-51Z-d751d8aa.json
checks/pin/velouria-demo/2026-09-23T14-44-51Z-d751d8aa.json
checks/pin/velouria-metersmoke-1786722009/2026-09-23T14-44-51Z-d751d8aa.json
checks/pin/velouria-metersmoke-final/2026-09-23T14-44-51Z-d751d8aa.json
checks/pin/velouria-selftest/2026-09-23T14-44-51Z-d751d8aa.json   (BROKEN)
```

The same dry run on the earlier 13:40:45Z set refuses all 8 as `rerun_not_portable (rerun)`, exit 2: those records must never be published. The task's `-OutDir` (`%USERPROFILE%\.arcaeon\self_check_out`) does not exist yet, so no old record sits in its 7-day window.

### Tests and arms

`npm test`: **713 tests, 713 pass, 0 fail** (701 before; +8 `test/audit_reader_newest.test.js`, +4 `test/rerun_portable.test.js`; the old budget test now fills the cap with many keys). Flag-off: 8 namespaces x 30 days of records change nothing on `/status` or `/api/status.json` (same before/after pattern as the supersede test, clock text masked), and no `checks/` path is read.

Break arms, each restored by `git checkout` (tree clean after): oldest-first within a key fails **4**; per-namespace slots (one key for all) fails **4**; the `rerun` fence removed from `lib/_check_record.js` fails **1** (the publisher's own pre-flight still refuses, by design); the writer using a local path fails **7**.

### Export

`C:/Users/USER/velouria/bridge/tmp/witness_release_2026-09-23c` deleted and re-made from the branch tip that carries this addendum, with `.vercel/project.json`, as in "Deploy" above.

### Still not confirmed

- The per-key residual above is a D1 reading the helm has not ruled on.
- Outside sources (`WITNESS_CHECK_SOURCES`) still read every listed record under the 40-fetch budget; a stranger who publishes daily fills it in about 40 days. Unset today, so not a go-live blocker; not changed.
- Everything in the earlier "Still not confirmed" list stands (no live GitHub call, token scope unchecked).

## Addendum 2: D1 literal, the result in the file name (D22); nothing published, nothing deployed

The helm ruled on the D20 residual: per-key newest 3 stands, and D1 holds literally. Still local only: no push, no deploy, no env write, task not registered, nothing in the pins repo.

- **Path scheme, changed once before the first publish:** `checks/<type>/<ns>/<checked_at>-<keyid8>-<result>.json`, result lower-case from the record's own `result`.
- **Reader:** per key, the newest 3 files plus every older file whose name says `broken` (bounded at 20 extra per key; past that the namespace is COULD NOT LOOK with a note). A verified BROKEN keeps the namespace BROKEN whatever the same key publishes later. A file whose name-result disagrees with its signed body is refused (`path_result_mismatch`) and its namespace is COULD NOT LOOK (a choice beyond the ruling's words, written up in D22: a lying name means the name-chosen read set cannot be trusted, and ignoring it could take a red off the page).
- **Publisher:** refuses `path_result_mismatch` in pre-flight. The earlier 14:44:51Z scratchpad set (old names) is now refused as `path_mismatch`, exit 2: unpublishable, as intended.

Writer re-run into the session scratchpad (`scratchpad/self_check_out_rc3b_d22`): 8 records at 14:57:02Z, 7 VERIFIED, 1 BROKEN (`velouria-selftest`), 0 skipped. `publish_self_checks.js --dry-run --date 2026-09-23`: 8 paths, 13935 bytes, exit 0:

```
checks/pin/test-freeplan-smoke/2026-09-23T14-57-02Z-d751d8aa-verified.json
checks/pin/velouria-audit-20260819/2026-09-23T14-57-02Z-d751d8aa-verified.json
checks/pin/velouria-cadence-verify/2026-09-23T14-57-02Z-d751d8aa-verified.json
checks/pin/velouria-canon/2026-09-23T14-57-02Z-d751d8aa-verified.json
checks/pin/velouria-demo/2026-09-23T14-57-02Z-d751d8aa-verified.json
checks/pin/velouria-metersmoke-1786722009/2026-09-23T14-57-02Z-d751d8aa-verified.json
checks/pin/velouria-metersmoke-final/2026-09-23T14-57-02Z-d751d8aa-verified.json
checks/pin/velouria-selftest/2026-09-23T14-57-02Z-d751d8aa-broken.json
```

`npm test`: **718 tests, 718 pass, 0 fail** (713 before; the residual test inverted in place, +5 new). Flag-off tests (5, including 8 namespaces x 30 days of records changing nothing on `/status` or `/api/status.json`) pass. Break arms, each restored after: reader ignoring broken-named files fails **4**; reader accepting a mismatch fails **2**; publisher accepting a mismatch fails **1**.

Export re-made from the tip that carries this addendum.

### Still not confirmed

- The mismatch-makes-COULD-NOT-LOOK choice is mine, not the ruling's; the ruling said "refuse". If the helm wants refuse-and-ignore, it is one line in the reader.
- Outside sources still read every listed record under the 40-fetch budget (unchanged from addendum 1).
- Everything in the earlier lists stands (no live GitHub call, token scope unchecked, verifier two unpublished).
