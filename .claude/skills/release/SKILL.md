---
name: release
description: Cut a vx release on demand. Use when asked to release, and for the daily release routine. Writes the release story, merges it, dispatches auto-release.yml, and shares the post on Bluesky.
metadata:
  internal: true
---

# Release vx

Releases are on demand (owner, 2026-10-08): at least once a day when
`main` has changes, and whenever someone asks. Each release gets a blog
post, and the post is shared on Bluesky. Nothing here is skipped.

## 1. Is there anything to release?

```sh
git fetch origin main --tags
last=$(git tag -l 'v*' --sort=v:refname | tail -1)
git log --oneline "$last..origin/main"
```

No commits: stop, nothing to release. Below 0.1.0 the next version is
always a patch: `v0.0.N` → `v0.0.N+1` (`scripts/release-notes.ts`,
`nextVersion`). From 0.1.0 read `nextVersion` for the rule.

## 2. Write the post

Read `packages/vx-docs/README.md` § Release posts and the newest
`packages/vx-docs/src/content/docs/releases/vx-0-0-*.md` (the model).

The post is built from the change files, not from PR titles (owner,
2026-10-15: "each PR should be like a real release doc. So later on docs
should just combine them into 1 doc and merge what's common"). Every
user-facing PR in `git log $last..origin/main` has a file in
`/mnt/project-files/org/changes/` written to `TEMPLATE.md` there: a
capability heading, why it exists, how it works now, an example with
its real output, breaking changes, and what it was verified against.

1. List the range's PRs and match each user-facing one to its change
   file. A missing file, or one lacking any template part, blocks the
   release: send it back to its owner (through the EA) and wait.
2. Verify every claim yourself against the source, `cli.md` or
   `schema.md` at the commit you release (`git show <sha>:<path>`).
   PR titles and change files are leads, not facts (a PR title is how
   "p50" got into v0.0.637's forecast). Re-run each example on that
   commit in the scratchpad (`git worktree add <dir> <sha>`, then
   `bun <dir>/packages/vx/src/bin.ts …` in a fixture repo) and paste
   the output it prints. Use only commands a user would type; flag any
   example command longer than a short line to the EA.
3. Merge: change files that share a capability become one section;
   smaller ones become Other noteworthy changes; every Breaking changes
   list joins into one, last.
4. List the doc line or test behind each section in the PR body
   (`Verified against`).

The post is a release story, not a changelog (owner, 2026-10-15:
"not a changelog but explaining reasons and presenting the feature,
like Home Assistant releases"). Fewest words; no speed claims; never
"best". Its shape:

- Title = what vx can now do overall, not one feature (owner,
  2026-10-15: "not focusing one particular feature but the new overall
  capabilities"): `Any language, one lock, a cache PRs share`. It is
  the cover's `head` without its `[brackets]`. The version is not in
  the title; the Releases page shows it as a `v0.0.<N+1>` chip, read
  from the slug. Date today, tag `release`, an excerpt naming the same
  capabilities.
- Intro: a few sentences on what vx can now do and why, a pointer to
  Breaking changes when there are any, then `**In this release**` links.
- One `##` per capability, at most five, each titled by what the user
  gets (`Pull requests reuse main's cache`, not a flag name): the
  problem it solves, how it works now, an example with its real output,
  then a link to its guide or blog post. No PR numbers: the GitHub
  release links the commits.
- A feature big enough to show gets its own blog post first (owner,
  2026-10-08), and its row in `packages/vx/docs/features.md` links it.
- `## Other noteworthy changes`: one bullet each for the smaller
  user-visible changes. Skip internals, tests, refactors, docs, CI.
- `## Breaking changes`, short, at the end: one bullet per `old → new`
  rename or removal in the range (owner, 2026-10-14; until 1.0 the code
  keeps no aliases or rename notices, so this list is the only notice),
  and a link to [Upgrading](../../guides/upgrading/).
- `## How to update`: only a `frame="terminal"` block with `vx upgrade`
  (owner, 2026-10-18: upgrading is always `vx upgrade`).
- Rules the site tests hold: speed as "N× faster" or "from X to Y",
  never percentages; no benchmark tables; no `--` at the start of a
  heading; never say vx runs or works in a Turbo or Nx repo (it maps
  them; migration is a start toward native config); config samples
  import from `@vzn/vx/config`.

- Show, don't tell (owner: "viz is better than words"): every
  example in a `frame="terminal"` block, a mermaid flowchart where a
  change has a shape. No tables.
- Cover: add the version to
  `/mnt/project-files/org/docs-site/release-covers/covers.json` (date,
  headline with one `[accented]` phrase, up to 8 terminal lines), run
  `node render.mjs /home/user/vx <N+1>` there, and set the post's
  `cover: { image: ../../../assets/blog/vx-0-0-<N+1>.png, alt }`. Look
  at the PNG before committing it.
  The cover is the page's og:image (the link-preview banner); a new
  essay's is `public/blog/covers/<slug>.png` at 1200×630
  (`node /mnt/project-files/org/docs-site/og-cover.mjs <repo> <slug>`).
  `tests/og-image.test.ts` fails the gate when a post or release has none.

Gate the docs (`bun packages/vx/src/bin.ts run @vzn/vx-docs#ci`), then
open a PR `docs(vx-docs): release post for v0.0.<N+1>`. No release post
publishes unreviewed (owner, 2026-10-15: "ensure this won't happen
again"): send the PR to Marketing for sign-off and to the EA to read,
and squash-merge only with Marketing's ✓, the EA's go and CI green.

## 3. Release

Wait for `main`'s CI to go green on the merge commit, then dispatch
`auto-release.yml` on `main` with `sha` = that commit (GitHub MCP
`actions_run_trigger`).
It refuses a commit CI did not pass. The GitHub release's body is the
post (`scripts/release-notes.ts`, `postNotes`); a later edit of the post
on main rewrites it (`release-notes.yml`). Confirm the tag is the version the
post names; if another release landed first and the number moved, rename
the post in a follow-up PR before sharing it.

Then wait until the release is published (`release.yml` publishes the
draft after its last upload) and the post is live at
`https://vznjs.github.io/vx/releases/vx-0-0-<N+1>/` (`docs.yml` deploys
main).

Then check npm has it: `curl -s https://registry.npmjs.org/@vzn%2fvx | jq -r '."dist-tags".latest'`
must print the new version. `npm.yml` runs on the published release; if
it failed or a job was cancelled (a macOS runner that never started),
dispatch `npm.yml` on `main` with `version: <N+1>` and `ref: v<N+1>`, and
share nothing until npm has it.

## 4. Share on Bluesky

The @vzn-vx.bsky.social account and its scripts live in the project's
shared folder, `/mnt/project-files/org/marketing/x-posts/_source/`, owned by the
Marketing thread (its README § Posting to Bluesky). One release post a
day at most, plain and factual: what changed in one line, no hype words,
speed as "N× faster" from 2× up and as a percentage below 2×, under 300 graphemes. The link goes in the card,
not the text. The site is out of the proxy's reach, so pass the card's
title and description (the post's title and excerpt) and the cover as
the card image, or the card shows no picture:

```sh
cd /mnt/project-files/org/marketing/x-posts/_source
NODE_USE_ENV_PROXY=1 node bsky-api.mjs post "<text>" https://vznjs.github.io/vx/releases/vx-0-0-<N+1>/ --title "vx <version>: <post title>" --desc "<excerpt>" --thumb <repo>/packages/vx-docs/src/assets/blog/vx-0-0-<N+1>.png --dry
```

Read the `--dry` record, then run it again without `--dry`. It logs to
`posted.json` and `activity-log.md` and refuses a second post of a URL.

## 5. Report

One line in the project thread that asked (or the routine's thread):
the version, the post link, the Bluesky post link.
