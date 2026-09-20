# Stamps: their own record, their own token

Status: **built on branch `stamp-own-repo`, NOT deployed, and the stamps repository does not exist yet.** Creating it is the owner's step, by hand — see the checklist.

File stamps (`POST /api/stamp`) write to a **separate public repository** from the witness pins, using a **separate write token**. This file is the operating manual for that separation: the env vars, what to do to go live, and what each step is protecting.

---

## The env vars

| Variable | Required | Default | What it is |
|---|---|---|---|
| `STAMP_REPO` | **yes** | *(none)* | The stamps record repository, `owner/name`. No default on purpose — a default is a fallback, and a fallback is how a stamp ends up somewhere it does not belong. |
| `STAMP_TOKEN` | **yes** | *(none)* | The write token for that repository, and only that repository. Never read from `GITHUB_PIN_TOKEN`. |
| `STAMP_BRANCH` | no | `main` | The branch stamps commit to. |
| `STAMP_FREE_PER_DAY` | no | `3` | Free stamps per client address per UTC day. **`0` makes every stamp paid.** |
| `STAMP_DAILY_CAP` | no | `500` | Global stamps per UTC day for the whole deployment, kept in the store so it holds across serverless instances. |
| `STAMP_SITE_BASE` | no | `https://arcaeon.io` | Base for the `permalink` in a stamp response. |

The price per stamp is **not** an env var. It is one constant, `STAMP_PRICE_CREDITS` in `lib/_stamp.js`, and changing it is a code change with a changelog line. A price that can be moved by editing a dashboard field is not a promise.

### What happens when the stamp env is missing

Every mode of the endpoint returns **503** and writes nothing — not to the stamps repo, not to the pins repo, not even a read. The response names the missing variables. There is no fallback path to the pins repository anywhere in the code, and `lib/_stamp_store.js` additionally **refuses** a `STAMP_REPO` that has been set, by hand, to the pins repo (`reason: "stamp_repo_is_pins_repo"`). One env typo must not merge the two records.

---

## Go-live checklist (the owner's steps, in order)

**1. Create the public repository.**
Empty, public, one initial commit. The name is the owner's call (`arcaeon-file-stamps` reads well next to `arcaeon-witness-pins`).

*Protects:* the account, the visibility and the name stay human decisions. No script in this repo creates a repository, and none ever should — a tool that can create the record it writes to can also create the wrong one.

**2. Create a fine-grained personal access token scoped to that repository ONLY.**
Repository access: *only select repositories* → the new stamps repo. Permissions: **Contents: Read and write**. Nothing else. Do not reuse `GITHUB_PIN_TOKEN`, and do not paste the stamps token into `GITHUB_PIN_TOKEN`.

*Protects:* the blast radius. A stamp is a public, near-unauthenticated write, which makes the token behind it the most exposed credential in the service. Scoped this way, the worst day for stamps cannot touch a single pinned head. (If the two tokens are set to the same value, the service logs a loud warning at first use — it cannot see a token's scope, so it says so rather than guessing.)

**3. Set the environment in Vercel.**
`STAMP_REPO`, `STAMP_TOKEN`, and `STAMP_BRANCH` if the default branch is not `main`. Leave `STAMP_FREE_PER_DAY` unset for three free a day, or set it to `0` to make every stamp paid.

*Protects:* nothing is stamped before the destination exists. Until these are set the endpoint is a clean 503, which is a better failure than a stamp written to a guess.

**4. Record the stamps log's birth in the pins log.**

```
# in the new stamps repo
git rev-list --max-parents=0 HEAD            # the first commit SHA
git log -1 --format=%cI <that sha>           # its committer date

# back in arcaeon-witness — DRY RUN first, it is the default
node tools/stamp_genesis.js --sha <40-hex> --date <iso8601> --repo <owner/stamps-repo>

# read what it printed, then, once it is right:
GITHUB_PIN_TOKEN=... node tools/stamp_genesis.js --sha <40-hex> --date <iso8601> \
    --repo <owner/stamps-repo> --commit
```

*Protects:* the new log's claimed age. A brand-new repository is exactly as old as its first commit, and that commit's date is whatever its creator's machine says it is — nothing outside it vouches for when it began. The genesis record puts that first commit's SHA and date into the **older** pins repository, as its own commit, timestamped by GitHub in a history that already has months of public life behind it. From then on the stamps log has a fixed point in an older record, and a later change to either side would show in the public commit history of the repository it lives in.

The write is **create-only**. If a genesis record already exists at that path the tool refuses rather than replacing it: a birth record that can be overwritten is worth nothing.

**5. Deploy.**
`vercel.json` already rewrites `/api/stamp` onto `/api/verify?op=stamp` — the deployment is at the Vercel Hobby 12-function cap, so the stamp handler is a mode on an existing function rather than a file of its own. No new function is added by this branch.

*Protects:* the deploy does not get refused at the cap, which is what happened the last time a 13th function was added (`9e8b060`).

**6. Watch the first day.**
`STAMP_DAILY_CAP` bounds a bad day to 500 writes. The free allowance is per-address and per-instance (see below); if it is being worked around, the lever is `STAMP_FREE_PER_DAY=0` and no deploy is needed.

---

## What the metering actually is

```
repeat of a fingerprint already stamped  ->  free, forever, no write, NO DEBIT
first 3 per address per UTC day          ->  free
beyond that                              ->  witness key + 0.25 credits, debited
                                             from the SAME prepaid balance pins spend
all of the above                         ->  under the global daily cap
```

**The free allowance is a soft limit and the word is exact.** It lives in module scope on one warm serverless instance, so the real ceiling is (instances x 3), not 3; a cold start resets it; and the identity is `x-forwarded-for`, which is an address, not a person — a phone gets a new one by toggling airplane mode, and a household behind one NAT shares one allowance. It makes casual over-use cost effort and it makes the first three stamps free for a real person. That is what it is for. The fence that holds under attack is the global daily cap (store-backed, cross-instance, fail-closed) plus `STAMP_FREE_PER_DAY=0`.

**Money never moves for a stamp that did not land.** The balance is *checked* before the write (a read, so an insufficient balance refuses before anything is written) and *debited* after the write is confirmed. A failed write, a lost create race, a refused daily cap and a repeat stamp all charge nothing, and each of those sentences has a test with a must-fail arm.

**The price is not ratified.** `STAMP_PRICE_CREDITS = 0.25` is a placeholder with an argument attached, not a decision. Pricing authority for this lane is the owner's partner's, and the number goes to him with its math (which is written out in full in `lib/_stamp.js` above the constant, and in the changelog entry).

---

## What a stamp claims, and what it does not

Unchanged by any of this, and shipped in every response as `scope`:

- **Shows:** a file with exactly this SHA-256 fingerprint was recorded no later than the time of the public commit that holds the stamp. A change to that record would show in the repository's public commit history.
- **Does not show:** who made the file; that anything the file says is true; that no other version exists; that the file is older than the stamp by any particular amount.

The record holds a fingerprint, an optional byte count, a kind, a version and a timestamp. **No filename and no label, and an extra field is refused with a 400 rather than dropped** — the store is public, a filename is content, and a caller who sends one would otherwise believe it was recorded.
