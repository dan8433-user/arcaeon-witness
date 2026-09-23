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
