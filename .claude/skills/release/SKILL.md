---
name: release
description: Cut a vx release on demand. Use when asked to release, and for the daily release routine. Writes the release's blog post, merges it, dispatches auto-release.yml, and shares the post on Bluesky.
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
`packages/vx-docs/src/content/docs/blog/vx-0-0-*.md` (the model). Write
`blog/vx-0-0-<N+1>.md` from `git log $last..origin/main`:

- At most ten changes a user would notice; skip internals, tests,
  refactors, docs, CI. Verify every command, flag and config key in an
  example against current source; prefer real output from a fixture
  run of `bun packages/vx/src/bin.ts …` in the scratchpad.
- Title `vx 0.0.<N+1>: <two or three headline changes>`, date today,
  tag `release`, an excerpt, an intro, `**In this release**` links,
  one `##` per change with one example and its PR links,
  `## Breaking changes` when any, then How to update and Learn more as
  the last post has them.
- Rules the site tests hold: speed as "N× faster" or "from X to Y",
  never percentages; no benchmark tables; no `--` at the start of a
  heading; never say vx runs or works in a Turbo or Nx repo (it maps
  them; migration is a start toward native config); config samples
  import from `@vzn/vx/config`.

Gate the docs (`bun packages/vx/src/bin.ts run @vzn/vx-docs#ci`), then
open a PR `docs(vx-docs): release post for v0.0.<N+1>` and squash-merge
it once CI is green.

## 3. Release

Wait for `main`'s CI to go green on the merge commit, then dispatch
`auto-release.yml` on `main` with `sha` = that commit (GitHub MCP
`actions_run_trigger`).
It refuses a commit CI did not pass. Confirm the tag is the version the
post names; if another release landed first and the number moved, rename
the post in a follow-up PR before sharing it.

Then wait until the release is published (`release.yml` publishes the
draft after its last upload) and the post is live at
`https://vznjs.github.io/vx/blog/vx-0-0-<N+1>/` (`docs.yml` deploys
main).

## 4. Share on Bluesky

The @vzn-vx.bsky.social account and its scripts live in the project's
shared folder, `/mnt/project-files/x-posts/_source/` (its README §
Posting to Bluesky). Post one short line on the headline changes plus
the post's URL, under 300 graphemes, no hype words, speed as "N×
faster":

```sh
NODE_USE_ENV_PROXY=1 node /mnt/project-files/x-posts/_source/bsky-api.mjs post "<text>" https://vznjs.github.io/vx/blog/vx-0-0-<N+1>/
```

## 5. Report

One line in the project thread that asked (or the routine's thread):
the version, the post link, the Bluesky post link.
