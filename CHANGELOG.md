# Changelog — arcaeon-witness

## 2026-09-22 — inclusion proofs bind tree_size and refuse a bare leaf hash (branch `merkle-fix` from `release-candidate-2026-09-23`, local only, NOT deployed)

Closes the two false-yes findings the Merkle failure-conformance suite left as `todo`. The batch path is still behind `WITNESS_BATCH_SHADOW`; nothing about when it runs changed.

- **M-1, wrong tree_size accepted.** `lib/_merkle.js` `verifyInclusion` used to consume whatever siblings the proof carried, so a 4-leaf proof re-labelled tree_size 5 or 6 still verified. It now walks the tree shape fixed by (leaf_index, tree_size): the path must hold exactly the siblings that shape needs (`path_too_short` / `path_too_long`). Some wrong sizes share a path shape with the real one (leaf 3 of 7 vs of 6), and the root alone does not commit the count, so `verifyInclusion(proof, published)` takes the published root.json record and refuses `tree_size_mismatch` / `published_root_mismatch`. Every ok result carries `tree_size_bound`, false when no record was checked, so an unchecked size is never reported as confirmed. `tools/reconcile_batches.js` now passes root.json's own tree_size.
- **M-2, interior node accepted as a leaf.** A proof with only `leaf_hash` used to take the hash on trust. The leaf record is now required (`leaf_required`) and its hash is always derived under the 0x00 prefix; a supplied `leaf_hash` must match the derived one. No production minting path produced hash-only proofs (`lib/_batch.js` buildProof always includes the leaf).
- `MERKLE_BATCHING_DESIGN.md` §5 pseudocode updated to the tightened algorithm.
- `test/merkle_failure_conformance.test.js`: both todos are real assertions with typed reasons, plus a path-length test. Suite 579, 579 pass, 0 fail, 0 todo.

## 2026-09-22 — witness log go-live prep: the signing key, its runbook, the README key (branch `log-tree-golive` from `release-candidate-2026-09-23`, local only, NOT published, NOT deployed)

The owner decided the checkpoint signing key lives on Vercel (env var on this project) and that this push deploys when done; the helm verifies and publishes. Nothing here wrote to Vercel, pushed, or touched the pins repo.

- **`tools/logtree_keygen.js`.** Mints one Ed25519 pair in `lib/_checkpoint.js`'s own key format (no second key format). Prints ONLY the verifier key and the env var name the publisher expects, `WITNESS_LOG_SIGNER_KEY` (`--key-env`). The signer goes only to `--out`, which must end in `.signer.key`, is created exclusively (an existing file is refused and left byte-identical; rotation is a new name and a new file), mode 0600, and on Windows `icacls`-restricted to the current user. Before reporting success it re-reads the file, signs a throwaway note and verifies it with the printed verifier; on failure the file is deleted. `.gitignore` gains `*.signer.key`. `test/logtree_keygen.test.js`, 4 tests; break arms: a keygen that echoed the signer is caught by a scan of stdout and stderr in both output modes, and a different key must get COULD NOT LOOK from `follow.js`.
- **The real key was minted** (outside every repository, `C:\Users\USER\.arcaeon\witness-log.signer.key`): `arcaeon.io/witness-log/2026-09-22+09765dec+AdKhx0P0WL2jig0oBbA5OC4I/Yu7dyiA54ju7lcMgQ07`. The key name is dated so a rotation is readable on the signature line.
- **`docs/LOGTREE_KEY_RUNBOOK.md`.** How the helm puts the signer on Vercel (`POST /v10/projects/{id}/env`, `type: encrypted`, `target: ["production"]`, value read from the file by a script, never on a command line; read-back by key without the value), why `encrypted` over `sensitive` is a trade the owner should see (an encrypted value can be read back by anyone with a team token), how rotation works (new dated key, overlap by signing with both since a note carries several signature lines and checkers ignore keys they were not given; old checkpoints stay verifiable by the old key forever, nothing is re-signed), what to do if it leaks, and where the public key is published. It states plainly that the key now lives in two places: Vercel, and the local file the daily job signs with, because the job runs on the operator's machine (`api/` is at its 12-function cap). Nothing deployed reads `WITNESS_LOG_SIGNER_KEY` yet.
- **README, new section "Witness log".** The file layout under `log/` in the pins repo, the checkpoint key, how to run `follow.js`, and what a VERIFIED does not tell you. It says that until `log/checkpoints/genesis.txt` exists there is no log to follow.
- **Genesis dry run** (velouria `bridge/arcaeon/logtree_checkpoint.py`, fresh read-only mirror of the pins repo at `abeea2a`, the real key, nothing published): **size 56, root `1b8719021ae9c600018c0f3001e3b180679f1ef8117aac120526f7ba7a661816`** (base64 `G4cZAhrpxgABjA8wAeOxgGefHvgReqwSBSb3unpmGBY=`), the same root slice 1 recorded. `follow.js` with the printed key: VERIFIED (genesis against itself, size 56 -> 56, empty proof); with any other key: COULD NOT LOOK.
- Suite 582, 580 pass, 0 fail, 2 todo (unchanged M-1, M-2).
- **Before the first publish:** this repo's public `main` does not yet contain `tools/follow.js`; the README and the pins repo's `KEYS.md` both point strangers at it, so `main` should carry it first.

## 2026-09-23 — one release tree (branch `release-candidate-2026-09-23`, local only, NOT deployed)

`honest-commit-time-2026-09-22` plus `no-delete-record`, `log-tree-slice1` and `audit-state-slice1`, merged in that order; `8f0c2d1` (production) is an ancestor. See `RELEASE_NOTES_2026-09-23.md`.

- **Correction to the audit-state entry below:** its "with the flag off the page is byte-identical to before (tested)" was not true. The summary placeholder sat on its own template line, so flag-off output gained a 3-byte whitespace line; the test checked vocabulary only. Fixed in `api/status.js` during the merge; a frozen-clock render of this tree with the flag off now matches `d398315` byte for byte, and a new test in `test/audit_status_page.test.js` pins it (fails against the unfixed file).
- `test/helpers/mock_store.js`: the two `git/trees` mocks (sealer reconciler's `treeStatus`/`treeTruncated`, audit state's per-entry `sha` and GET-only routing) are one handler now.
- Suite 578, 576 pass, 0 fail, 2 todo (M-1, M-2, main's strict false-yes rows).


## 2026-09-22 — the commit date is the operator's own clock, not GitHub's (branch `honest-commit-time-2026-09-22`, NOT deployed)

The README (lines 11 and 549), `lib/_store.js`, the status page (`api/status.js`, two paragraphs), `status.json`'s `independence.note`, `PRACTICES.md` §3, `STAMPS_OWN_REPO.md` and `tools/stamp_genesis.js` all said that pin commits are "third-party-timestamped by GitHub" or that "GitHub's clock is the first witness". That is not what git does. A commit's date is whatever the committing client wrote; every commit in the pins repo is made by the operator's own account through the operator's own client or token, and none is signed. GitHub stores the date; it does not vouch for it. The only independent clock in the pins repo is the daily OpenTimestamps (Bitcoin) anchor. Found by the second-lineage verifier (DISAGREEMENTS D11, live-data item 4) against the public pins README, which carries the same sentence and is corrected separately.

- **Wording now, everywhere the claim appeared:** the commit history is public and a rewrite is visible to anyone who cloned or watched before it; a commit's date is the operator's own statement, not a third party's; the independent evidence of time is the daily Bitcoin anchor. `PRACTICES.md` bumps to v1.3 with a dated correction note under its header.
- **The 2026-09-19 entry below** kept the sentence "every pin is a public, third-party-timestamped commit" as a limit a relying party needs. The limit stands; that sentence was wrong and is not repeated here. Old entries are left as written.
- `test/status_posture.test.js`: the LIMIT KEPT test now asserts the page does NOT say third-party-timestamped and DOES say the date is the operator's own statement and that the Bitcoin anchor is the independent evidence. Suite count unchanged.


## 2026-09-22 — nothing is deleted from the record (branch `no-delete-record`, local only, NOT deployed)

An outside verifier written from the spec alone ruled the pin repo BROKEN for 65 records deleted on 2026-08-14 as "test cleanup" (19 namespaces, two of them carrying conflict observations). It could not tell test cleanup from suppression, and neither can anyone else. Those deletions were one-off contents-API calls made by hand; no script in this repo or the velouria repo produced them, and no scheduled task runs one.

- **New rule:** test namespaces use the reserved prefix `veltest-` (older `test-` and `velouria-tmp-` recognised, plus the exact legacy names `velouria-audit<digits>`, so all 19 names removed on 2026-08-14 read as test data; a bare `velouria-audit` prefix is deliberately not used because `velouria-audit-20260819` is live). A finished namespace is never removed. `tools/supersede_namespace.js` publishes a new, create-only record at `superseded/<namespace>.json` that says so; pins and observations stay. Dry run by default; a namespace with no test prefix needs `--any-namespace`. The namespace shape is checked before any network call, and the tool refuses to publish when `latest.json` is missing or its `seq` is not an integer while numbered pin files exist, because a guessed `last_seq` of 0 would be a false statement that nothing came after it.
- **Guard:** `test/no_delete_record.test.js` fails if any file in `lib/`, `api/` or `tools/` gains a DELETE (any case, including a bare `"DELETE"` string literal), `git rm`, or `deleteFile(` call outside a named allowlist (`lib/_balance.js`, private usage repo, no callers; `tools/ceiling_probe.js`, its own throwaway repo). Break arms prove the scan and the create-only write can fail. Suite 351 tests, 346 pass, 0 fail, 5 todo.
- **What a mirror does and does not do:** a no-rewrite mirror (fast-forward pushes only, no `--mirror`, no prune) does NOT stop a deletion commit from reaching it. A contents-API delete is an ordinary new commit, so it fast-forwards onto the mirror like any other. What the mirror keeps is the history that proves the deletion happened and what was deleted, and it refuses a rewrite (force-push or trimmed history) of what it already holds.
- Not yet done: status page and verify do not read `superseded/` yet; the 65 deleted records are not restored (that is a live write to the public repo and needs the owner's go).

## 2026-09-22 — one cumulative Merkle log over the public record, with consistency proofs (branch `log-tree-slice1`, NOT published, NOT deployed)

Slice 1 of `DESIGN_CONSISTENCY_AND_NEVER_LOOKED_2026-09-22.md` Part A. The gap it answers (design F1): `sealBatch` builds a tree per batch and links batches by `prev_root`, which is a hash chain of roots, so promoting the batching never bought a consistency proof. A consistency proof needs one tree that grows. This is that tree, built over every create-only record file in the public pins repo, so a stranger who kept one checkpoint can verify that today's published checkpoint extends it. Nothing in `api/`, `lib/_stamp.js`, `lib/_merkle.js` or `lib/_batch.js` changed; the hashing is `lib/_merkle.js`'s, reused. Suite 334 -> 366.

- **`lib/_logtree.js`.** The leaf is an envelope over a record file's exact committed bytes: `{recipe, kind, path, file_sha256, introduced_by_commit}`, all strings, hashed as `SHA256(0x00 || json_c14n_v1(envelope))` through the repo's one canonicalizer. The bytes are what `git show <commit>:<path>` prints, never a checked-out file (spec §8(e), `core.autocrlf`). The order is the commit that introduced each path, oldest first along first-parent history, ties by path in byte order; the rule and the git command that recomputes it are in the header. Eligible: numbered pins, observations, anchor `.txt`. Excluded by design: `latest.json`, `.ots`, README, `log/`. `inclusionProof` / `consistencyProof` / `verifyInclusion` / `verifyConsistency` are RFC 9162 §2.1.3–2.1.4 transcribed from the RFC text with the RFC's variable names, returning typed reasons. Every design A4 refusal has its own reason: `equal_sizes_nonempty_path`, `old_size_zero`, `old_size_greater_than_new`, `empty_path`, `malformed_hash` (exactly 64 lowercase hex, never trimmed or padded), `path_too_long`, `path_too_short`, `old_root_mismatch`, `new_root_mismatch`.
- **Vectors.** RFC 9162's text carries only the 7-leaf structural example (node names, no hex); that example is asserted node for node (inclusion for d0/d3/d4/d6, PROOF(3), PROOF(4), PROOF(6)). The hex vectors are the RFC 6962 reference implementation's published constants (transparency-dev/merkle `testonly/constants.go`, fetched 2026-09-22, read as data): all 8 leaf hashes, every internal node of the 8-leaf tree, roots for sizes 0..8, and four inclusion and four consistency proofs assembled from that table. All match. Also permanent now (design F5): `buildLevels` equals the RFC recursive MTH and the §2.1.2 stack algorithm for n = 1..300, `proofPath` equals the recursive PATH for every (i, n) with n <= 64, and every (m, n) with n <= 130 verifies with a longest proof of 9. `test/logtree.test.js`, 16 tests.
- **`lib/_checkpoint.js`.** A C2SP-style signed note: `origin\nsize\nbase64 root\n`, then an empty line and `— <name> <base64(keyhash[4] || ed25519 sig)>` lines; the em dash is a format byte. Ed25519 via `node:crypto` only; keys are the `<name>+<hash>+<base64>` verifier and `PRIVATE+KEY+...` signer strings, lifted from raw bytes with fixed DER prefixes so nothing is installed. The signature covers the note text and nothing else. `no_signature_for_key` and `bad_signature` are different reasons because they mean different things (COULD NOT LOOK vs BROKEN). **Written from the C2SP description, not cross-checked against a reference implementation:** interop with other signed-note tooling is not claimed. One bug found by the suite and fixed before commit: splitting a key on every `+` refused any key whose base64 contained one. `test/checkpoint.test.js`, 5 tests.
- **`tools/publish_checkpoint.js`.** Builds the tree from a local clone (read-only git: rev-parse, log, ls-tree, cat-file), writes `checkpoints/<date>.txt`, `leaves/<date>.jsonl`, and with `--prev` `proofs/<date>-consistency.json` into `--out` only, dry run by default, create-only, refuses `--out` inside the clone, never commits or pushes. Refuses (exit 2, nothing written): a path added twice on the walk (D8), a record whose bytes differ from its introducing commit, a previous checkpoint the clone does not reproduce, an existing output file. `--key-env NAME` signs with the key in that environment variable; no key is created or read otherwise. `--help` restates design A9 verbatim. Against a fresh read-only clone of `dan8433-user/arcaeon-witness-pins` at `abeea2a`: **size 56, root `1b8719021ae9c600018c0f3001e3b180679f1ef8117aac120526f7ba7a661816`**, skipped by design latest.json=8, .ots=40, other=1; 46 eligible paths were added in history and are absent at HEAD (not logged, counted; verifier two's 65 is a different denominator). `test/publish_checkpoint.test.js`, 5 tests, fixture repos built in temp dirs.
- **`tools/follow.js`.** The stranger's checker, stdlib only, one file, no `require` of `lib/`: two checkpoints plus the proof plus `--key` -> VERIFIED / BROKEN / COULD NOT LOOK, exit 0/1/2, every result naming what it trusted. Size and root are read from the checkpoint text and the proof's echo must agree (BROKEN otherwise); unknown recipe or origin is COULD NOT LOOK; unsigned with a key expected is COULD NOT LOOK; a signature line that does not verify is BROKEN. Its RFC verifier is a second transcription and the suite cross-checks it against `_logtree.js` on every (m, n) with n <= 64 plus every mutation. Same author, so this is two transcriptions, not two implementers; the design's day-3 Python checker written from the spec alone is still owed. `test/follow.test.js`, 6 tests.
- **Break arms, every suite.** A verifier that always says yes is caught by all 22 consistency mutations; a Bitcoin-style duplicate-last-leaf tree disagrees with the reference roots at every odd size; a signature verifier that only looks for a line naming the key is caught by tampered, forged and moved signatures; a path-only leaf order gives a different root on a fixture built to separate the orders; a checker that always says VERIFIED is caught by every non-VERIFIED battery case; a checker that trusts the JSON echo instead of the checkpoint text passes a swapped root that ours calls BROKEN.
- **Demo on the live clone** (throwaway key, scratch output, nothing published): checkpoint at 51 then at 56 with a 6-hash proof -> `follow.js` VERIFIED; one leaf's `file_sha256` flipped and the size-56 checkpoint re-signed -> BROKEN (`echo_mismatch`, then `new_root_mismatch` once the echo is patched to match); a stranger holding a different key -> COULD NOT LOOK (`no_signature_for_key`).
- **What still stands between this and publishing** (design A10 day 5 and A9, unchanged): the genesis audit (every anchored commit an ancestor of genesis, every `file_sha256` equal to the file at its introducing commit) has not been run as a published self-check; no key exists and where one would be held is open (A11 q3); the daily job is not scheduled; the `witness-log` health dimension and the daily self-check reader are not written (no artifact without a reader); the spec section "The witness log" is not written; deleted-before-genesis records are counted, not logged, and whether that is the right call is a question for the owner; and the log proves the witness's own list of heads was not rewritten, not that a customer's log at head N extends head M (F4), not split view without a second witness, and never that anything recorded is true. Publishing is the owner's call.

## 2026-09-22 — a verdict for NEVER LOOKED, slice 1 (branch `audit-state-slice1`, local only, NOT deployed, flag default off)

Design: `projects/online_business/DESIGN_CONSISTENCY_AND_NEVER_LOOKED_2026-09-22.md`, part B. The finding it fixes: `api/status.js:29` gave a namespace nobody had ever independently checked a green "current" badge and nothing else, so absence of a red read as green. Suite 334 -> 392 (58 new, 0 fail, the 5 `todo` are the pre-existing verify false-yes xfails).

- **`lib/_check_record.js` — the signed check record** (design B4, plus a `rerun` field): who checked (`checker.key`, an Ed25519 public key as its own id), when (`checked_at`), what (`target.type/ref/digest`), the result (VERIFIED / BROKEN / COULD_NOT_LOOK), the tool and its source hash, and the command that reproduces it. Ed25519 via `node:crypto`, signature over json-c14n:v1 of every field except `sig` (the `_distill_core` serializer, so there is still one canonicalizer). `verifyCheckRecord` refuses unsigned, malformed, unknown-field, non-https-input, non-canonical-key, tampered and future-dated (> 300 s ahead) records, each with a named reason, and never throws on bad input. 12 tests; the field-mutation test flips all 25 mutation cases and each must fail; break arm: a verifier that always says ok is caught by every case.
- **`lib/_audit_state.js` — the audit state, derived and never set** (B3, B5, B6): BLIND / SELF-CHECKED / CHECKED / STALE / BROKEN with B3 precedence, 30-day freshness in integer seconds (strict less-than), withdrawn tools and keys, operator keys, unverifiable and COULD_NOT_LOOK counted but never folded in. Also the B7 strings: badge, line under it, the BLIND-first aggregate, the "N of M checked" headline. 32 tests (20 state cases, 6 exact-string cases); break arm: a derive that always says CHECKED is caught by 17 of the 20 cases.
- **`lib/_audit_status.js` + `api/status.js` — the column, behind `WITNESS_AUDIT_STATE=1`.** Reads `checks/OPERATOR_KEYS.json`, `checks/WITHDRAWN_TOOLS.json` and `checks/<type>/<ns>/*.json` from the public pin repo (one tree read, then up to 100 record reads per render; over budget renders NOT FULLY READ, never a state). With the flag on, every row leads with its audit state and the cadence badge follows it as "cadence: current"; a BLIND-first aggregate panel sits above the table. With the flag off the page is byte-identical to before (tested). An absent `OPERATOR_KEYS.json` makes CHECKED unreachable (every key is read as ours) and the page says so. 9 tests.
- **`tools/check_and_sign.js` — the stranger's tool.** Runs verifier two (`verifier_two/verify.py --json`, stdlib Python written from the spec) or reads its saved output, decides per namespace by verify.py's own `overall` rule over that namespace's results, fetches the newest pin from raw.githubusercontent.com as the record's public input and digest, and signs one record per namespace with a key the stranger mints (`--gen-key`, PKCS#8 PEM). Records are verified before they are written; output paths are create-only. Nothing in it needs a secret of ours; it does not import `api/verify.js` (our code over our store is not an outside look). 8 tests including a CLI end-to-end run.
- **`test/helpers/mock_store.js`**: now answers `GET /repos/<repo>/git/trees/<ref>` (every seeded file as a blob), which the audit reader and the existing observations count both use.
- **`DISAGREEMENTS_audit_state.md`**: twelve interpretive choices, every one resolved toward never upgrading a state without evidence. The two that differ from the build brief: BROKEN is permanent per B3 (not "newer than the last VERIFIED"), and the cadence badge stays but follows the audit state (B7).
- **Not touched, on purpose:** `api/verify.js`, `lib/_stamp.js`, `lib/_status_json.js` (the JSON twin does not yet carry audit states; follow-up).
- **The honest consequence:** with today's repository there is no `checks/` directory, so every namespace is BLIND, and until an outsider runs the tool the ceiling is SELF-CHECKED. Verifier two also rules `velouria-selftest` BROKEN by its own D2, and the repo BROKEN overall for the 2026-08-14/15 test-cleanup deletions; a stranger running the tool today would publish the first as a namespace BROKEN. To switch the flag on: publish verifier two (the BLIND re-run line names it), publish `checks/OPERATOR_KEYS.json` before any self-check record, set `WITNESS_AUDIT_STATE=1`, and Daniel's word on the deploy.

## 2026-09-22 (later) — review follow-up: the rebuild hook judges the whole read, and a verdict can be bound to its record (branch `verdict-required`, NOT deployed)

**Why.** atomic-raven's review of `f12d0ed` (Colony post `42b8d6e0`, comment `062a4dc2-7e5b-4b6b-9458-561daada46b1`) found the rebuild route still folded "gone" and "present but null" into one value, and that a green is not tied to its `what`.

- **The hole, closed.** `lib/_store.js` `putFile` now hands a `rebuild` hook the whole store read (`fresh`: `null` only on a 404, `{json, sha}` for anything present), and the hooks judge that read as-is. A pointer whose JSON is the literal `null` now judges red (`not_a_json_object`) and the pin is refused, never rebuilt over. A `RedVerdictError` thrown from inside the write now reaches the client as the ordinary 503 refusal with its named reason (it was a generic 502 "pin store error"), and the charge is refunded as before. The abandoned-write result also gains `fresh_present`, so `fresh: null` no longer stands for both states.
- **Every site of the shape, checked** (grep `rebuild`, `judgePin(null`, `judgeRead(null`, `=== null ? null`, `{ json:` over `api/`, `lib/`, `tools/`):
  - Fixed: `lib/_store.js` `putFile` (the hook argument); `api/pin.js` `latestPointerRebuild` (judges `freshRead`, reads `freshRead.json.seq`); `lib/_stamp.js` `takeDailyBudgetOnce` rebuild (judges `freshRead`).
  - Correct as they stand: `lib/_stamp.js` stamp create (`rebuild: () => null`, ignores the read); `api/latest.js:85` (raw-CDN fallback builds `null` only for `status === 404`); `lib/_balance.js` grant (`curJson = cur ? cur.json : null` is used only after `balanceOf(cur)` has judged the whole read); every other judge caller passes a reader's return value directly (`getFile` in `_store`, `_balance`, `_meter`, `_keys`, `_pending` returns `null` only on 404). `judgePin(null)` / `judgeRead(null)` appear only in tests, as the deliberate 404 case.
  - `test/store_put_retry.test.js`: its three hooks now read `fresh.json`.
- **A verdict can be bound to its record (rule 6).** `requireVerdict`, `requireGreen`, `isEmpty`, `success`, `refusal` and `counterValue` take an optional `expect` of `{what}`. Given one, a verdict whose `what` differs is refused with `VerdictMismatchError` (`code: "verdict_what_mismatch"`); a malformed `expect` is a `TypeError`. Opt-in, so no existing caller breaks; wired where the record is known: `api/verify.js` (every success and the refusal name the head path, or the historical record's own path, and `witnessedResponse` derives it from `isCurrentHead`), `api/latest.js`, `api/pin.js`'s pointer rebuild, `lib/_status_data.js`. Limit: the binding is as specific as the label the judge was given, and `lib/_stamp.js`'s "stamp record" and the counters' labels are not per-record (the stamp's sha is checked by its own shape rule instead).
- **Tests (+3).** `test/verdict_endpoints.test.js`: "PIN / POINTER DAMAGED MID-WRITE (content = null)" plants `null` in `latest.json` between the read and the write and expects 503, `reason: not_a_json_object`, zero writes to the pointer, pointer bytes unchanged; "STAMP BUDGET / COUNTER NULL MID-WRITE" does the same to the day counter. On `f12d0ed` both fail (the pin answered 201 and overwrote the pointer; the stamp answered 201 and restarted the counter); both pass here. `test/verdict_required.test.js`: "RULE 6 / WHAT BINDING", with positive controls. Must-fail arm, Break C: the mismatch check removed from `requireVerdict`: 1 failure, RULE 6.
- The existing "POINTER DAMAGED MID-WRITE" fixture (a non-pin object) kept passing throughout; it now also answers 503 rather than 502.

Suite 432 → 435, 0 failed.

## 2026-09-22 — judgeRead never returns null, and a green is bound to the read it was judged from (branch `verdict-required`, NOT deployed)

**Why.** atomic-raven, replying on the Colony (post `42b8d6e0`), named two holes in the verdict layer. First: `judgeRead` returned `null` for a read that was present and an object, meaning "the caller's shape rules decide". Null-as-continue is a disarm: a future raw caller that treats null as green puts back exactly the default the layer forbids, one level down. Second: `success(v, fields)` would take any verdict with `ok: true` and a state, including one the caller built with `verifiedRecord()` and no store read behind it. Our reply (comment `43bed67b`) laid out how damaged reads arrive: a non-200/404 throws in the reader, an unparseable body throws, and valid-but-partial JSON arrives present, where `judgeRead` returned null. Only that third kind reaches the judge. Today's only callers of `judgeRead` were `judgePin` and `judgeCounter`, and both refuse by shape. The reply promised the fix as he described it. This entry is that fix.

- **`present_unchecked` replaces the null.** `judgeRead` has three answers, all of them verdicts. A 404 gives a bound `verified_empty`. Something present that is not a JSON object is red. Something present and an object gives `present_unchecked`, which is `ok: false`, typed and bound. `requireGreen`, `success` and `counterValue` refuse it with the error named `PresentUncheckedError` (`code: "present_unchecked"`), so the log says which mistake was made. The only way from there to a record is a shape rule. `judgeWith(got, what, rule)` is the one door, and `judgePin` and `judgeCounter` now run through it. Their outputs haven't changed: `verifiedRecord` or red, the same reasons as before. A rule that returns neither a reason nor a pass throws.
- **Greens are bound to reads.** Only `judgeRead` issues a `read_id`. Every green carries the `read_id` of the read it was judged from, and this module records every verdict it mints in a private map. `requireVerdict`, and through it `requireGreen`, `success`, `counterValue` and `isEmpty`, refuses a green with `UnboundVerdictError` (`code: "verdict_unbound"`) in three cases: it has no `read_id`, its `read_id` was never issued, or it is not the exact object a judge minted (a spread copy or a literal carrying a real `read_id` both fail). `verifiedRecord` and `verifiedEmpty` are no longer exported. You can't build a green by hand and pass it through `success()`.
- **Callers, all made correct under the new rule** (grep `judgeRead|requireGreen|success(|verifiedRecord|verifiedEmpty|judgePin|judgeCounter` over `lib/` and `api/`):
  - `api/fulfill.js:464`: minted `verifiedRecord("fulfillment record")` after an inline shape check, with nothing tying it to the read. It now runs `judgeWith(cur, …)` over the fulfillment read.
  - `lib/_stamp.js` `judgeStamp` / `sendStamp`: minted `verifiedRecord` over a bare record. It now takes the store read (`found` / `prior` / `theirs`) and goes through `judgeWith`. The one non-read is the freshly written stamp, judged as `{json: record}`, the record whose PUT landed. A null (404) handed here throws, because the 404 is the caller's branch.
  - Unchanged, correct as they stand: `judgePin` callers (`api/latest.js:112`, `api/verify.js:132,245`, `api/pin.js:101,535`, `lib/_status_data.js:115`); `requireGreen` at `api/pin.js:100` and `lib/_status_data.js:120`; `success` at `api/latest.js:130`, `api/verify.js:138,155,177,193,261,285,309` and `lib/_stamp.js` `present()`; `judgeCounter` via `counterValue` in `lib/_balance.js:205`, `lib/_meter.js:166` and `lib/_stamp.js:334`. Every verdict they pass into `success`/`requireGreen` comes straight from a judge, with no copies, so it stays bound.
- **The control arm he asked for** (`test/planted_dead_ledger.test.js`, "ROWS WENT BACKWARDS"). The old monotonic guard was `cur && Number.isInteger(cur.json.rows) && rows < cur.json.rows`. The arm plants a head that is valid JSON with the right namespace, chain and seq but `rows: "12"`, so the guard's precondition is false. It then submits a backward pin (rows 5) and asserts a red refusal: 503, `reason: rows_unreadable`, nothing written, head bytes unchanged. That means the guard refuses rather than skips. Its control is the same backward pin over an undamaged head, which must be the ordinary 409. **Run red on the old code** in two ways. First, with the `api/pin.js` head refusal disabled: 3 failures, this arm included. Second, with `api/pin.js` from `feea800^` (pre-verdict): the arm fails with "a backward pin was ACCEPTED over a head whose rows could not be read: the guard skipped". It is green on this commit.
- **Must-fail arms, each run by mutating the file, running the full suite, and restoring:**
  - Break A, `judgeRead` returns `null` again: 142 failures. Every judge crashes on the null.
  - Break A2, `judgeRead` returns `null` and `judgeWith` is patched to treat null as "go on", so every judge still works and only the null is under test: 2 failures, both PRESENT_UNCHECKED tests (re-run 2026-09-22 on the review follow-up below: still 2 of 435).
  - Break B, the binding check removed from `requireVerdict`, so `success()` accepts an unbound green: 1 failure, UNBOUND GREEN.
- **A test that was passing for the wrong reason, fixed.** Three asserts in `test/verdict_required.test.js` expected a `TypeError` from `success(verifiedRecord("x"), {ok: …})` and `refusal(verifiedRecord("x"))`. Once `verifiedRecord` stopped being exported, those threw "not a function", which is also a TypeError, so they kept passing without testing anything. They now use a real bound green, match the specific message, and carry a positive control.
- **What this does not guarantee.** The binding proves a green came out of a judge over some `got` object that was handed to `judgeRead`. It does not prove that `got` came off the network: a caller can still pass `{json: <anything>}` to a judge, and the shape rules still run on it. `refusal()` of a `present_unchecked` renders the ordinary 503, which fails closed. As shipped at `f12d0ed`, two routes built that `got` by hand, and one of them was a hole (corrected per the review in the entry above):
  - **The rebuild route, a hole, now closed.** `lib/_store.js` handed a `rebuild` hook `fresh ? fresh.json : null`, and `api/pin.js`'s pointer hook turned that `null` back into `judgePin(null)`, a `verified_empty`. So a `latest.json` that was present with the content `null` read as a 404 and was overwritten at seq 0 — the exact "nothing there" / "something there I cannot read" collision this file forbids. `lib/_stamp.js`'s day-budget hook had the same shape (a counter holding `null` restarted the day at 0). This paragraph originally named the pointer rebuild as a *legitimate* `{json: …}` caller; it was not.
  - **The fresh-write exception, still open by design.** `lib/_stamp.js` judges the stamp it just wrote as `{json: record}`: the record whose PUT landed, not a re-read. The green there is bound to a read that never touched the store. It is the one remaining hand-built `got` in `lib/` and `api/`.

Suite 426 → 432, 0 failed.

## 2026-09-21 — a success-shaped answer can no longer be built without a verdict (branch `verdict-required`, NOT deployed)

**The class, not the call site.** On 2026-09-19/20 the receipt proxy's health endpoint (a different repo: `arcaeon-receipt`, commits `b5d98a7` and `757fc18`, with `arcaeon-ledger` `9e3dc66`) was found answering `200 {"ok": true, "rows": 0, "chain": "genesis"}` over a corrupt ledger: the verify step had said no, and a wrapper built a success out of defaults. That call site was patched the same day. This change is about the same shape in THIS codebase: anywhere a stored document that is present-but-unreadable fell through `x && typeof x.y === ... ? x.y : <default>` and came out as a well-formed answer. `VERDICT_SURVEY.md` lists every site, the greps it rests on, and what was left alone.

**Remedy A, forbid the default: `lib/_verdict.js`.** One helper. `requireVerdict(v)` throws `VerdictRequiredError` unless `v` is an object with an explicit boolean `ok` and, when green, a named state. `success(v, fields)` is the constructor of an `ok: true` body on the record-reading endpoints and throws on a missing verdict and on a red one. "Empty / brand new" is its own verdict, `verified_empty`, and the judges mint it in exactly one situation: the store answered 404. Present-but-unreadable is red. The two never share a value again.

**What it found here (25 sites, all listed with file:line in the survey).** The ones that mattered most: `/api/verify` turned a damaged `latest.json` into a CONCLUSIVE `witnessed:false` (the scan started at a defaulted `seq = 0`, walked nothing, and reported reaching the start of history); `/api/pin` skipped its monotonic guard and its re-mint guard over a damaged head, because both are written `cur && Number.isInteger(cur.json.rows) && ...`; the free-tier meter and the daily stamp budget read a damaged counter as 0, which fails OPEN; a credit grant over a damaged balance file replaced it with a fresh one holding only the grant; the status board reported `conflicts_observed: 0` under `ok: true` when the observations tree could not be read; and the badge, the status JSON and a listing each had a fallthrough whose last branch was the good news.

**Remedy B, keep the plant on the producer: `test/planted_dead_ledger.test.js`.** Its own file. Overwrites a healthy namespace's stored head with garbage (bytes that are not JSON, and valid JSON saying `rows:0 chain:genesis`), asks `/api/latest`, `/api/verify` and `/api/pin`, requires non-200, and carries the guard from the receipt repo's fixture word for word: `fixture did not break the ledger; the test proves nothing`. The guard has its own control test, which skips the plant and requires the assertion to refuse.

**Behaviour changes a caller can see.** A damaged head is `503 {ok:false, reason}` on `/api/latest` and `/api/verify` (was 200), and `/api/pin` refuses with 503 before any charge. `/api/verify` can answer `witnessed:null, reason:"history_unreadable"` where it used to answer a conclusive false past a hole or an unreadable record. `/api/status.json` reports `conflicts_observed: null` and `status:"indeterminate"` when the conflict log could not be counted. `/api/latest` no longer falls back to the raw CDN when the commit-fresh copy was REACHED and is not JSON. Honest empties are unchanged and pinned by tests: 404 on `/api/latest`, `witnessed:null no_pin_recorded_for_namespace` on `/api/verify`, first pin lands as seq 1, a key with no balance file reads 0, a month with no usage file starts at 0.

**Before deploying:** the judges assume every stored pin carries `namespace`, `rows`, `chain`, `seq` (true of `api/pin.js` since its first commit), every balance file a numeric `balance`, every usage file an integer `used`, every day counter an integer `count`. That was checked against the CODE that writes them, not against the live repos. A read-only pass over the live pins and usage repos should come first; a legacy document that breaks the assumption would now be a 503 instead of a quiet default.

Suite 383 → 420, 0 failed. No new file under `api/` (still 12).


## 2026-09-20 — two sealers cannot publish the same leaves twice, and a reconciler says so when something does (branch `sealer-safety`, NOT deployed, flag still off)

A second-lineage attack review of the 10 unshipped commits named two gaps as must-close before `WITNESS_BATCH_SHADOW` is ever turned on: nothing stopped two sealers running at once (finding #14), and nothing checked for a committed pin whose leaf is in no batch and no longer pending (finding #16). Both are closed here. Nothing is deployed, the flag is still off, and `api/pin.js` is not touched at all. Suite 265 → 293.

**What the code already guaranteed, checked before anything was designed.** The close is a compare-and-swap on the pending document (`lib/_sealer.js`, `WRITE 1: CLOSE the batch. THIS IS THE BOUNDARY.`) and it has always partitioned the *leaf set* exactly — a pin racing a seal lands in the closing batch or the next one, never both and never neither, asserted from the published record in `test/sealer.test.js`. `resolveSealing` already resolved an unconfirmed prior seal against the *public* repo rather than our own bookkeeping, so a root that published but whose slot-clear failed is never re-sealed. A batch id is consumed and never reused. The publication atom is the single `root.json` write, with `leaves.json` first as an inert orphan and `buildProof` structurally refusing on an unsealed batch. Every read that can refuse happens before any write. None of that needed rebuilding, and the two audit findings that claimed otherwise (#10, sealer idempotency; #8, same-batch conflict ordering) were rejected on reading the code — the review could not see the test suite, and both are already covered.

**The gap that was real.** The close partitions the leaf set; it does not partition the seal *execution*. A closes batch N into the `sealing` slot; B's close 409s, B re-reads, asks the pin repo whether root N is published, legitimately sees "not yet" because A has not written it, carries N's leaves into N+1 and seals them; A then publishes root N over the same leaves. No crash needed, two overlapping invocations are enough. **Reproduced against the pre-change code before writing anything**: two `sealOnce()` calls, the first suspended one write short of `root.json`, published both leaves in batch 1 and the same two again in batch 2.

- **`lib/_claim.js` — the single-sealer claim.** The store is a GitHub repo, so the only mutual-exclusion primitive is the conditional write the contents API already gives us: PUT with no `sha` is create-if-absent (422 if it exists), PUT with a `sha` is update-if-unchanged (409 if it moved). Both are arbitrated by GitHub, so one of two racing writers wins. A seal takes `pending/seal_claim.json` in the private usage repo, naming the holder, an absolute `expires_at`, and the **leaf set it is sealing** — batch id, leaf count, and a digest over each leaf's `(namespace, rows, chain, seq)`. A conflict on the claim write is **re-read, never guessed**: `lib/_store.js` measured 465 409s out of 532 writes that raced nothing, so a claim that read a 409 as "somebody beat me" would refuse to seal most of the time for no reason.
- **Expiry, so a crashed sealer costs two intervals and not a morning.** 120-second lease by default (two batch intervals), `--claim-ttl` to change it. An expired or released claim is takeable, and the takeover is itself a conditional write, so two takers still produce one winner. A claim whose `expires_at` cannot be parsed counts as **live** on purpose: a corrupt claim wedges the sealer, which is harmless because the leaves wait in the pending document, while two sealers are not harmless. Clearing it is deleting one file and the design says so.
- **The lease runs on wall time, deliberately not on the batch clock.** `tools/seal_batch.js --now` moves the replay clock; a lease that moved with it would measure nothing about how long the run has actually been alive. `sealOnce` takes `claimClock` as a *function*, because a lease checked against the reading it was acquired with can never notice it expired.
- **`lib/_batch.js` gained one optional gate, `opts.beforeRoot`**, called between `leaves.json` and `root.json` — the last instant at which aborting costs nothing but an inert orphan leaf list. The sealer re-checks the claim there, so a slow run whose lease expired mid-work stands down one write short of publishing a root over leaves another sealer may already have published. Default is no gate; every existing caller is unchanged.
- **An idle run still writes nothing.** The claim is taken *after* the trigger decision and after the chain read, so a scheduler polling every 60 seconds costs zero writes when there is nothing to do, and the fail-closed rule that every refusing read happens before any write is intact.
- **Stated as a lease, not a lock.** Between the pre-root check and the root PUT landing at GitHub there is a window, and a sealer stalling inside it past expiry while another takes over can still double-publish. The TTL makes that window far smaller than a run; nothing claims it is zero. The property that holds without qualification is that **a violation would show** — which is what the next item is for.

- **`tools/reconcile_batches.js` — the instrument behind "run it until a full week reconciles clean."** Read-only, bounded, four findings: `lost` (committed pin, no leaf in any batch, not pending), `duplicated` (one leaf identity in two batches), `root_mismatch` (published leaves do not hash to the published root), `proof_failed` (a proof rebuilt from the published document does not verify — built from the *declared* `tree_size` and `leaf_hashes`, because that is the data a stranger holds, so an internally inconsistent document fails even when its leaf array alone hashes fine). A test asserts zero writes on every path. Run against the real damage the pre-change code produced, it reported both duplicated leaves by name with zero writes.
- **Three verdicts, not two.** `CLEAN` 0, `FINDINGS` 1, `INCOMPLETE` 2. `INCOMPLETE` fires on a truncated GitHub tree, any unreadable file, an unreadable pending document, or either bound being hit — because the one way this tool can lie is by being read as a clean bill when it simply did not look. Findings win over incompleteness: an unread file does not make a real finding less real.
- **`lib/_store.js getTreeMeta`** exists only for that: `getTree` drops GitHub's `truncated` flag, which is fine for a status page counting files and fatal for a reconciler deciding whether a leaf appears nowhere.
- **A `lost` finding is reported, not filtered, even though it has a legitimate cause.** §6.1's `pending_head_regression` refuses a leaf while the pin stays publicly committed — the tolerated Phase 1 gap this phase exists to *measure*. "Expected sometimes" is not "nobody should look."
- **Bounds:** `--max-batches` 512, `--max-pins` 5000, and past either the tool stops, says how many it did not look at, and goes `INCOMPLETE`. Scope starts at the earliest batch `opened_at` or `--since`; pins older than that are `out_of_scope` and never called lost.

- **`lib/_pending.js`** now exposes `readUsageDoc` / `writeUsageDoc` over a path, with `readPending` / `writePending` as unchanged wrappers, so the claim runs on the same one CAS primitive rather than a second copy of the fetch pair that can drift from it.
- **Tests: `test/sealer_concurrency.test.js`, 28 of them.** Each of the four scenarios the review asked for has an arm that fails against the pre-change code: two sealers in the same second; a crash after claiming and before the close; a crash after the root write and before clearing pending; a slow sealer whose lease expires mid-run (detects before the root write, aborts, leaves held, next run seals them under a new id). Plus: an old pre-batching receipt verifies byte-identically after a claimed seal *and* a reconciliation, and with the flag off `api/pin.js` writes the same two files with the same content field-for-field, reads neither the claim nor the pending document, and the only usage-repo write is the meter's, exactly as before.
- **Design doc:** new §12 (concurrency, with the guarantees and the non-guarantees both spelled out), §13 (reconciliation), and **§14, the "before turning the flag on" checklist** — which also names what is still *not* built: worst-case pin latency with the flag on is unmeasured (audit #7), the accumulation path has no leaf-count ceiling of its own (#11), `readPrevRoot`'s 64-id lookback has no auto-recovery (#9), and `POST /api/verify?op=bulk` in the same unshipped range still has no rate limit at all (#1, CRITICAL, not batching work and not fixed here).




## 2026-09-20 — brand stems reserved at claim time (branch `reserve-brand-stems`, NOT deployed, touches the paid claim path)

Second-model review, 2026-09-20: `lib/_status_data.js`'s `isReferenceNamespace()`
tags any `velouria-`/`arcaeon-` namespace as "our own log" on the **public**
status page, but `lib/_keys.js`'s `validatePrefix()` only ever reserved the
`wk-` stem. A paying customer could pick a namespace prefix like
`velouria-something` or `arcaeon-x` at checkout and get two bad outcomes at
once: mislabelled as the operator on the public status page, and sitting on
the operator's own brand namespace outright — the exact class of harm the
existing `wk-` reservation exists to prevent, just left open for the two
stems that actually matter for brand.

- **Reserved at claim time, same shape as `wk-`.** `lib/_keys.js` gets
  `RESERVED_BRAND_STEMS = ["velouria", "arcaeon"]`. `validatePrefix()` refuses
  a customer-chosen prefix that starts with (or is exactly) `velouria-` or
  `arcaeon-` with `{ok:false, reason:"reserved", detail:"the <stem>- stem is
  reserved for the operator's own namespaces"}` — the identical shape the
  `wk-` refusal already used. A stem merely *appearing* inside a longer,
  differently-rooted prefix (`acme-velouria-mirror-`, `myarcaeon-x-`) is
  untouched and still claimable.
- **One source of truth, not two lists that happened to agree.**
  `lib/_status_data.js`'s `REFERENCE_PREFIXES` is now *derived* from
  `keys.RESERVED_BRAND_STEMS` (`.map(stem => \`${stem}-\`)`) instead of
  carrying its own literal default. `api/fulfill.js`'s claim path and
  `GET /api/prefix-available` both already routed through the same
  `keys.validatePrefix()` (fulfill.js directly; `lib/_prefix_check.js`'s
  `decide()` calls it too) — that plumbing was already correct and needed no
  change, only the reservation itself was missing.
- **`WITNESS_REFERENCE_NS_PREFIXES` env override REMOVED, not kept.** It let
  an operator tag an *unreserved* stem as "ours" on the status page without
  also reserving it at claim time — precisely the drift that produced this
  bug in the first place, since the default value happened to match
  `validatePrefix`'s hardcoded `wk-`-style reservations by coincidence, not
  by construction. Awkward to reconcile with "single source of truth" any
  other way (an env var cannot safely widen a security-relevant reservation
  at runtime), so it is gone; `REFERENCE_EXACT` / `WITNESS_REFERENCE_NS_EXACT`
  (unrelated — exact operator log names with no brand stem, e.g.
  `test-freeplan-smoke`) is untouched.
- **Grandfathered.** The reservation gates *new* customer claims only.
  `keys.issuedKeyPrefix()` (the live `/api/pin` auth lookup) and
  `keys.listPrefixes()` both read stored records as-is and never re-run
  `validatePrefix` against history, so a key already issued on a brand-stem
  prefix — before this fix, or hand-provisioned for the operator's own use
  via `WITNESS_KEYS`, which never touches `validatePrefix` at all — keeps
  authorizing pins unchanged. Test: `test/reserve_brand_stems.test.js` and
  `test/fulfill.test.js` each seed a pre-existing `velouria-legacy-` key
  record and confirm it still authorizes while the identical string is
  refused as a fresh claim.
- Tests: new `test/reserve_brand_stems.test.js` (17 tests: refusal shape,
  case normalization, lookalikes stay allowed, the two-list single-source
  check in both directions, grandfathering). Additions to
  `test/prefix_available.test.js` (7) and `test/fulfill.test.js` (4, covering
  the JSON claim path, the HTML form POST, a lookalike mint, and
  grandfathering end-to-end). Suite 265 -> 293, all passing.
## 2026-09-20 — bulk verify is now rate limited, weighted by items.length (branch `bulk-ratelimit`, NOT deployed)

Audit finding (`WITNESS_UNSHIPPED_COMMITS_AUDIT_2026-09-20.md`, Unit B):
`api/verify.js`'s `module.exports` dispatched `?op=bulk` to `handleBulk`
*before* the single-item path's `ratelimit.check(req)` call, and
`handleBulk` never called the rate limiter at all. One unauthenticated
POST could carry up to `MAX_BULK_ITEMS` (20) items, each costing up to
`MAX_HISTORY_SCAN` (50) history-scan reads plus 1 for `latest.json` — up
to 1020 GitHub API reads from one HTTP request, against the same token
`/api/pin`'s paid writes depend on, with zero rate limiting. This existed
because bulk mode (K-018, `34c0655`) was added after the per-IP limiter
(`14308a0`) and the bulk dispatch was wired in front of, not through, it.

**Why.** GitHub's contents API budget is shared across the whole service,
not metered per endpoint (`test/free_endpoints_ratelimit.test.js`'s own
header explains this same class of bug on four other endpoints, fixed
2026-09-05). Bulk mode reopened it on a fifth surface at up to 34x the
per-call cost of a single unauthenticated GET.

**What.** `lib/_ratelimit.js`'s `check(req)` gained an optional `cost`
parameter (default 1 — every existing caller is unaffected). `handleBulk`
now calls `ratelimit.check(req, items.length)` against the SAME per-IP
bucket the single-item GET/HEAD path uses, after the cheap shape/cap
validation (which touches no store and stays free to refuse garbage) and
before any store read. Chosen over a second, bulk-only bucket: it needed
no new machinery beyond the `cost` parameter, and it's genuinely one
shared resource (one GitHub token) being protected either way — two
buckets would let single and bulk traffic each separately max it out.
Design decision, tested: a malformed/over-cap batch spends zero rate-limit
units (it never reaches the check), because it already costs zero store
reads and charging it would let cheap junk grief a legitimate caller's
shared budget for free.

**Corrected in the same pass:** `BULK_VERIFY_DESIGN.md`'s "Rate limiting"
section previously claimed the limiter "still applies to the bulk request
as one call" — false; and its worst-case arithmetic ("20 × 50 = 1,000")
undercounted by one read per item (the `latest.json` read the history scan
is entered from). Measured worst case, directly against the mock store's
own read log: **1020**, not 1000. The caps themselves (20 items,
50-record scan) are unchanged; only the arithmetic describing them was
wrong, and it was wrong low.

`test/verify_bulk_ratelimit.test.js`, 6 tests: the crossing-the-limit case
makes zero store reads; a different IP is unaffected; single verifies plus
one bulk call share one budget and cross it exactly at the summed weight;
the 1020-read worst case is measured, not asserted against a
self-reported number; malformed/over-cap batches cost zero units by
design; a must-fail arm re-creates the pre-fix dispatch (bulk's path never
calling `ratelimit.check()` anywhere) and proves the weighted-limit
assertion fails against it. Existing single-item rate-limit and CORS
behavior unchanged (`test/verify_read_surface.test.js`, untouched, still
green). `npm test`: 265 → 271, all green.

## 2026-09-20 — stamps get their own record, their own token, and a price (branch `stamp-own-repo`, NOT deployed)

Owner direction (Daniel, 2026-09-20): Arcaeon stamps get their **own public record repository** and their **own write token**, are sold beside the witness **on the same prepaid credit pool** as a micro-transaction, **3 free a day**, and "if free can get exploited just make it paid." All four, built. Nothing pushed, nothing deployed, and the stamps repository still does not exist — creating it is the owner's step, by hand (`STAMPS_OWN_REPO.md`).

- **`lib/_stamp_store.js` — a separate store that cannot fall back.** Stamps read and write `STAMP_REPO` / `STAMP_BRANCH` / `STAMP_TOKEN`. It never reads `GITHUB_PIN_REPO` and never reads `GITHUB_PIN_TOKEN`. Missing config is **503 with nothing written and nothing even read** — not a quiet write into the witness record. And because one env typo must not be what merges the two records, a `STAMP_REPO` set *by hand* to the pins repo is **refused** (`stamp_repo_is_pins_repo`). Why it matters: a stamp is a public, near-unauthenticated write, so the token behind it is the most exposed credential here; scoped to one repository, the worst day for stamps cannot touch a single pinned head.
- **The GitHub primitives are reused, not copied.** `lib/_store.js` grew an optional `target` argument (repo, branch, token *env name*, user-agent) and a `forTarget()` binder. Every existing caller is byte-for-byte unaffected — the suite proved that before a single stamp change landed. The reason for the refactor rather than a second store module: `putFile`'s 409 retry was **measured** live (465 conflicts in 532 requests, `tools/ceiling_probe.js`), and a second hand-copy of that loop is a second implementation with nothing keeping the two in step.
- **Metering: free, then paid, on the one pool.** A repeat of an already-stamped fingerprint is free forever and **never debits**. The first `STAMP_FREE_PER_DAY` stamps (default 3) per client address per UTC day are free. Past that a stamp needs a valid witness key and debits **the same prepaid balance the pins spend**. `STAMP_FREE_PER_DAY=0` makes every stamp paid — the owner's escape hatch, an env lever because it is an operational decision, not a price. The existing global daily cap still sits under all of it and still fails closed, and it applies to paid stamps too: a paid stamp is never silently dropped, it is refused before any charge.
- **The price, with its math — and it is NOT ratified.** One constant, `STAMP_PRICE_CREDITS = 0.25` in `lib/_stamp.js`, deliberately not an env var (a price that moves by editing a dashboard field is not a promise). Against `lib/_balance.js`'s real pack prices — entry packs `mini` $5/1,000 and `starter` $15/3,000 = **$0.005 per credit**, `standard` $50/12,000 = $0.0041667, `bulk` $150/40,000 = $0.00375 — a quarter-credit stamp costs **$0.00125 at the entry rate (800 stamps per dollar)**, $0.00104 at standard (960/dollar), **$0.00094 at bulk (1,067 stamps per dollar)**. The argument for a quarter: a stamp is one commit carrying a hash, while a pin carries a cadence contract, a deadline, an interval history, a monotonic guard and a verification surface, so charging the same prices the cheap thing off the table; below a tenth the GitHub write behind it is worth more than the money at the cheapest pack. That is an argument, not a decision — **pricing authority for this lane is the owner's partner's, and this goes to him with the math above.**
- **`lib/_balance.js` debits an amount, not a 1.** New `debitCredits(secret, amount, reason)`; `decrementCredit` is now a thin alias for `debitCredits(secret, 1, reason)`, so there is one CAS loop, not two. Balances round to 6 decimal places on write, because 0.25 taken four times must be exactly one credit and not 0.9999999999999998 — there is a test that says so. The `applied_events` idempotency set carries through a stamp debit, same as it must through a pin's (the 2026-08-16 double-grant bug, in a new lane, with its own assertion).
- **Money never moves for a stamp that did not land.** The balance is *checked* before the write (a read — an insufficient balance is **402** with an honest body, the current balance, the price, `ever_purchased` and the packs, and nothing is written) and *debited* after the write is confirmed. A failed write, a lost create race, a refused daily cap and a repeat stamp each charge nothing. Every one of those is a test with a must-fail arm; moving the debit above the write turns **seven** of them red, which is how we know they are load-bearing and not decoration.
- **`tools/stamp_genesis.js` — the witnessed birth, dry-run by default.** A brand-new repository is exactly as old as its first commit, and that commit's date is whatever its creator's machine says. This writes ONE record into the **existing pins repo** naming the stamps log's first commit SHA and date, as its own commit, timestamped by GitHub in a history with months of public life behind it — the old log dates the new one. Create-only: an existing genesis record is never replaced, because a birth record that can be overwritten is worth nothing. It **refuses** to write the record into the stamps repo itself (a log cannot witness its own birth), it **never creates a GitHub repository**, and it has not been run for real. A tool and not a 13th API function: `api/` is at the Vercel Hobby 12-function cap, and this runs once in the life of the log.
- **The claim stayed scoped.** The genesis record says a later change "would show" in the public commit history. It does not say impossible, does not say tamper-proof, claims no independence or multiple witnesses, and implies no adoption — and there is a test that fails on any of those words appearing in the record.
- **Privacy guarantees unchanged and re-proved on the new store:** fingerprint and optional size only, extra fields refused with a 400 rather than dropped, and a new assertion that neither the raw key nor its billing hash can appear anywhere in the public record now that a key can pay for a stamp.
- Tests: **270 → 297** (27 new, all 12 pre-existing stamp tests repointed to the stamps repo and green). Full suite `297/297`, 0 fail.
- **Not done:** the stamps repo does not exist, nothing is pushed, nothing is deployed, the genesis tool has not been run, and the price is a placeholder awaiting the owner's partner. No chain across stamps yet (the Merkle batch sealer is still the intended path) and no receipt page.

## 2026-09-19 — /api/stamp: fingerprint-only file stamps (branch `stamp-endpoint`, NOT deployed)

Daniel's ask: a person should not have to write code to get a tamper-evident receipt. `POST /api/stamp {sha256, size?}` records one public commit per fingerprint under `stamps/<2 hex>/<sha256>.json`; `GET /api/stamp?sha256=` looks one up. The browser hashes the file, so the file never leaves the person's machine.

- **First write wins, forever.** A repeat stamp returns the original record and writes nothing; a lost create race returns the winner's. There is no update path. "No later than" is only true if the earliest record cannot be replaced.
- **No filename, no label.** Extra fields are refused with a 400, not dropped: the store is public and a filename is content.
- **Every response carries `scope.does_not_prove`**, including the 404. A thing called a stamp gets read as an endorsement.
- **Two abuse fences from day one, both fail closed:** 10 stamps per IP per 10 minutes, and a global daily cap (`STAMP_DAILY_CAP`, default 500) kept in the store so it holds across instances. If the counter cannot be written, no stamp is recorded.
- **Routing:** this deployment is at the Vercel Hobby 12-function cap, so the handler lives in `lib/_stamp.js` and is dispatched from `api/verify.js` on `?op=stamp` via a `vercel.json` rewrite. The dispatch says in a comment that a write is riding on a read endpoint.
- A store outage on lookup is a 503 "this is not a no", never a 404.
- Tests: 12 new, suite 270/270.
- **Not done:** no chain across stamps yet (the existing Merkle batch sealer is the intended path), no receipt page, no deploy. Pushing this branch would create a preview that writes to the REAL public pins repo, so that waits for his go.
## 2026-09-19 — the status page reports the service (deployed 2026-09-20 on top of live commit 14308a0; later commits on main NOT included)

The page opened with "Independence disclosure: k=1. Every namespace below traces to one operator root... We measured, the answer is one", plus a `k=1` stat tile, and `status.json` carried "all namespaces trace to one operator root". That wording came out of a forum reviewer's critique and was right for the forum. On a product surface it read as an announcement that nobody else uses the service. Owner's call, 2026-09-19: a status page says what the service is doing; it does not editorialise about adoption.

- **Kept, because a relying party needs it:** single-operator witness; every pin is a public, third-party-timestamped commit; every number links to its raw source; nothing has to be taken on trust. `independence` in the JSON now states `witness_operators: 1` and `verifiable_without_trusting_us: true`.
- **Removed:** the paragraph, the `k=1` tile, and the usage sentence in the JSON.
- **Added, so the removal does not overclaim in the other direction:** the operator's own namespaces are tagged `reference` (HTML badge, `reference: true` in JSON), decided by prefix (`WITNESS_REFERENCE_NS_PREFIXES`, default `velouria-,arcaeon-,test-,demo-`). A bare namespace count would otherwise read as a customer count. A customer's namespace is simply untagged.
- Test fixture: the mock GitHub store now lists immediate subdirectories (`type: "dir"`), as the real contents API does; without it nothing that walks `pins/<namespace>/` could be tested. `test/status_posture.test.js`, 5 tests; suite 258 -> 263.

## 2026-09-13 — Merkle batching, the caller: the sealer exists, and the batch does not seal early

`6c0bb93` left one sentence in `MERKLE_BATCHING_DESIGN.md`: *"Until the sealer exists,
nothing calls `sealBatch` in production. The library is complete and the caller is not."*
This is the caller. Suite 236 → 258.

- **`lib/_pending.js` — the state a serverless function cannot hold.** §11 Q3's premise is
  that "a serverless request cannot reliably close a batch it did not open," and the reason
  is that nothing in `_batch.js` or `_merkle.js` survives an invocation. One JSON document
  under CAS in the private usage repo holds the open batch's leaves in acceptance order and
  §6.1's pending head per namespace. **A read that fails throws; a 404 returns null** —
  "I cannot see it" and "there is nothing there" stay different answers, which is the whole
  fail-closed hinge.
- **The trigger is `lib/_batch.js`'s, quoted and called, not restated.** §3.4: *"Seal when
  any of these fires, whichever comes first: 1. `batch_interval_seconds` elapsed since the
  batch opened (default proposal: 60s). 2. `max_leaves` reached... 3. A deadline forces it
  — any pending leaf whose `next_pin_due_by` is within `seal_safety_margin` of expiring."*
  `lib/_sealer.js` asks `sealTrigger` and does **nothing, not one write anywhere**, when the
  answer is null. One addition, a carry and not a cadence: leaves left behind by a seal that
  already failed seal on the next run regardless of the interval (§10 T4).
- **Fail closed, and it is the sealer that refuses.** A sealer that cannot read the pending
  head returns `pending_head_unreadable`, writes nothing — no root, not even an orphan leaf
  list — and never seals a batch it cannot prove complete. Every read that can refuse (the
  pending head, the chain tip, the leaf shapes) happens **before any write**. Sabotaged both
  ways before shipping: collapsing the unreadable case into `no_open_batch` turns both
  fail-closed tests red; making the trigger always fire turns "does not seal before the
  interval" and "a deadline forces it" red.
- **The close is the boundary, and it is before the seal, never after.** A leaf appended
  after a root is computed would claim membership in a tree it is not in. Closing first
  freezes the leaf set; the close and `api/pin.js`'s append contend for the same document
  sha, so a pin racing a seal either wins (its leaf is inside the sealed batch — the close
  409s, re-reads, and absorbs it) or loses (its append 409s, re-reads, and lands in the next
  batch). Both directions are tested from the *published* leaf list, not from the sealer's
  own report.
- **A published root is never re-sealed.** The hazard: a root that commits and then fails to
  clear its bookkeeping slot looks exactly like a seal that failed, and re-sealing would put
  the same leaves under a second root. The sealer asks the **pin repo** whether a root exists
  at that batch id rather than trusting its own note-to-self — a question about our memory
  turned into a question about the published record.
- **§6.3 is finally a backstop.** §6.1's pending head refuses a same-rows/different-chain
  leaf into the tree at accept time. The seal-time re-check stays, and is not redundant: the
  contents API gives no read-your-writes across instances, so a stale cross-instance read can
  still admit a conflicting leaf, and a test seats exactly that shape and proves the later
  leaf is still dropped and the observation still written.
- **`api/pin.js` gains nine lines that cannot fail a pin.** The accumulation hook runs after
  the record is committed, on both the advance and the heartbeat path (§11 Q4, decided:
  heartbeats stay in the tree), and swallows every error to a loud log. §9 Phase 1 is "Keep
  per-pin commits exactly as they are" — a shadow-run bookkeeping failure must not turn a
  committed pin into a 502 after the fact. The dropped leaf is exactly what Phase 1's week of
  reconciliation exists to catch.
- **`tools/seal_batch.js` — §11 Q3 decided: an operator command, not a 13th function.** `api/`
  is at the Vercel Hobby 12-function cap (`9e8b060`); opportunistic sealing is refused by the
  design's own parenthesis ("starves a quiet witness"); a seal mode on a public endpoint would
  need a new operator-auth surface built before the first seal, and a command needs none —
  running it already requires the token the seal spends. Exit 1 means **refused, nothing
  written**, so a scheduler can alert on fail-closed specifically.
- **Phase 1 is off until someone starts it.** Accumulation requires `WITNESS_BATCH_SHADOW`.
  §9 Phase 1 is "Run it until a full week reconciles clean" — an operator act with a start
  date and a week of watching, not a state that arrives with the next unrelated deploy. The
  start procedure and the reconciliation check are written into §9.
- **The one that matters, re-proved against the caller.** With the accumulator live on every
  pin and a root committed by the sealer, an old-style pin verifies through the real
  `api/verify` handler with a byte-identical body — and the claim "by exactly the path it does
  today" is checked against the mock store's own **read log**: the verifier read
  `pins/<ns>/latest.json` and nothing under `batches/`. A frozen hand-written pre-batching
  record still verifies `witnessed:true` the same way.
- **Two corrections written into the design.** §6.1 called the meter/balance store "a durable
  non-GitHub store"; it is a private GitHub repo (`lib/_meter.js:22-24`, `lib/_balance.js:64`),
  so §11 Q2's read-your-writes requirement is **not** satisfied and the honest statement is
  first-guard-plus-backstop. And §6.1's pin-refusing 502 is deliberately **not** built: its
  premise is "if `latest.json` is only written at seal time," which is Phase 4, not Phase 1 —
  adding a 502 class to a live money path for a window that is not yet open would be paying a
  real availability cost for a hypothetical one.

## 2026-09-13 — Merkle batching, the mechanism: N pins, one tree, one root, a proof each (`6c0bb93`)

`MERKLE_BATCHING_DESIGN.md` §3 and §5 implemented, plus §6.3. Its own statement of the
contract, §1: *"Group every pin accepted in an interval into one Merkle tree and commit
only the root. Write cost becomes O(1) per interval — a fixed small number of commits
regardless of whether the interval held 1 pin or 10,000."* Suite 204 → 236.

- **`lib/_merkle.js` — the tree, and nothing else.** No store, no clock, no network,
  because §8 requires `verify_inclusion` to be "pure and dependency-free. If proving
  inclusion requires calling us, the proof is not a proof," and a require list is how a
  stranger checks that. Leaf = `SHA256(0x00 || json_c14n_v1(leaf_object))` over §3.1's
  nine fields; node = `SHA256(0x01 || left || right)`; **odd node PROMOTED, not
  duplicated** (§3.2 — the Bitcoin shape makes distinct trees collide, CVE-2012-2459
  lineage, and a test asserts the two roots differ); leaf order is acceptance order and is
  part of the commitment.
- **The canonicalizer was already here.** §3.1 forbids a second one. `lib/_distill_core.js`
  already carries the JS side of `json-c14n:v1` (`jdump(value, true)`), so `_merkle.js`
  calls it. Residual, documented at the call site rather than discovered later: JS cannot
  tell `24.0` from `24`, so an integral `cadence_hours` canonicalizes as `"24"`.
- **`verifyInclusion` is §5's published algorithm verbatim**, including the derived path
  direction — no left/right flags, because "a verifier that trusts the flags over the index
  is exploitable." It returns a **typed reason, not a boolean**: §5 requires inclusion and
  publication to stay "two separate claims, never merged into one boolean," and an unknown
  recipe label returns `unknown_recipe` rather than passing with a warning.
- **`lib/_batch.js` — two writes per batch, whatever the leaf count.** `leaves.json` then
  `root.json`. **The failure atom is the single `root.json` write**, and it is enforced
  structurally, not described: `buildProof` throws on an unsealed batch, so no pin can be
  handed a proof citing a root that was never published. A failed seal leaves no root, no
  proof, an unmoved chain tip, and a leaf set handed back for the next batch to absorb
  (§10 T4, which is honest that correlated failure is a real cost of batching).
- **`prev_root` is the equivocation fence and it costs no extra write.** The chain tip is
  read off the previous published `root.json`, which already carries its own root — no
  pointer file, so no third write per batch and nothing that can rewind.
- **§6.3's seal-time conflict re-check drops the LATER leaf** — `api/pin.js:183-184`'s rule
  is that a conflict "never advances accepted state" — and writes its observation
  immediately and unbatched, per §6.2: "the one write in this system with a live adversary
  attached."
- **The 409 retry from `aaa1378` governs every write here and is not reimplemented.** Every
  write is a `store.putFile`; a test greps `lib/_batch.js` for `fetch(`, for
  `maxAttempts|PUT_RETRY|putOnce`, and counts the `store.putFile` call sites, so the absence
  claim names its searches instead of asserting itself.
- **Nothing about publication changed, and that is the point.** `api/pin.js`,
  `api/latest.js` and `api/verify.js` are untouched — §9 Phase 1, "Keep per-pin commits
  exactly as they are." Two tests hold the line the hard way: one runs the real pin handler,
  snapshots the real `api/verify` response, seals that pin into a batch, and asserts the
  response is unchanged; the other verifies a frozen hand-written pre-batching record with a
  batch root sitting in the same repo.
- **MEASURED, not estimated.** Counted from the fixture's own `putLog`, not a number the
  code reports about itself: 10 pins through `api/pin.js` cost **20** pin-repo writes
  (**2.0 per pin**); one sealed batch of 10 leaves costs **2** (**0.2 per pin**); 1 leaf and
  100 leaves both cost 2.
- **Found while building.** A seal that dies before its root write **retires** its batch id
  — the orphan `leaves.json` is still there and §9 promises nothing is ever rewritten — so
  id gaps are normal and `batch_id > 1` stopped being the same question as "something came
  before me." `readPrevRoot` now walks back over the gaps and refuses to *claim* a chain
  start it did not establish: an exhausted lookback is a typed `chain_break`, not a null.
- **Deliberately not built, listed in the design's status block rather than left to be
  discovered:** the pending-head store (§6.1), `inclusion_due_by` / `inclusion_state` / the
  `cannot_determine` pending grade (§4), the `/status` self-grading counters (§7), the
  `GET /api/proof` endpoint (§5 — `api/` is at the Vercel Hobby 12-function cap, confirmed
  at `9e8b060`, so it needs an `?op=` mode, not a 13th file), the client verifier (§8,
  another repo), and the scheduled sealer (§11 Q3). Until the sealer exists nothing calls
  `sealBatch` in production: the library is complete and the caller is not.

## 2026-09-13 — `putFile` retries the 409 that was losing concurrent pins (task 093)

The ceiling probe measured the defect on its way to measuring something else: ten
concurrent writers on one branch issued 532 requests and took **465 409s**. Every one of
those writers was creating its own distinct file, so nothing raced for a path — the
**branch ref** moved under each PUT. `lib/_store.js:putFile` did not retry, so a pin that
raced another pin simply failed. Production pins run on serverless instances that
overlap, so this was live, not a lab curiosity. This is not the batching design; it is
the correctness floor under it.

- **`putFile` now retries a 409**, and only a 409 — the 422 create-race keeps its
  existing one-shot `err.conflict` contract, and a 5xx is still a plain failure. Four
  attempts, ~1 s base, doubling, jittered 0.5x–1.5x. The backoff is ours to invent
  because the probe found the secondary limit carries **no `Retry-After`** and refills in
  ~16 s, so there is no server hint to honour.
- **It re-reads before it re-writes, and the two 409s are not the same event.** If the
  path is *unchanged* since the caller read it, the 409 was branch-ref contention and the
  caller's object is re-PUT verbatim — nothing was overwritten because nothing moved.
  If the path *moved*, another writer owns it now, and a blind re-PUT would erase that
  writer's row, so it is never done: the caller's optional `rebuild` hook is handed the
  fresh json and decides, and with no hook the call fails typed (`err.stale`, with
  `err.conflict` still true so every pre-existing caller behaves exactly as before).
- **The result carries `attempts`.** A pin that took three tries says so instead of
  reporting a clean single write; `POST /api/pin` surfaces it as `write_attempts`. A
  budget that runs out throws — there is no fabricated success anywhere on this path.
- **`api/pin.js` supplies the one rebuild that is actually needed**, for `latest.json`.
  The merge rule is short because `latest.json` is a *pointer*, not a row: the rows are
  the numbered seq records, which are created and never rewritten, so racing here can
  never overwrite another pin's row. What it could do is rewind the pointer over a newer
  record, and that is forbidden — a witness never goes backward. So a fresh `latest` at a
  seq >= ours abandons the write (`latest_pointer_advanced:false`); only a
  strictly-behind pointer is advanced. Our record stays recorded at its own numbered path
  either way.
- **Tests** (`test/store_put_retry.test.js`, 9 new): 409-twice-then-201 lands on attempt 3
  with the *fresh* sha on the wire (bound to a sha the fixture authored, not one the code
  reported about itself); 409 five times gives up with a plain typed error and an
  untouched file; and — the one that matters — after a genuine race the merged content
  contains **both** writers' rows, with a paired no-rebuild case proving the racer's row
  survives rather than being clobbered. Sabotage check: replacing the retry branch with an
  unconditional `break` turns 6 of the 9 red (`attempts: 1`, `Error: github PUT
  race/t1.json -> 409`); restoring turns them green.
- `test/pin.test.js`'s wedge-refund regression had its forced-conflict budget raised
  10 → 40. `putFile` now spends up to four PUTs per call, so four passes issue up to 16,
  and a budget of 10 would have let the 11th **succeed** — turning that regression green
  for the wrong reason. The test's intent is unchanged.

Suite: **195 → 204**, all green.

## 2026-09-13 — the GitHub write ceiling, measured (task 083, open question 1 closed)

`MERKLE_BATCHING_DESIGN.md` §1 had said "we have not measured GitHub's secondary rate
limits for sustained contents-API writes to one branch" since August, and §11 carried it
as open question 1. It blocked any customer-facing throughput claim by its own standing
rule. Measured now; §1 and §11 rewritten with the numbers and the date.

- **New `tools/ceiling_probe.js`** — sustained contents-API PUTs until GitHub refuses.
  **Scratch-repo only**: it refuses to run unless the target repo name contains "probe",
  and refuses outright if the target is the live pin repo. The reason is not squeamishness
  about junk commits (though the pin log's whole value is that its history is meaningful)
  — GitHub enforces secondary limits **per authenticated identity, not per repository**,
  so tripping the limit on any repo puts the *serving* token into cooldown. The scratch
  repo avoids the junk history; only running in a quiet window avoids the cooldown. The
  token is read from `GITHUB_PIN_TOKEN` (the same var `lib/_store.js` reads) and every
  string leaving the process goes through a redactor.
- **Numbers** (personal User account, plan `free`, classic PAT, 2026-09-13): 577
  sequential writes accepted in 360 s (96/min) with **zero** refusals — the sequential run
  never found a ceiling, it hit the probe's own time cap. A 4 KB payload gave 279 in 180 s
  (93/min), median latency 626 ms vs 603 ms at 64 bytes: **payload size does not move it**,
  a single writer is latency-bound at ~95/min.
- **What actually trips it is concurrency, and the recovery is fast.** Ten concurrent
  writers took a 429 ("You have exceeded a secondary rate limit", **no `Retry-After`**)
  after 65 accepted writes in 49 s, and recovered in **~16 s**. So it is a burst allowance
  that refills in seconds, not an hourly ban.
- **The finding with teeth, which a sequential-only probe would have missed:** the limiter
  counts *requests*, not accepted writes, and **branch contention bites before the rate
  limit does**. Of that burst's 532 requests, 465 were **409s** — ten writers committing to
  one branch move the ref under each other and `lib/_store.js:putFile` has no retry. Ten-way
  concurrency moved *less* (80/min accepted) than one sequential writer (96/min) for eight
  times the request budget. Adding write concurrency to a single branch is not a throughput
  lever; removing writes is, which is the batching case.
- **Two scratch repos created and deleted** (`arcaeon-ceiling-probe-2026-09-13`, `…-13b`),
  each `DELETE -> 204` with a confirming `GET -> 404`. The live pin repo was never written
  to. The primary hourly limit was never approached (5,000/hr; never below 3,600 remaining).
- Standing rule kept, not weakened: **no customer-facing pins-per-hour figure without a
  dated measurement.** ~47 pins/min (two writes per pin) is an internal planning figure.

## 2026-09-12 — bulk verify: `POST /api/verify?op=bulk` (K-017/K-018/K-019, BATCH_500 lane K)

No 13th function — `api/` is at the Vercel Hobby cap of 12 (confirmed by direct
listing before this shipped: badge/balance/credit/distill/fulfill/health/latest/
pin/renew/status/stripe-webhook/verify). Bulk verify is a MODE on the existing
`api/verify.js`, dispatched on `?op=bulk` the same way `api/fulfill.js` already
dispatches `?op=prefix-available` — no new vercel.json rewrite required for the
internal call shape. Design: `BULK_VERIFY_DESIGN.md`.

- **Request:** `POST /api/verify?op=bulk` with `{items: [{ns, rows, chain|digest}, ...]}`
  — the same three fields the single-item `GET /api/verify` already takes, per item.
- **Cap:** fixed at 20 items. An over-cap batch (or a non-array/empty `items`) is
  refused WHOLE with a 400, before any store read — zero partial processing, mirroring
  `arcaeon_receipt/cite_batch.py`'s cap-or-refuse pattern. Chosen because a single
  verify lookup can already cost up to `MAX_HISTORY_SCAN` (50) store reads in the
  worst case; 20 bounds a batch's worst case to 1,000 reads rather than leaving it
  unbounded.
- **Response:** `{ok, count, results: [...]}`, one result per input item, in request
  order, each carrying `http_status` plus exactly the body the single-item endpoint
  would have returned for that input. **No new verdict word** — `witnessed`
  (`true`/`false`/`null`) and every `reason` string are the identical set
  `api/verify.js` already emitted, because bulk mode calls the SAME `verifyItem`
  function the single-item path calls, once per item — not a second hand-copy of the
  lookup logic.
- **Never short-circuits:** a malformed item (bad `ns`/`rows`/`chain`) or a store-read
  error on one item produces that item's own error-shaped result and processing
  continues to the next item; the loop is a plain sequential `for`/`await`, never a
  `Promise.all` that would let one rejection take down the whole response.
- `api/verify.js`'s existing single-item logic was refactored (not rewritten) into
  `verifyItem()` returning `{status, body}` instead of writing to `res` directly, so
  both the GET single-item path and the new bulk path share one implementation.
  Existing single-item behavior is byte-identical; the full pre-existing suite
  (`test/verify.test.js`, 6 tests) still passes unchanged.
- New `test/verify_bulk.test.js` (9 tests): mixed valid/invalid/never-witnessed batch
  with per-item verdicts in order, the `digest` alias inside a bulk item, over-cap
  refusal with zero store reads, exactly-at-cap acceptance, malformed `items` shapes,
  and a mid-batch miss not aborting its neighbors.
- `npm test`: 186 → 195, all green.
- **What's still open, not decided here:** whether the per-IP rate limiter should
  scale with batch size (currently counts a bulk call as one hit, same as any other
  request — see BULK_VERIFY_DESIGN.md's "Rate limiting" section for the reasoning and
  the flagged trade-off) and whether a public `/api/verify-bulk` alias is worth adding
  via a vercel.json rewrite. Neither blocks this pass; both are named for whoever
  picks this lane up next.

## 2026-08-30 — independence disclosure: k=1, stated plainly

The status page and its JSON twin now disclose the root count directly: a
k=1 stat cell + explainer paragraph on /status, and an `independence` block
(`roots: 1, disclosed: true`) on /api/status.json. Rationale (owed to an
external reviewer, sram): eight namespaces signed by one operator is k=1,
a count of derivation roots, not signatures — and the determinate number
beats an indeterminate impression. The health tri-state (ok/degraded/
indeterminate) is unchanged; it grades freshness/gradeability, a different
axis. The k value changes only when a namespace under someone else's root
actually exists — that claim stays behind the publish gate until real.

Reverse-chronological. Every entry says what changed and why, and names the
reviewer whose objection forced it where there was one. Public review is the
reason this thing works; the credit belongs in the record, not in a thank-you.

## 2026-08-30 — Rev-2b: the prefix picker learns to answer (`/api/prefix-available`), and the commands become copyable

**COMMITTED NOWHERE AND DEPLOYED NOWHERE — working tree only; no Vercel action, no
Stripe action.** Founder design, Daniel 12288/12291: *"shouldnt we let our users pick a
prefix that isnt selected"*. Rev-2 gave the buyer a prefix FIELD and no way to know
whether the pick was free — the only feedback was a rejected form POST after the fact.
`npm test` 132 → 176, all green.

**1. New `GET /api/prefix-available?prefix=<p>` (`lib/_prefix_check.js`).** Validates
format (the existing `keys.validatePrefix`), then answers `{available}` against the same
universe the mint path uses — `WITNESS_KEYS` env bindings plus every issued-key record —
with the same two-way overlap rule (`acme-` and `acme-labs-` reject each other in BOTH
directions). Free → `200 {available:true}`. Taken → `200 {available:false, reason:"taken"}`
plus three alternatives that are each format-valid and verified free, and which DIVERGE
from the taken stem (`acme2-`, not `acme-hq-` — an extension would collide right back).
Invalid → `400`. The colliding prefix is never echoed: it belongs to another customer.
Store failure → `503 {available:null}`, never "free" — an unreadable store must not talk a
buyer into a pick the mint path will refuse. Input is trimmed+lowercased exactly as
`api/fulfill.js` normalizes an explicit pick, or the endpoint would answer about a
different string than the one minted.

**Routing, because `api/` is at Vercel Hobby's 12-function hard cap:** the public path is
a `vercel.json` rewrite onto `/api/fulfill?op=prefix-available`, dispatched at the top of
that handler before its session gate — the same trick already in use for
`/api/status.json`, and the same reasoning that put the balance page on the balance
function. A test asserts both the rewrite rule and that `api/` still holds ≤12 files:
without the rewrite this endpoint exists in code and 404s in production.

**Cached 20s, per warm instance.** `keys.listPrefixes()` is a directory listing plus one
read per issued key; a debounced picker asks once per typing pause and would otherwise
fan that out every time. The cache lives only in this module — the mint path calls
`listPrefixes()` directly and never sees it, so a stale entry can make the ADVICE briefly
wrong and can never widen what an actual mint accepts.

**2. The picker checks live (`lib/_prefix_ui.js`).** 400ms debounce with `clearTimeout`
on each keystroke, a sequence guard so a slow answer for `acm` can't repaint over a fast
one for `acme-`, three distinct states (free / taken / couldn't-check), and the three
alternatives as one-click buttons. "Couldn't check" is never painted as free, and the
submit button is never disabled by the check — the POST re-validates server-side, and a
client check that is itself unsure must not be able to lock a paying buyer out of a key
they have already paid for.

**3. The commands are copy boxes with the prefix already in them.** New `copyBlock()` in
`lib/_page.js` (multi-line sibling of `copyBox`) — the four-line curl was a bare `<pre>`
the buyer had to select by hand, which is exactly where a half-selected command comes
from. The picker previews it live as they type; the success page renders the final one.
`<YOUR KEY>` stays a placeholder on purpose even on the page showing the key: a one-click
copy of a command carrying a live bearer key lands that key in shell history.

**BOUNDARY, stated in three files and asserted in the suite: none of this mints.** The
availability answer is advisory. Key issuance stays exactly where it was — behind
`api/fulfill.js`'s server-side Stripe session verification, with the un-cached
`listPrefixes()`/`prefixConflicts()` pair as the authoritative gate — or in an operator's
hands per `projects/online_business/FULFILLMENT_RUNBOOK.md`. Tests assert the picker
route's `putLog` is empty and that the client script's only `fetch` is the read-only
availability URL.

**4. Two new test files, 44 tests, mutation-verified** (`test/prefix_available.test.js`,
`test/prefix_ui.test.js`). Nothing stubs `listPrefixes` — a test that stubs the
availability source cannot catch the availability source being wrong; these drive the
real fan-out against the mock GitHub store. The curl command exists twice (server render,
browser preview) and `test/prefix_ui.test.js` EVALUATES the browser copy out of the
shipped script source and diffs its output against the server function across a table of
prefixes, so drift between the preview and the receipt is a red instead of a support
email. Planted reds, all confirmed: debounce removed → 1 fail; substitution drifted to
`prefix + "-main"` → 4 fails; availability forced to always-free → 8 fails; the dispatch
removed → 25 fails; the rewrite dropped from vercel.json → 1 fail.

## 2026-08-30 — Ops: retired-namespace env var re-set (no code change)

Live `status.json` read `degraded` with `overdue:1` (`velouria-audit-20260819`, the 8/19
one-shot) while `retired_namespaces` listed only two names. The 8/24 deploy-gate note predicted
this exact failure: the piped `vercel env add` value cannot be read back, and the write had come
up short. Fixed by `env rm` + `env add` with all three names, then `vercel --prod`. Verified at
the observable effect: `summary.overdue: 0`, `retired_namespaces` = cadence-verify, canon,
audit-20260819; badge now `indeterminate · 8 ns · 0 overdue` (indeterminate is correct: there is
no current cadence namespace; that is the standing Option-1 floor item, not a defect here).

## 2026-08-30 — Test: `WITNESS_RETIRED_NS` end to end through the status computation (S-arcaeon-10c)

The env-var re-set above was fixed at the ops layer with no test ever exercising the
retirement filter itself end to end — `loadRetiredNamespaces()` (`lib/_status_data.js`) through
`status.json`'s summary shaping (`lib/_status_json.js`) had zero coverage. Added
`test/retired_namespaces.test.js`: (a) full three-name var — `summary.retired_namespaces` lists
all three, `summary.overdue == 0`, each row still `retired:true` with its real (overdue) cadence
status; (b) the var SHORT one name (`velouria-audit-20260819` missing) — that namespace counts as
overdue and the verdict reads `degraded`, the exact 8/24→8/30 production failure encoded as a red
in the harness now; (c) empty string, whitespace-only, and unset — nothing retired in any case.
Fixture reuses `cadence_overdue.test.js`'s store-monkeypatch seam (no GitHub calls), extended to
serve one pin per namespace so the three retirement candidates can be overdue while a fourth,
non-retired namespace stays current — keeps these assertions isolated from the unrelated ZERO
FLOOR (`nothingWatched`) mechanism. 127 → 132 tests, all green.

## 2026-08-22 — `witnessed` is tri-state: not-checked reasons return `null`, never a conclusive `false`

Forced by **ColonistOne's re-run against the deployed build** (Colony, witness
thread, 8/22): on 8/18 I said all three not-checked reasons would return
`witnessed: null` with scope in-band; the scope half shipped (accepted_head /
history / note) and the null half did not — `no_pin_recorded_for_namespace`
and `exceeds_current_head` still asserted boolean `false`. ColonistOne also
corrected their own record in the same comment (they had marked prediction B
falsified off my stated intention without verifying the deploy — same failure
class, named on both sides). The repair: `no_pin_recorded_for_namespace`,
`exceeds_current_head`, and `scan_bound_reached` now return `witnessed: null`
— an incomplete or inapplicable check may not assert a conclusive negative.
`false` is reserved for heads the record actively contradicts
(`rows_match_chain_mismatch`, `rows_never_witnessed`, `not_found_in_history`).
Two new contract tests plant the null cases (a 60-deep history to force the
scan cap; a shallow history to prove exhaustion stays a conclusive `false`).
109/109. README §verify rewritten to document the tri-state and credit the
catch.

## 2026-08-17 — Balance page: a human face on `/api/balance` via content negotiation; `lib/_page.js` extracted

**COMMITTED LOCALLY ONLY — not deployed, no Vercel config touched.** Founder
design 34378: every issued key needs an automated, easy way to see pins/
credits remaining — humans AND agents, no login, no accounts, no PII; the key
IS the identity. `api/` sits at Vercel Hobby's 12-function hard cap, so the
page rides the EXISTING `/api/balance` function via content negotiation, the
`api/fulfill.js` pattern. `npm test` green: 93 -> 104 (11 new,
`test/balance_endpoint.test.js`).

**1. New `lib/_page.js` — the shared page template.** `pageShell` / `copyBox`
/ `esc` / `wantsJson` moved VERBATIM out of `api/fulfill.js` (lib/ doesn't
count toward the function cap); fulfill now imports them, zero behavior
change to its pages (its own suite still passes untouched). One deliberate
delta: the input CSS selectors gained `input[name=key]` alongside
`input[name=prefix]` — additive only, no fulfill page has a key input. Env
URLs read at call time (the `_welcome_email.js` idiom).

**2. `api/balance.js` grows an HTML mode — JSON contract UNCHANGED.** HTML
is strictly OPT-IN by the browser's own `Accept: text/html`; the JSON
default (including a bare curl's `Accept: */*` and headerless SDK fetches)
takes exactly the pre-page code path — same fields, same Bearer auth, same
errors, pinned by an exact-field regression test. Browser GET without a key:
paste-your-key form, `type=password` (no shoulder-surfing), submits by POST
so the key never lands in any URL or access-log query string (house rule).
POST with a valid key: credits remaining, free-tier used/remaining, prefix,
key id, plus a curl one-liner copy-box teaching the agent path (placeholder,
never the real key — the key is never echoed into any response, success or
error). Invalid key: the form again, clean inline error, no echo.
Remember-my-key checkbox: default OFF, localStorage only, client-side only.

**3. Links to the page.** `/api/fulfill` success page and the welcome email
(HTML + text) each gained one line under the balance sentence: check your
balance any time at `<base>/api/balance` — a bare link, carries nothing.
`vercel.json` gained a friendly `/balance -> /api/balance` rewrite, mirroring
the established `/status` pattern (the form posts to `action=""` so it works
at both paths).

## 2026-08-17 — Instant fulfillment: `/api/fulfill` (Stripe session -> key + credits) and the dynamic issued-key store

**STAGED ONLY — working tree, not committed, not deployed. No Stripe config
touched, no secrets in code.** Board item 25 (founder-specced, msgs
12252-12263): the self-serve gap named in
`RESEARCH_WAVE_MCP_WRAPPER_2026-08-16.md` §8 — "there is no self-serve way
for a stranger to get a witness key" — now has a mechanism. `npm test`
green: 61 -> 79 (18 new, `test/fulfill.test.js`, Stripe API fully mocked).

**1. New `api/fulfill.js` — GET/POST `/api/fulfill?session_id=...`.** The
Checkout success/receipt page. Verifies the session SERVER-side
(`GET api.stripe.com/v1/checkout/sessions/{id}?expand[]=line_items`, secret
key from env; must be `status:complete` + `payment_status:paid`; livemode
gate + the webhook's H1 amount-vs-pack cross-check carried over). First
valid visit mints `wk_` key + namespace prefix + solo pool and credits the
pack; every revisit re-shows the SAME key (create-only session binding =
the idempotency gate; the recovery path via Stripe's receipt email). Faked,
unpaid, wrong-mode, or amount-mismatched sessions get typed denials — never
a key. Dual response: HTML for humans (key big, quickstart, support line,
one-line consent link — default unchecked, stored on the record), JSON
(`{key, credits, namespace, docs_url, ...}`) on `Accept: application/json`
or `?format=json` for agent buyers. Credit idempotency key is the SESSION
id — the same key `stripe-webhook.js` uses — so page and webhook can never
double-credit one purchase between them. A session carrying
`client_reference_id = sha256(existing key)` (the webhook top-up
convention) credits that key and mints nothing. Welcome email is an honest
STUB (`console.log` + TODO): this app has no mail mechanism and wiring
creds was out of scope; the receipt-URL revisit is the recovery path
meanwhile.

**2. New `api/_keys.js` — the dynamic issued-key store.** Keys previously
existed only as hand-edited `WITNESS_KEYS` env pairs, which a serverless
function cannot append to — so self-serve required a real store. Same
primitive as `_meter.js`/`_balance.js` on purpose: JSON files in the
PRIVATE usage repo, contents-API CAS. `keys/<sha256(key)>.json` (prefix,
plan, org, pool_id), `fulfillments/<session_id>.json` (binding; stores the
raw key so revisits can re-show it — the session URL is already a bearer of
the key by product design), `pools/<pool_id>.json` (org/pool schema baked
in now, UI later: solo pool's credit account IS the key's own balance file,
so the live billing path is unchanged; team flow — N keys drawing one pool
— is commented, not built).

**3. `api/pin.js` + `api/balance.js` — two-tier auth.** Env `WITNESS_KEYS`
lookup first (free, unchanged for every existing key), then the issued-key
store on a miss. Store failure is 502, never 401 — "couldn't check" must
not read as "your key is invalid" to a paying customer. Without this edit a
minted key would have been a dud — exactly the funnel dead-end §8 warned
converts curiosity into a bad first impression.

**Deploy needs (env, names only):** `WITNESS_STRIPE_SECRET_KEY` (falls back
to `STRIPE_SECRET_KEY`; a wrong-account key fails closed as a 404 denial,
unlike the webhook-secret case), optional `WITNESS_STRIPE_PRICE_MAP` (JSON
price-id -> pack; preferred mapping, with metadata.pack then exact
amount_total as fallbacks), existing `GITHUB_PIN_TOKEN` /
`GITHUB_USAGE_REPO` / `WITNESS_STRIPE_LIVEMODE`, optional
`WITNESS_DOCS_URL` / `WITNESS_BASE_URL`. Stripe-side human step: point each
Payment Link's success URL at
`/api/fulfill?session_id={CHECKOUT_SESSION_ID}`.

## 2026-08-16 — Quad-check remediation: H2 (async payments), H4 (false wedge on first pin), and three undocumented entries this file owed

**Not deployed in this commit — build + local-verify only, per instruction;
the CEO deploys.** Fixes `QUAD_CHECK_MONEY_PATH_2026-08-16.md`'s two remaining
open HIGH findings against `arcaeon-witness`, plus the doc-drift the same
report flagged. `npm test` green throughout: 57 -> 61 (four new regressions,
one per finding below; H1 and H3's regressions were already in the 57).

**1. H2 — async payment methods (ACH, Klarna) collected money and got
credited nothing.** `stripe-webhook.js` discarded every
`checkout.session.async_payment_succeeded` event as "unhandled event type,"
even though the payment-gate comment two screens up promised "the real
credit arrives later on the async success event" — that promise was never
implemented. A buyer paying by ACH got a `200` on both the initial
`checkout.session.completed` (correctly skipped, `payment_status:"unpaid"`)
and the later `async_payment_succeeded` delivery (incorrectly discarded),
with no retry and no record anywhere. Fixed: `CREDITING_TYPES` now covers
both event types; `checkout.session.async_payment_failed` gets a
`console.error` and a typed skip (nothing to credit, but a failed clear is
now visible instead of a silent nothing).

**The subtler half, traced mechanically rather than assumed:** does
subscribing to a second event type reopen the double-credit bug this repo
spent all weekend closing? Idempotency lived in `applied_events`, keyed on
`event.id` — and `checkout.session.completed` and
`checkout.session.async_payment_succeeded` are, by definition, two different
events with two different ids. Checked against Stripe's own fulfillment
guidance (`docs.stripe.com/checkout/fulfillment`) rather than reasoned about
in isolation: *"your `fulfill_checkout` function might be called multiple
times, possibly concurrently, for the same Checkout Session"* — Stripe's own
reference handler dedupes on the **Checkout Session id**, not the event id,
specifically because more than one event can carry a paid signal for one
real purchase. This repo's own flow mostly forecloses the two-events-both-
paid case today (an async method's `completed` delivery arrives `unpaid` and
returns before crediting ever runs), but keying on `event.id` alone left a
real gap the moment `completed` is redelivered already-paid, or a future
change widens which event types are subscribed. Fixed the same way Stripe's
own docs fix it: the idempotency key passed to `creditPack` is now the
Checkout **Session** id when the webhook has one (falls back to `event.id`
if a session somehow lacks one — real Checkout Sessions always have one).
`api/credit.js`'s admin path is unaffected — it has no session, and keeps
keying on its caller-supplied `event_id`, unchanged.

**Test:** `test/stripe_webhook.test.js` — an unpaid `completed` followed by a
paid `async_payment_succeeded` for the same session credits the pack exactly
once (previously: zero, ever); `async_payment_failed` skips and logs, credits
nothing; two DIFFERENT event ids (`checkout.session.completed` paid +
`checkout.session.async_payment_succeeded` paid) for the SAME session id
credit exactly once, not twice. All three fail against the pre-fix code
(verified by re-running against a stashed copy of the unfixed file) and pass
against the fix.

**2. H4 — a namespace's first pin could race into a false "wedged, reconcile
by hand," and get charged for it.** `pin.js`'s `verifyOrphanSuccessor` opened
`if (!orphan || typeof orphan !== "object" || !cur) return false;` — on a
namespace's first-ever pin, `cur` (the `latest.json` read) is legitimately
`null`, and the old guard treated that as unverifiable rather than as the
implicit "nothing pinned yet" predecessor it actually is. Two concurrent
first pins on a brand-new namespace: the winner writes a completely healthy
`latest.json` at seq 1; the loser's self-heal retry tries to adopt that exact
record, fails to verify it purely because `cur` was `null`, and returns
`409 orphaned_seq_record` — "namespace is wedged... compare files by hand in
a public GitHub repo" — on a namespace that was never wedged, after already
being billed a meter/credit count for the attempt. Highest-severity pin-side
finding precisely because a retrying client is the normal way to hit it, on
the very first interaction a new customer has.

Fixed: `verifyOrphanSuccessor` now treats a `null cur` as the implicit
`{seq: 0}` predecessor rather than refusing to verify against it — every
check in the function already degrades correctly against that shape
(`expectedSeq` resolves to 1, there's no `prev.rows` to violate monotonicity
against, and a genuine first record's newest interval carries
`supersedes_due_by: null`, exactly what `prevDue` resolves to here).

**Test:** `test/pin.test.js` — two real concurrent first pins (`Promise.all`,
no forced conflicts; the mock store's own create-race 422 on the loser's
seq-record write is what triggers the self-heal path) now both succeed (one
`201` content-advance, one `200` self-healed idempotent no-op), never a false
wedge, and `latest.json` settles at seq 1. Verified against a stashed copy of
the unfixed line: same repro produces the false `409 orphaned_seq_record` and
a spent meter count on a namespace that was never wedged.

**3. Three items this file owed and never paid, found by the same
quad-check pass.** None of these are code changes; all are the operator-
facing surface H1 and H3 exist to protect.
- **The mini pack had no changelog entry.** `PACKS.mini` ($5/1,000 pins, the
  CEO's kill-the-$15-wall ruling) shipped into `_balance.js` and is covered
  by `test/balance.test.js`, but this file's most recent entries before today
  never mentioned it — the same silence the quad-check named as the real risk
  multiplier for H1 (a fourth pack means a fourth hand-wired Payment Link,
  made by duplicating the third one).
- **The H1 fix (money-verify) had no changelog entry.** `stripe-webhook.js`
  now cross-checks `amount_total`/`currency` against the declared pack's
  ratified price before crediting — closing the "a signed $5 event with
  `pack=bulk` credits 40,000 pins" hole — and normalizes the pack id and
  `client_reference_id` hash before lookup (H3: `"Mini"` / `" mini"` /
  uppercase hex used to silently no-op-credit a paid session). Both are live
  in `stripe-webhook.js` and covered by `test/stripe_webhook.test.js`'s H1/H3
  REGRESSION tests, and neither ever got a line here.
- **The `node:test` harness itself had no changelog entry.** 57 tests before
  today's two additions, zero external dependencies, `test/helpers/mock_store.js`
  faking the GitHub contents API's CAS contract in memory — covered in
  README's own "Testing" section but never announced in this file, which is
  where a reader checking "is this repo tested" would look first.

**4. README correction, same pass.** `README.md`'s credit-balance section
described idempotency as a **retired** mechanism (a separate ledger
`applied:true` flag, checked before the balance write) — that was replaced
2026-08-14 by the `applied_events` in-balance-file CAS this changelog's own
2026-08-14 entries document, and the README paragraph was never updated to
match, so the README contradicted the code it was describing. Corrected in
place, plus `mini` added to both the pack-id wiring instructions
(`README.md`, `stripe-webhook.js`'s own header comment) and the pack-size
list — both previously read `starter`/`standard`/`bulk` only, the exact
byte-exact-typo shape H3 exists to punish, on the one document a human
actually reads while wiring a new SKU's Payment Link.

**Local verification (no deploy):** `npm test` — 61/61 green
(`test/*.test.js`), including the four new regressions above. `node --check`
clean on `api/pin.js` and `api/stripe-webhook.js`. No version bump —
`api/_balance.js` `PACKS`, `applied_events`'s on-disk shape, and every
response contract are unchanged; the money-path guard and the wedge-repair
guard both tighten an existing decision path without adding a field, a route,
or a schema.

## 2026-08-16 — Ops batch: rate limit on `/api/verify`, GET-CORS on read endpoints, retired-namespace list, CHANGELOG deploy-note corrections

**Not deployed in this commit — build + local-verify only, per instruction;
the CEO deploys.** All four items below are code + local verification; none
have been pushed live.

**1. Per-IP rate limit on `/api/verify`.** New `api/_ratelimit.js`: a naive
in-memory `Map<ip, {windowStart, count}>`, same shape as `api/pin.js`'s
existing per-key limiter (Stage-0, per-instance, resets on cold start).
`/api/verify` has no auth by design (board item 20 — no key needed just to
ask "does this exist?"), so there's no key to bucket on; IP via
`x-forwarded-for` (leftmost hop) is the only available identity, with a
`socket.remoteAddress` fallback. ~30 calls/IP/10min; the 31st gets `429` with
an honest JSON body (explicitly says this is a per-instance, not a global,
cap) and a `Retry-After` header. Documented, not hidden: a distributed burst
across multiple warm Vercel instances gets multiple independent buckets —
real protection against one hot loop, not a guaranteed global ceiling.
Applied only to `/api/verify` (the read path named for this fix); write
endpoints are untouched.

**2. GET-only CORS on `verify.js`, `status.js`, `health.js`.** New
`api/_cors.js`: `Access-Control-Allow-Origin: *` on every GET/HEAD response,
`OPTIONS` answered `204` with the full preflight header set. Scoped
deliberately to these three read endpoints — they leak nothing beyond what
the public pin repo already shows a stranger who clones it. Never applied to
write endpoints (`pin.js`, `renew.js`, `credit.js`, `balance.js`,
`distill.js`, `stripe-webhook.js`), which stay Authorization-bearer-gated and
outside this helper's import graph entirely, on purpose.

**3. `WITNESS_RETIRED_NS` — a honest way to stop grading a namespace without
hiding it.** Two demo/self-test namespaces (`velouria-cadence-verify`,
`velouria-canon`, both carrying `deadbeef`-style placeholder chains) have sat
permanently `overdue` in production, painting the whole public badge red for
a problem that isn't one — nobody is renewing a demo namespace on purpose.
`api/_status_data.js` now reads a comma-separated `WITNESS_RETIRED_NS` env
var and excludes any matching namespace from the counts that drive the
verdict (`overdueCount`, `currentCount`, `ungradeableCount`,
`missedEverCount`, and therefore `degraded`/`indeterminate`/`overallOk`) —
but the namespace's row stays in `rows`/`namespaces` exactly as before, now
carrying `retired:true` and its real (still-overdue) status. `status.js`
renders it dimmed with a grey "retired" badge and a summary paragraph naming
which namespaces and why; `status.json.js` carries `retired` per-namespace
and `summary.retired` / `summary.retired_namespaces`; `badge.js` needed no
code change — it already reads the (now-corrected) counts. Reversible:
removing a name from the env var makes it gradeable again on its next read,
forward-only, nothing backfilled.

**4. CHANGELOG deploy-note corrections.** The 2026-08-15 `/api/distill` and
"Two public promises paid" entries both still read "Not deployed in this
commit" — true when written, stale now. Confirmed live via `OPTIONS
/api/distill` answering `405` from production (route exists) rather than
`404` (route absent). Corrected in place with a dated note rather than
silently rewritten, so the record shows what was true at authoring time.

**Local verification (no deploy):** `node --check` clean on all five
changed/new files (`_ratelimit.js`, `_cors.js`, `verify.js`, `status.js`,
`health.js`, `_status_data.js`, `status.json.js`). Stub-invocation harness
(not committed) ran the ACTUAL handler functions against a mocked
`global.fetch` standing in for the GitHub contents API: `verify.js` OPTIONS
-> 204 with the ACAO header; a normal GET -> 200 witnessed with ACAO set;
31 GETs from one IP -> the 31st gets 429 with `Retry-After` and an honest
per-instance-limited body; a second IP is unaffected. `_status_data.js`
reproduced the live bug first (fabricated the same two overdue demo
namespaces -> `degraded:true`, matching the real red badge), then re-ran the
identical code path with `WITNESS_RETIRED_NS` set -> `degraded:false`,
`overallOk:true`, both namespaces still present in `rows`/`namespaces` with
`retired:true` and their real `overdue` status intact, `retiredCount:2`.
`status.json.js` and `status.js`'s real handlers, invoked against that same
data, rendered the `retired` field and the grey tag/summary paragraph
respectively. `badge.js`, invoked against a single healthy fixture namespace,
returned `color:"green"`, `message` starting `"ok"`. All checks passed.

## 2026-08-15 — `POST /api/distill`: hosted try-before-pip demo for arcaeon-distill

**Deployed and live** — shipped in the normal morning batch with live
verification (`OPTIONS /api/distill` answers `405` from production, i.e. the
route exists and is being served — a 404 would mean not deployed). *Correction,
2026-08-16: this entry originally read "Not deployed in this commit — ships in
the morning batch," written before that batch ran. It ran; the note was never
updated after. Left here so the record shows what was true when written, not
edited to look prescient.*

New metered endpoint (`api/distill.js` + `api/_distill_core.js`) so an agent
can try arcaeon-distill's deterministic tool-output compaction over HTTP with
zero install: `POST {content, budget}` -> `{content: distilled, receipt}`.
Auth + free-tier metering reuse the exact `/api/pin` pattern
(`store.keyPrefixFor` for key validity, `_meter.js` for the monthly cap,
`_balance.js` for credit top-up past it, charged only after the compute
succeeds — a malformed request burns nothing, same rule pin.js already
enforces on its own rejection paths).

**The honest problem: arcaeon-distill is Python; this deployment is Node.**
The product's entire pitch is "same input, same budget, byte-identical
output, every run, every machine" — so a lazy `JSON.parse` + walk + re-stringify
port would have silently BROKEN that promise the moment it crossed the
language boundary, in two structural ways:
- Python's `json.dumps(5.0) == "5.0"`; plain JS `JSON.stringify(5.0) == "5"`
  (JS has one numeric type — the float-vs-int distinction a JSON token
  carries is gone the instant `JSON.parse` touches it). Python and JS also
  switch to scientific notation at different magnitude thresholds.
- Plain JS objects silently reorder integer-looking string keys
  (`{"2":"b","1":"a"}` enumerates `"1"` before `"2"` regardless of insertion
  order); Python dicts never do. distill()'s wide-dict head/tail truncation
  depends on true insertion order.

Fixed rather than punted: `_distill_core.js` ships a hand-written JSON parser
that classifies each number token as int-vs-float lexically (matching
Python's `json.scanner` rule exactly) and represents every JSON object as a
`Map` (never a plain object) end to end; a `pyFloatRepr()` formatter derived
empirically against a live CPython process (battery: `5.0, 100.0, 1e16,
1e17, 1e-5, 1.5e300, -0.0, 12345678901234567.0, ...`) reproduces CPython's
`repr()` presentation exactly — notation-switch threshold, exponent
zero-padding, trailing `.0`. Every other piece of the algorithm (the three
strategies — json/tabular/text — head/tail truncation, the drop-receipt
digests, the cycle-safe admission gate) is a direct line-for-line port of
`arcaeon_distill/__init__.py` v0.1.2.

**Verified, not assumed:** a 12-case, 515-field cross-language equivalence
harness (json/tabular/text strategies; floats incl. the exact
formatting-edge-case battery above; unicode keys/values; wide dicts; deep
nesting; list-of-lists; CSV; free-text extraction with and without a query)
ran the SAME literal input bytes through the live Python package and this
JS port and diffed every field, including the sha256 receipt digests
(byte-identical canonicalization -> byte-identical hashes, not just
structurally-similar output). Result: **0 failures across 515 checks** — the
JS port reproduces the Python package's content, drop manifests, and digests
exactly for every case tested. `node --check` clean on both new files; a
local stub-request invocation of the handler exercised auth-reject,
malformed-JSON-reject, missing-field-reject, a full successful distill call
(metering itself 401s offline with no live `GITHUB_PIN_TOKEN` in this local
run — expected, same store dependency `/api/pin` already has), and a
NaN-content typed rejection.

**Because a port can never be a promise of eternal equivalence** (a future
edit to either implementation could silently drift the two apart), every
receipt this endpoint returns is stamped `implementation:"js-port"`,
`js_port_version`, and `py_package_version_target` — so a receiving agent
can always tell which implementation produced a given receipt, rather than
assuming the pip package's guarantees transfer by brand name alone. Documented
residual (not blocking, same spirit as the Python package's own "non-proofs"
section): Python's arbitrary-precision ints beyond JS's safe-integer range
round-trip as strings, not numbers, in the JSON response.

## 2026-08-15 — Two public promises paid: legacy heads can ARM, deadlines are OWNER-gated

Both halves of the reviewer debt that 4606d62 only half-paid. Nothing on the
payment/credit path was touched (`api/stripe-webhook.js` and `_balance.js` are
byte-identical), no stored pin changed shape, and the conflict-observation log
and monotonic guard are untouched. **Deployed and live** — shipped in the
normal morning batch. *Correction, 2026-08-16: this entry originally read "Not
deployed in this commit — it ships in the morning batch," written before that
batch ran; it ran, and the note was never updated after. Live confirmation:
`pins/velouria-demo` and `pins/velouria-selftest` are still `legacy_no_deadline`
on production as of this correction — expected, since the arm-on-bare-repin
fix only fires on a namespace's NEXT re-pin, and neither has re-pinned since
this shipped; the code is live, it just hasn't had a trigger yet.*

**1. `legacy_no_deadline` now has an exit (owed to atomic-raven).** Their
objection was *"a warning that cannot refuse is telemetry, not a control."*
4606d62 paid the refuse half: `cadence_gradeable:false`,
`cadence_grade:"cannot_determine"`, an `X-Cadence-Gradeable` header, hatched
amber on `/status`. It did not pay the exit half. A namespace pinned before the
cadence field existed carries no deadline, and a publisher whose log had gone
quiet re-pinned that same unchanged head, hit the idempotent `200`, and stayed
ungradeable forever — the arming path (a content advance, or an explicit
`intent:"renew"`) existed but was unreachable for exactly the publisher who
needed it. Two live namespaces are in that state right now
(`pins/velouria-demo`, `pins/velouria-selftest`: `seq` present, no
`next_pin_due_by`). Fix: **a bare re-pin of a head that carries no deadline arms
the first one** — `201` with `armed_cadence:true`. The "refreshing a deadline
must be asked for out loud" rule is intact: there is no window to extend and
nothing to launder, the only possible movement is cannot-determine → gradeable,
it is one-time per namespace (once armed, bare re-pins are plain no-ops again),
and `had_ungradeable_history:true` stays on the record permanently. Graded reads
of a once-ungradeable namespace now also carry a `cadence_history_note` saying
the deadline was armed forward-only and grades nothing before it.

**Verified locally** (real handlers, mocked GitHub store), seeded with a record
copied from the live legacy shape:

```
BEFORE /api/latest verdict: {"status":"legacy_no_deadline","cadence_gradeable":false,"cadence_grade":"cannot_determine","next_pin_due_by":null}
bare re-pin -> 201 {"armed_cadence":true,"record_kind":"publisher_heartbeat","next_pin_due_by":"2026-08-16T08:46:06.099Z"}
AFTER  /api/latest verdict: {"status":"publisher_heartbeat_current","cadence_gradeable":true,"cadence_grade":"pass","had_ungradeable_history":true}
bare re-pin AGAIN -> 200 {"note":"already witnessed (idempotent re-pin) — no renewal intent, deadline unchanged"}
```

**2. A deadline write requires the namespace's OWNER key (owed to excelsior).**
Their deadline-laundering plant asked for renewal to be *owner*-authorized, not
merely bearer-authorized. What shipped was the prefix gate — which answers "may
this key write in this namespace's neighbourhood," not "is this key this
namespace's publisher." Issued prefixes can overlap (`acme-` and
`acme-ledger-`), so a second key could refresh a namespace it does not publish.
Fix: the first key to renew or arm a namespace binds itself as that namespace's
deadline owner in a new public `owners/<namespace>.json`; every later renewal or
arm must present that same key or gets `403 not_deadline_owner` and writes
nothing (the refusal lands before metering, so it burns no meter count and no
credit). Content advances are deliberately NOT gated by it — that path is the
prefix gate's, unchanged. The binding id is `sha256("arcaeon-witness-owner-v1|"
+ key)` truncated to 32 hex, **domain-separated from the `sha256(key)` used as
the billing identifier**, so publishing it in a public repo does not publish the
Stripe `client_reference_id`.

This closes *the other key*, not *the stolen key*, and README/PRACTICES/`/status`
now say so in those words. Owner-signature auth is still Stage-1 and still not
built.

```
renew, NO key        -> 401 {"error":"invalid or missing bearer key"}
renew, WRONG key     -> 403 {"error":"not the deadline owner of this namespace — a cadence deadline may only be renewed or armed by the key bound to it","reason":"not_deadline_owner"}
  (that key passes the prefix gate: keyPrefixFor(OTHER_KEY) = demo- )
renew, OWNER key     -> 201 {"renewed":true,"record_kind":"publisher_heartbeat"}  deadline moved: true
```

Regressions re-run green in the same harness: content advance by a non-owner
key still `201`, monotonic violation still `409`, unknown intent still `400`,
same-rows/different-chain still `409` + observation, renewal of an unknown
namespace still `404` (and binds nothing), a new namespace's first pin creates
no owner file.

## 2026-08-14 — Fix: the four billing/race defects the hostile audit FLAGGED — all shipped

The audit earlier today (entry below) shipped the unambiguously-safe fixes and
deliberately *escalated* anything that touched billing or write semantics —
"an auditor who also rewrites the billing logic is not an auditor." Those
escalations are now authorized and fixed. Each was reproduced against the live
store with throwaway namespaces first, then re-run green after the fix; the
throwaway files were deleted (delete commits are in each repo's history). This
whole path is PRE-REVENUE — no pack has ever been sold, the Stripe webhook is
not wired, there are zero live balances — so the schema change below needed no
migration and the fixed-but-inert code is simply *correct-when-wired*.

**1. CRITICAL — credit double-grant (`_balance.js grantCredits`).** A Stripe
delivery retry could credit one paid pack twice (audit repro: 10 pins bought,
20 granted). The idempotency claim (`applied:false -> true`) and the balance
write were two separate GitHub round-trips, so two overlapping deliveries of the
same `event_id` both read "not yet applied" and both added. Fix: idempotency now
lives INSIDE the same compare-and-swap as the balance write — the balance file
carries an `applied_events: [...]` set (bounded to the last 500), and
check-membership + add-pins + record-event are one CAS against the file's sha.
The loser of the race re-reads, sees the `event_id` already applied, and returns
`already_credited` without adding again. The append-only `ledger/` grant file is
still written as an audit record but is no longer the gate. **Test (two
concurrent OS processes granting the same event_id, 6 trials each):** pre-fix
double-granted (balances `[10,10,10,10,10,20]` — a real `20`); fixed granted
exactly `10` in all 6 trials, the losing writer returning `already_credited`.
**Schema note for the not-yet-existent cutover:** `balance/<hash>.json` gains
an `applied_events` array — additive, no migration (zero live balances); a
pre-field file reads as an empty set, which is correct.

**2. charge-after-commit (`pin.js`).** Metering (`meter.check`, which
increments) and the over-cap `decrementCredit` ran at the TOP of the handler,
before the monotonic / conflict / renewal checks — so a pin that then got
rejected 409 had already burned a meter count and, over the free cap, a real
credit. Fix: metering moved BELOW every rejection branch, into the two actual
write paths, guarded so a self-heal retry can't double-charge. A rejected pin —
and now also an idempotent no-op re-pin, which records nothing — charges
nothing. **Test (pre-fix vs fixed):** under-cap rejected pin — meter `used`
went `1->2` pre-fix, stays `1` fixed; over-cap rejected pin on credits —
balance went `4->3` pre-fix, stays `4` fixed.

**3. webhook payment gate (`stripe-webhook.js`).** `checkout.session.completed`
credited a pack without checking that the money actually cleared — for async
payment methods, "session completed" is not "paid." Fix: credit only when
`session.payment_status === "paid"`; anything else (`unpaid`,
`no_payment_required`, missing) returns `200 {skipped:"session not paid"}` so
Stripe doesn't retry, and the real credit arrives later on the async-success
event if the payment settles. Plus a livemode assertion (`event.livemode` must
match `WITNESS_STRIPE_LIVEMODE`, default live) so a test-mode event can't credit
a live balance. **Test:** unpaid, `no_payment_required`, and livemode-mismatch
sessions all credit `0`; a paid+live session credits the full 3,000-pin starter
pack.

**4. orphaned-seq self-heal (`pin.js`).** A pin is two non-atomic commits (the
numbered seq record, then `latest.json`). If the first landed and the second
didn't, `latest.json` sat one behind, every later pin recomputed the same seq,
collided, and 502'd — the namespace was **permanently wedged**. The audit
shipped detection (typed `409 orphaned_seq_record`); this is the repair. On a
collision the handler reads the orphan and adopts it into `latest.json` ONLY if
it VERIFIES as the legitimate immediate successor of the current head — exactly
one seq ahead, monotonic non-decreasing rows, a well-formed hex chain, a known
`record_kind`, and a prev-chain linkage (the orphan's newest interval must
supersede THIS head's deadline). Anything less keeps failing typed rather than
launder a corrupt record into an append-only public log. The check runs before
any charge, so a wedge never mischarges. **Test:** pre-fix stayed wedged (409,
head stuck at seq=1); with a valid planted orphan the fixed handler adopted it
(seq=2) and recorded the caller's pin as seq=3; a corrupt-linkage orphan was
refused adoption (typed 409, head untouched).

Regression-checked after the `pin.js` restructure: advance / renewal (still
charged) / idempotent re-pin (now uncharged) / monotonic-reject / head-conflict
all behave correctly. Deployed to production (safe: inert until the webhook is
wired); health / latest / status.json / badge / verify confirmed live.

## 2026-08-14 — Fix: hostile security audit of `api/` — four shipped fixes, two escalations

A deliberately adversarial line-by-line audit of every file in `api/`, assuming
the code guilty. Findings were reproduced live against throwaway namespaces
(`velouria-audit1..3`, since removed — the delete commits are in the pin repo's
history). Only unambiguously-safe fixes shipped; anything touching auth or
billing semantics is written up for review instead, because an auditor who also
rewrites the billing logic is not an auditor.

**Shipped.**

`api/_store.js` `validatePin` — bounded `rows`. `Number.isInteger` accepts
2^53, and `JSON.parse` silently rounds `9007199254740993` down to it, so a
single request could pin an absurd head. Because the monotonic guard is
absolute and correct — a witness never goes backward — that namespace could
then *never record a real head again*. One request, permanent, no undo.
Reproduced live before the guard existed. Now `Number.isSafeInteger` (anything
larger does not survive a JSON round-trip, and a witness that silently rewrites
its input is not a witness) plus a `MAX_ROWS` domain bound.

`api/_store.js` `keyPrefixFor` — constant-time key comparison, and an empty
namespace-prefix is now refused rather than honoured. `===` on a secret
short-circuits at the first differing byte; and a `WITNESS_KEYS` entry written
`somekey:` (trailing comma, half-finished edit) granted that key write access
to *every* namespace, because `"".startsWith(x)` is always true. A config typo
must never be the thing that widens authorization.

`api/_meter.js`, `api/_balance.js`, `api/_store.js` — stopped putting upstream
response bodies and private-repo paths into thrown messages. Handlers
interpolate `err.message` directly into 502 bodies, so a concurrent pin storm
was returning `usage/<sha256(key)>/<month>.json` and GitHub's raw error body to
the caller. Detail now goes to the server log; the caller gets the condition.

`api/pin.js` — typed `409 orphaned_seq_record`. The numbered record and
`latest.json` are two separate commits and are not atomic. If the first lands
and the second does not (function timeout, transient GitHub error), every later
pin recomputes the same seq, collides with the orphan, and 502s: the namespace
is **permanently wedged**, and the code comments claiming it "self-heals on the
next pin" were wrong. Confirmed live, and it recurred on its own during
verification. This change is detection only — it names the condition and points
at the orphan instead of returning an opaque store error. The repair is
escalated below.

`api/stripe-webhook.js` — `module.exports.config` was assigned *before*
`module.exports = handler`, so the handler assignment discarded it and
`bodyParser:false` never applied. The request stream would already be drained,
`readRawBody` would return empty, and the HMAC would be computed over an empty
body — every genuine Stripe delivery would have failed signature verification
the day this endpoint was wired up. Config is now attached after the handler.
Also: sign over the raw bytes rather than a utf-8-stringified Buffer, and
reject non-hex `v1` explicitly (`Buffer.from(x,"hex")` does not throw, so the
existing try/catch was dead code).

`api/status.js` — GET/HEAD guard. Any method rendered the page and fired the
full GitHub fan-out behind it.

**Escalated, not shipped** (see the audit report): the `applied:false`
check-then-act window in `_balance.js` `grantCredits`, which lets one paid
Stripe event be credited twice — demonstrated, 10 pins purchased, 20 granted;
and the orphaned-seq-record repair, which changes append-only write semantics
and needs a decision rather than a patch from the person who found it.

## 2026-08-14 — Add: anchor staleness now degrades `/status`, `/api/status.json`, `/api/badge` (board item 26)

The daily self-anchor (`bridge/arcaeon/ots_anchor.py`, Task Scheduler
`velouria-ots-anchor`, 03:15 local) writes `anchors/<date>-head.txt(.ots)` to
the pin repo and logged locally to `ots_anchor_log.jsonl` — but nothing public
noticed if the job silently stopped running. `/status` rendered the anchor's
age but never fed it into the page's own degraded/ok verdict, so a dead
anchor job left the badge green.

`api/_status_data.js`'s `anchor` object now carries `ageHours` and a
`status` of `current` / `stale` (>36h — 1.5x the 24h cadence) /
`cannot_determine` (anchors/ unreadable or empty — same non-answer
discipline as an ungradeable pin), computed from the timestamp inside the
anchor file itself, not just its filename date. `stale` now folds into the
page's `degraded` state and `cannot_determine` into `indeterminate`, so a
stopped anchor job turns the badge red/yellow instead of staying silently
green. `api/status.json.js` exposes this as a dedicated top-level
`ots_anchor` block (date, age_hours, status, stale_after_hours, sha,
has_ots_proof, claimed_at, url, error) so a monitor doesn't have to know the
rest of the schema to find it. `api/badge.js`'s message now appends
`· anchor stale` / `· anchor cannot_determine` when relevant instead of
leaving the reason to a click-through.

## 2026-08-14 — Fix: `/` served a bare Vercel 404

Only `/status` and `/api/*` resolved; the domain root returned `NOT_FOUND`. The
Arcaeon HF org card — whose own pitch is "hand the reader the means to check" —
linked its hosted-witness call-to-action at `https://arcaeon-witness.vercel.app`,
so a stranger clicking the one link that proves the operator cannot silently
advance their own pins landed on a Vercel 404. The root of a tamper-evidence
domain is the last place to serve a broken page.

`/` now rewrites to `/api/status`, the same destination `/status` already used.

## 2026-08-14 — Fix: `HEAD` on the public read endpoints answered 405

`/api/latest`, `/api/badge`, `/api/status.json` and `/api/verify` all guarded with
`if (req.method !== "GET")`, which rejects `HEAD` — the method uptime monitors and
link checkers reach for first. The endpoints were serving 200 to every real client
and reporting themselves **down** to every automated one. `/api/health` and `/status`
carry no such guard and always answered `HEAD` correctly, so the trust surface
disagreed with itself depending on which URL a monitor was pointed at.

Guards now accept `GET` and `HEAD`, and advertise `Allow: GET, HEAD`. Node strips
the body from a `HEAD` response on its own, so no handler needed a second branch.
`/api/balance` deliberately keeps its `GET`-only guard: it is bearer-gated, no
monitor reaches it unauthenticated, and widening an auth-gated method surface is
not a thing to do casually as part of a fix for public read endpoints.

Found by a full endpoint sweep (all 14 routes, hit + miss + unauthenticated cases).
That sweep also confirmed the thing most worth confirming: `/status`,
`/api/status.json` and `/api/badge` agree field-for-field with `/api/latest`, even
though `_status_data.js` computes cadence through a deliberately separate
reimplementation of `_store.js`'s `computeCadenceFields`. Two independent
implementations, one answer.

## 2026-08-14 — Fix: unstamped legacy records no longer track the live `AUTH_LEVEL`

`api/_store.js:382` read `out.auth_level = (pin && pin.auth_level) || AUTH_LEVEL`.
Records written before the auth stamp existed carry no `auth_level` of their own,
so that expression fell through to the **current value of the constant**. Harmless
while the constant is `"bearer-stage0"` — and a silent retroactive rewrite the day
Stage-1 flips it to `"owner-signature"`, at which point every unstamped legacy
record would begin claiming owner-signed auth it never had.

That is precisely what `README.md` "Auth honesty" promises will not happen:
*"the two will be distinguishable in the public repo record-by-record — including
retroactively, because every record written before then says `bearer-stage0` in its
own text."* Unstamped records do not say it in their own text. They say nothing, and
the fallback was speaking for them — in whatever voice the constant happened to have.

Fixed per `STAGE1_SIGNATURE_DESIGN.md` §7.1: the fallback now resolves to frozen
literals (`LEGACY_AUTH_LEVEL` / `LEGACY_AUTH_NOTE`) that do not move when the live
constants move, and the legacy note names itself as an unstamped pre-Stage-1 record
rather than borrowing the current era's wording. Records that DO carry a stamp are
untouched and still report it verbatim. Landed now, independently of whether the
rest of Stage-1 is ever built — it guards a public promise, it is easy today, and
it is a postmortem later.

Verified: unstamped record -> `bearer-stage0` + unstamped-legacy note; stamped
record keeps its own values; no `|| AUTH_LEVEL` live-constant fallback remains in
the file.

## 2026-08-14 — Stage-1 owner-signature design doc (**design only, nothing built**)

`STAGE1_SIGNATURE_DESIGN.md` — the owner-signature scheme whose absence every
record in this repo currently announces (`auth_level:"bearer-stage0"`). Written
against **excelsior's** proposed conflict-receipt schema from the Colony thread
(`{accepted_head, candidate_head, candidate_sig, namespace_key_id, auth_verdict,
observed_at, request_digest}`), posted for review before any code exists.

Nothing in it is implemented. What it settles: per-namespace Ed25519 keypairs;
first-binding-wins registration; `prev_seq` + `prev_record_digest` as the replay
control (chosen over an idempotency header because it needs no new server state
and is checkable from the public record); dual-signature conflict receipts where
the candidate's signature-or-absence is recorded **affirmatively**, never by
omission; bearer keys demoted to metering and rate identity only.

Two things it refuses to soften. **The first key binding for an existing
namespace is trust-on-first-use** — today the bearer key is the only ownership
proof this service has (`api/_store.js:130-140`), so the bearer key is the only
thing that can authorize a first binding, and a key that leaked before then hands
its holder a permanent credential instead of a temporary one. The doc says that
in those words (§2.3). And **Stage-1 proves key custody, not owner intent** — a
compromised owner machine signs happily, which matters more here than most places
because the intended publisher is often an agent (§9.1).

**One real bug found while writing it, and it is not a design item.**
`api/_store.js:382` — `out.auth_level = (pin && pin.auth_level) || AUTH_LEVEL;`.
Records written before the auth stamp existed carry no `auth_level`, so they fall
back to the *current constant*. That is harmless today and becomes a silent
retroactive upgrade of every legacy record the day the constant flips — breaking
the promise at `README.md:293-296` that pre-Stage-1 records stay distinguishable
"because every record written before then says `bearer-stage0` in its own text."
They do not say it; the fallback speaks for them. The fix is two lines
(§7.1) and should land independently of whether the rest is ever built.

## 2026-08-14 — `cadence_gradeable` refuse-semantics + publisher-heartbeat renewal

Two debts from public review, both paid as promised.

### 1. `legacy_no_deadline` now arms something (**atomic-raven**)

atomic-raven's objection: *"a warning that cannot refuse is telemetry, not a
control."* `/api/latest` returned `status:"legacy_no_deadline"` for records
predating the cadence field, and nothing downstream changed behavior — every
consumer gating on cadence still saw an unqualified green light. It printed; it
did not arm.

- `/api/latest` returns **`cadence_gradeable: false`** for legacy records
  (`true` on every gradeable read, so consumers can gate on it uniformly), plus
  **`cadence_grade: "cannot_determine"`** — a distinct class from `pass`/`fail`
  — and an `X-Cadence-Gradeable` response header so a proxy can refuse without
  parsing a body. `status` is unchanged for existing consumers.
- `/status` renders ungradeable rows **hatched amber, labeled "cadence not
  gradeable,"** never the neutral grey that reads as fine; the page header
  reports `INDETERMINATE` rather than `OK` while any namespace is ungradeable,
  and a stat tile counts them.
- README documents the refuse-semantics explicitly: a consumer gating on cadence
  **must** treat `cadence_gradeable:false` as `cannot_determine`, not as a pass.
- No history was rewritten and **no deadline was backfilled.** A legacy
  namespace becomes gradeable on its next pin or renewal, forward only;
  `had_ungradeable_history:true` stays on the record permanently.

### 2. `POST /api/renew` — a deadline a live-but-quiet publisher can refresh (**excelsior**)

excelsior found the hole: a namespace whose log genuinely stops changing went
permanently overdue, because the idempotent re-pin branch returned the stored
pin untouched and the deadline only moved when rows advanced. A finished log
and an abandoned one were indistinguishable. excelsior's invariants are the
spec, and each one is implemented:

- **Retained miss** — a renewal over an overdue deadline keeps `missed_due_at`,
  `first_missed_due_at`, `missed_deadline_count`, `ever_missed_deadline`, and a
  `missed_deadlines[]` entry. Renewal moves the deadline; it never erases that
  one was missed. A later content advance doesn't erase it either — both write
  paths run the same append-only history code (`_store.appendInterval`).
- **Appended interval** — each renewal appends an `intervals[]` object carrying
  `supersedes_due_by` and `superseded_deadline_was_missed`; the old deadline is
  never rewritten. Most recent 20 inlined, full series in the per-seq commit
  history.
- **Typed distinction** — `record_kind:"publisher_heartbeat"` vs
  `"content_head_advance"` in the record; `head_state:
  "publisher_heartbeat_current"` vs `"content_head_advanced"` in `/api/latest`,
  with `status` reporting `publisher_heartbeat_current` so a naive
  `status === "current"` gate does not pass a namespace whose content never
  moved. Plus `content_unchanged_for_seconds` and `renewals_since_advance`, so
  "kept current for months without a single new row" is a number, not a vibe.
- **Not launderable** — renewal must restate the head exactly (`409
  renewal_head_mismatch` otherwise); same-rows/different-chain still takes the
  conflict-observation path; an unknown `intent` is a `400`, never a silent
  fallthrough; a bare re-pin still returns the old idempotent `200` and moves no
  deadline. `/api/renew` is a thin wrapper over `api/pin.js` on purpose — one
  implementation of auth, metering, rate limit and guards, so a renewal can't
  skip a check a pin has to pass.
- **Auth, stated honestly** — bearer-key only, `auth_level:"bearer-stage0"` on
  every write response, every stored record, and every read.
  **Owner-signature auth is the Stage-1 requirement and is NOT built.** A leaked
  key can keep a namespace looking alive without the owner. Named in the README,
  in the `/status` footer, and in the API's own `auth_note` field rather than
  left to be discovered.

## 2026-08-14 — earlier

- Real decrementing credit balance + instant top-up (`_balance.js`,
  `/api/credit`, `/api/stripe-webhook`).
- Public `/status` page: stranger-gradeable trust surface.
- Cadence-deadline alarm (`next_pin_due_by`/`status`) — **excelsior's** review —
  plus the Witness Practices Statement.
- Free-tier metering enforced via a native Node port of arcaeon-meter.
- Daily OpenTimestamps counter-anchor of the pin repo HEAD.
- Same-length re-mint guard: idempotent re-pin + append-only conflict
  observation log — **reticuli** (the missing typed case) and **excelsior**
  (the two-ledger design).
- Stage-0 hosted witness: public-GitHub-repo pin store behind a Vercel API.
