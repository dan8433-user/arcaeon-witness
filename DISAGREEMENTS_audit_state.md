# Interpretive choices in the audit-state slice (part B, slice 1)

Written 2026-09-22 alongside `lib/_check_record.js`, `lib/_audit_state.js`, `lib/_audit_status.js` and `tools/check_and_sign.js`. Every place the design page (`projects/online_business/DESIGN_CONSISTENCY_AND_NEVER_LOOKED_2026-09-22.md`, part B) left room, or where the build brief and the page differed, is listed here with the choice made. The tie-break was the same every time: **a state is never upgraded without evidence.** Each entry names the test that pins the choice.

## D1. BROKEN is permanent, not "newer than the last VERIFIED"

The build brief said "any BROKEN newer than the last VERIFIED -> BROKEN". The page (B3) says "a reproducible BROKEN is permanent: a later VERIFIED does not clear it. The only way out is the BROKEN itself being shown wrong (its tool version withdrawn, or its inputs shown to be not the record's)". The page wins, because it is the one that never upgrades: a fresh VERIFIED after a BROKEN is two checkers disagreeing, not a repair. Implemented as: any verifiable BROKEN whose tool and key are not withdrawn is standing, regardless of order. Test: `STATE: BROKEN then a LATER VERIFIED -> still BROKEN`.

Not implemented (B9 question 2, open for Daniel): re-running a BROKEN from its public inputs before letting it flip the badge. Slice 1 accepts only records the operator commits, so an unreproducible outside BROKEN cannot reach the page yet.

## D2. "Withdrawn" is the only release, and it applies to every result

B6 lists withdrawal (tool version, checker key, recipe) as an immediate demotion of CHECKED to STALE. The page does not say what withdrawal does to a BROKEN or to an operator's own VERIFIED. Choices:
- A BROKEN from a withdrawn tool or key is no longer standing (B3's "only way out"). It stays on the record and is counted (`counts.broken_withdrawn`), and the page says "kept on the record".
- An outside VERIFIED from a withdrawn tool or key is STALE immediately, with `stale_reason: "withdrawn"`.
- An operator's own VERIFIED from a withdrawn tool is not evidence at all: the record is BLIND, not SELF-CHECKED. A withdrawn tool's yes is nothing, whoever ran it.
Recipe withdrawal is not modelled (no recipe field exists in a check record yet). Tests: the four `withdrawn` cases in `test/audit_state.test.js`.

## D3. The freshness comparison is strict less-than, in integer seconds

"CHECKED while its most recent independent VERIFIED is less than 30 days old, compared in integer seconds with no float." At exactly 30 days (2,592,000 seconds) the record is STALE. Tests: `at 30 days minus 1 second -> CHECKED`, `at exactly 30 days -> STALE`, `at 30 days plus 1 second -> STALE`.

## D4. An unreadable or absent OPERATOR_KEYS.json makes CHECKED unreachable

B5 says a result signed by a declared operator key is SELF-CHECKED. It does not say what happens when the declaration cannot be read. If the page treated "no declaration" as "no operator keys", forgetting to publish the file would turn our own daily self-check green. So when `checks/OPERATOR_KEYS.json` is absent, malformed, or unreadable, every key is treated as ours (`ownKeysUnknown`), the page says so in a note, and the best any namespace can reach is SELF-CHECKED. BROKEN still fires. Tests: `outside key but OPERATOR_KEYS unknown -> SELF-CHECKED at most`; `without OPERATOR_KEYS.json an outside key can only reach SELF-CHECKED`.

## D5. Future-dated records: 300 seconds of skew, then refused

The brief asked the verifier to refuse future-dated records. A checker's clock a few seconds ahead of ours is ordinary; a record dated an hour ahead is a claim nobody can have evidence for yet. Default tolerance 300 seconds (`DEFAULT_SKEW_SECONDS`), configurable per call. A refused record is `unverifiable`, counted, and never folded in. Tests: `REFUSE: future-dated beyond skew`; `a future-dated outside VERIFIED is ignored`.

## D6. A record that fails signature, shape, or clock is ignored and counted, never defaulted

The page's B8 day-5 test: "does a record with a missing field RAISE rather than default". In the library, `verifyCheckRecord` returns a refusal (never throws on bad input, so a hostile file cannot crash the page), and `deriveAuditState` drops the record into `counts.unverifiable` with the reason. Dropping is the non-upgrading choice: a malformed VERIFIED is not a VERIFIED. Tests: `a tampered record is ignored`; `a record missing a field is ignored, not defaulted`.

## D7. Unknown fields are refused, top-level and nested

B4 requires the signature to cover every field. Hashing the whole record minus `sig` already does that for any field present, but a verifier that tolerated unknown fields would let a reader trust a field nobody validated. So `validateShape` refuses unknown keys at every level it knows. The consequence is that the schema can only grow with a version bump (`v: 2`), which is the intended cost. Test: `unknown top-level field`, `unknown nested field` in the mutation list.

## D8. The stranger tool scopes its verdict to the namespace, and writes the repo-level verdict into `detail`

`verify.py` returns one `overall` for the whole repository. Today that is BROKEN (65 published records deleted on 2026-08-14/15 under "test cleanup", per `verifier_two/LIVE_RUN.md`). A check record is about ONE record (`target.ref`), so the tool decides per namespace from the results whose subject or file belongs to that namespace, mirroring `verify.py`'s own `overall` rule over that subset. The repo-level verdict goes into `detail` so a namespace VERIFIED is never read as a repo VERIFIED. A namespace deleted at HEAD is refused (nothing to digest), not recorded as BROKEN by a record that cannot name its bytes. Tests: `decide mirrors verify.py overall`; `carries the repo-level verdict`; `an absent namespace is refused`.

Consequence worth stating: verifier two rules `velouria-selftest` BROKEN by its own D2 (a live refused-head observation). A stranger running this tool over the live repo today would produce BROKEN for that namespace. That is verifier two's reading, recorded as such, and it would be a true BROKEN on the page.

## D9. The aggregate line includes STALE

B7's example is "12 records: 9 blind, 3 self-checked, 0 checked, 0 broken." STALE is a state and a count that hides amber is the same lie as one that hides grey, so the rendered line is "N records: a blind, b self-checked, c checked, d stale, e broken." BLIND is still first. Test: `the aggregate names BLIND first`.

## D10. The cadence badge stays, but it follows the audit state

The brief said to render the audit-state badge "instead" of the green "current"; the page (B7) says the row "keeps its cadence badge and gains an audit-state badge beside it". The cadence badge is a true statement about a different axis, so it stays. The finding was that green stood ALONE, so with the flag on the row leads with the audit state and the cadence badge follows it, prefixed "cadence:". Test: `the audit state must come before the green badge`.

## D11. Records are listed from the tree and read up to a budget; over budget is NOT FULLY READ, not a state

A hundred contents reads per render (`MAX_RECORD_READS`) bounds the GitHub API cost. A namespace whose records were not all read renders "NOT FULLY READ" and is excluded from the aggregate's denominator ("2 not fully read" is printed beside it). Deriving CHECKED from a prefix of the evidence could skip a BROKEN; deriving BROKEN from a prefix is fine in principle but the two cases are not told apart here, so neither is derived. Test: `the read budget marks a namespace NOT FULLY READ`.

## D12. A record filed under one namespace but targeting another is evidence for neither

`checks/pin/<ns>/` is a filing convention; `target.ref` is the claim. When they disagree the record is counted as `misfiled` on the namespace it was filed under and ignored for both. Test: `a misfiled record is not evidence for its target either`.

# Slice 2 (2026-09-22, branch `audit-state-slice2`)

Same tie-break: a state is never upgraded without evidence. Tests are in `test/audit_state_slice2.test.js`.

## D13. Outside records arrive by URL through the status reader, not through an endpoint

The design (B8, "Out of slice 1") had a stranger submit a URL that we fetch, re-verify and commit. `api/` holds 12 functions, the Vercel Hobby cap (counted: badge, balance, credit, distill, fulfill, health, latest, pin, renew, status, stripe-webhook, verify), so there is no room for `api/check.js`. Instead the operator lists the stranger's own public location in `WITNESS_CHECK_SOURCES` and `lib/_audit_status.js` reads its `checks/**` on every render, read-only. Nothing is committed to the pins repo, so the part A log does not yet contain these records (a stranger can still hold their own signed file, which is the B4 defense). Test: `api/ is at its 12-function cap`.

## D14. The key decides, not the location

A record fetched from a stranger's URL is judged exactly like one in our repo. A record signed by a key in `OPERATOR_KEYS.json` is SELF-CHECKED at most wherever it was fetched from, and with the declaration unreadable nothing reaches CHECKED (D4 unchanged). A source cannot declare keys or withdraw tools; only our repo's two files can. Tests: `SOURCES NEVER UPGRADE`.

## D15. An unlistable source blanks every namespace, not just "its" namespaces

When a source cannot be listed (HTTP error, truncated tree, budget spent, refused URL), we do not know which namespaces it holds evidence about, and one of those could be a BROKEN. So every namespace renders NOT FULLY READ, with a note naming the source. The cost is real: one dead stranger repo takes every state off the page until the operator removes it from the env var. That is the chosen cost, because the alternative lets a failed read hide a red. A listed record that is not read (budget, size cap, read error) blanks only its own namespace. Tests: `SOURCES FAIL CLOSED`, `SOURCES BUDGET`, `BREAK ARM SOURCES BUDGET`.

## D16. An outside BROKEN from a listed source goes red without being re-run

B9 question 2 (re-run a BROKEN from its public inputs before it flips the badge) is still open for Daniel. Slice 1 could defer it because only the operator committed records; slice 2 lets a listed stranger's BROKEN reach the page. The choice: it goes red, per B3 ("any verifiable BROKEN, from anyone"). The operator's control is the source list itself; a source is listed only after its owner's records have been read by a person. Test: `a source BROKEN goes red`.

## D17. The daily self-check refuses an undeclared key

`tools/self_check_daily.js` will not build a record unless its signing key is in the OPERATOR_KEYS document it is handed. A self-check signed by an undeclared key would read as an outside check, which is our own look painted green (B5, B10 sock puppets). The break arm shows exactly that green appearing when the fence is bypassed. Tests: `DAILY FENCE`, `BREAK ARM DAILY`.

## D18. The JSON twin prints no state for a namespace the page would not derive

With the flag on, `/api/status.json` carries `audit` per namespace and a top-level `audit` summary, both from the same `gatherAuditStates` the page uses. A namespace the page renders NOT FULLY READ carries `state: "NOT_FULLY_READ"` and no counts, dates or keys, so a machine reader cannot pick a state out of a render the page refused to derive. Flag off: no `audit` key and no read of `checks/`. Tests: `JSON FLAG OFF`, `JSON FLAG ON`, `a NOT FULLY READ namespace carries no state word at all`.

# Release tree three (2026-09-23, branch `release-candidate-2026-09-23b`)

## D19. A superseded test namespace keeps its derived state and leaves the totals; no TEST word

The helm's decision on the B10 addendum's item 5: supersede `velouria-selftest` as a test namespace, visibly, rather than leave its BROKEN as the first honest example on the page; its state to read "TEST" if the design's vocabulary allows it without a new verdict word. It does not: B3 has five states and says they are "derived, never set by hand", and D1 makes a BROKEN permanent unless it is shown wrong. "TEST" in the state slot would be a sixth state word set by an operator's declaration, so it was not added; that is a question back to the helm. What was built instead uses only words the record already has: the supersede record (`superseded/<ns>.json`, `lib/_test_ns.js`, create-only, "removes nothing") and a grey tag, the way the cadence column's `retired` tag works. The row keeps its derived state (BROKEN once our self-check records are published, BLIND before), is tagged "superseded test namespace", and is left out of the headline and the aggregate with one sentence naming it and its state. The fail direction is the non-hiding one: a supersede file that cannot be read as a supersede record for that namespace leaves the row counted. Seam worth naming: the record's own `test_namespace` field is `false` for `velouria-selftest`, because that field means "carries a test prefix" (`isTestNamespace`), and `test/no_delete_record.test.js` pins `velouria-selftest` as not test-prefixed; the supersede was made by the deliberate path (`--any-namespace`), and the reason text says test data. The JSON twin does not restate `test_namespace`. Tests: `test/audit_superseded.test.js`.
