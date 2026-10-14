---
title: 'vx on ten real repos'
date: 2026-10-14T20:30:00Z
authors:
  - vzn
tags:
  - correctness
  - comparison
  - migration
excerpt: 'We moved ten open-source monorepos from Turborepo and Nx to vx and diffed every run against the tool they already use: exit codes, output bytes, cache hits, what an edit re-runs. Most matched. Six bugs were ours, and each is fixed.'
---

A synthetic benchmark tells you what a tool costs. It cannot tell you
whether the tool is right on a repo someone else wrote. So we took
open-source monorepos that already run on Turborepo or Nx, moved each
to native vx config with `vx init`, and ran both tools side by side.
The question was not which one is quicker. It was whether vx builds
the same thing, restores the same thing and re-runs the same thing.

## The method

Every repo was pinned to one commit, with its own lockfile and its own
package manager. vx was built from `main` at the time of each run. For
each repo the harness ran:

1. **Cold.** Caches and outputs wiped. The rival ran twice, to learn
   what it does not reproduce against itself. vx ran once.
2. **Restore.** Outputs wiped, caches kept. Every task should be a hit.
3. **Edit.** One file changed. The set of tasks each tool re-runs
   should match.
4. **Clean clone.** A fresh `git clone` at another path sharing the
   cache. Every task should be a hit again.

After each arm it compared exit codes, the sha256 of every untracked
file the run wrote, and hit or miss per task. For `--affected` it made
one committed change per scenario and compared vx's projects with
`turbo ls --affected` or `nx show projects --affected`.

## The repos

| Repo | Commit | Rival | Tasks compared | Result |
| --- | --- | --- | --- | --- |
| create-t3-turbo | 8f945b7 | Turborepo 2.5.8 | `build typecheck`, 11 | parity after two fixes |
| react-email | 1531a39 | Turborepo 2.9.14 | `build`, 4 | parity |
| trpc | d756e59 | Turborepo 2.10.12 | `build`, 7 | parity |
| vueuse | ad2822b | Turborepo 2.10.12 | `build`, 12 | parity (both fail cold) |
| medusa | 5018ab67 | Turborepo 1.13.4 | `build build:plugin`, 83 | parity after two fixes |
| cal.com | 54343aa | Turborepo 2.7.1 | `build`, embeds and platform | parity, one cosmetic diff |
| TanStack query | 817bd02 | Nx 23.2.1 | `build`, 25 | parity |
| vercel/ai | e8c8e32 | Turborepo 2.9.14 | `build`, 82 | parity |
| documenso | d4e6eeaf | Turborepo 2.10.5 | `--affected`, 9 commits and working-tree edits | parity |
| typescript-eslint | 57e7cccce | Nx 23 | `--affected` | after one fix, vx never selects less |

An eleventh, n8n, never got that far: its `pnpm install` could not
fetch a tarball through our runner's network policy.

## Where they matched

On react-email, TanStack query and vercel/ai, every arm agreed. trpc
agreed on cold, restore and edit; it had no clean-clone arm.
vercel/ai is the largest: 82 packages, 783 tasks written with no
`TODO` left, identical output trees (0 name and 0 byte differences),
82 of 82 hits on restore and on a clean clone, and the same re-run set
for a source file, a `package.json`, a README, a `tsconfig.json`, a new
test file, a deleted `CHANGELOG.md` and three environment variables.
TanStack query came from Nx's resolved project graph: 614 tasks, no
`TODO`, identical cold trees, 25 of 25 hits on restore and clone, and
the same one hit and 24 runs after an edit to `query-core`.

Some differences were the same under both tools. Next.js names chunks
nondeterministically, so react-email's trees differ between two Turbo
runs too. A file no task declares as an output, like a `next-env.d.ts`
or svelte-kit's intermediates, is not restored by either.

## Where vx was worse, and what we fixed

Six problems were ours, and each fix is merged.

- **Ordering edges that should not exist.** A `main`-only change, never
  released, ordered a task after any task writing a file it reads. On
  create-t3-turbo it counted a file the inputs excluded, so every build
  waited for `prettier --check`, which then failed on the config vx had
  just written: 10 tasks skipped where Turborepo passed 11 of 11.
  cal.com got the same extra edges. The change was reverted
  ([#3514](https://github.com/vznjs/vx/pull/3514)).
- **Written configs that broke the repo's own checks.** On medusa,
  `vx init`'s `vx.config.ts` failed two plugin builds with TS1541 (a
  CommonJS package importing a type from an ES module), and on
  create-t3-turbo it failed the repo's formatter. `vx init` now writes
  `.mts` where the package needs it and formats what it writes
  ([#3526](https://github.com/vznjs/vx/pull/3526)). medusa now passes
  83 of 83 under both tools.
- **Tasks mapped as uncached.** Six medusa builds read committed files
  under their own outputs, so the mapping left them uncached and a
  restore ran them again: 75 hits to Turborepo's 81. vx now never
  deletes a committed file under an output and keeps those tasks cached
  ([#3514](https://github.com/vznjs/vx/pull/3514)); restore is now 83 of 83 under both.
  On create-t3-turbo, `build` and `typecheck` share one
  `tsbuildinfo` file, which left three typechecks uncached; that is
  fixed too ([#3478](https://github.com/vznjs/vx/pull/3478)).
- **A glob that matched less than Turborepo's.** Turborepo's `*/**`
  also matches a package's root files; the mapped glob did not, so
  medusa's restore left one `tsconfig.tsbuildinfo` out. Outputs and
  inputs now match as Turborepo does
  ([#3542](https://github.com/vznjs/vx/pull/3542),
  [#3543](https://github.com/vznjs/vx/pull/3543)). We checked Nx too:
  its hasher does not let a trailing `/**` match zero segments, and
  `nx()` already agrees with it.
- **An empty task that stopped every command.** On typescript-eslint,
  init wrote an empty `nx-input:default` task, and every vx verb then
  refused the config. It no longer writes one
  ([#3541](https://github.com/vznjs/vx/pull/3541)).
- **A wrong next step.** With `--no-install`, init skipped writing the
  lock but still suggested `vx run build --all`, which stops with "no
  lock". It now names `vx lock`
  ([#3552](https://github.com/vznjs/vx/pull/3552)).

One more is a habit, not a bug. A harness that wipes `.vx` the way it
wipes `.turbo` or `.nx` deletes `.vx/workspace.ts` too, and vx then
stops with "no .vx/workspace.ts". Wipe `.vx/cache`, or run
`vx cache clean`.

## Where they differ on purpose

- **A `pnpm-workspace.yaml` edit** re-keys every task under vx and none
  under Turborepo 2.9.14. The workspace file changes what the workspace
  is, so vx counts it. That is coarse, but it is never stale.
- **A lockfile edit that changes nothing**, like a comment in
  `pnpm-lock.yaml`, marks every package affected under Turborepo and
  none under vx: vx parses the lockfile and keys each project on its
  own dependency closure.
- **Root files.** vx lists the root project when a root or tools file
  changes; `turbo ls --affected` never lists the root.
- **Task edges.** On typescript-eslint, vx sometimes selects more than
  `nx show projects --affected`. Every package's `lint` depends on the
  repo's own `typescript-eslint#build`, so a change there really does
  change each lint's key. Nx answers per project and misses it.
- **`turbo.json` and `nx.json`** are not read after `vx init`: their
  settings are in the written configs.

Two runs failed under both tools for reasons outside either: a cal.com
package whose `npx rimraf` hit a certificate error through our proxy,
and vueuse, whose build reads a file only the repo's own script
generates first. cal.com's Prisma client also came out with the same
JSON keys in another order under vx; that is noted, not fixed.

## Try it on yours

```bash
npx @vzn/vx init
npx @vzn/vx run build --all
```

`vx init` writes native config beside `turbo.json` or `nx.json`. If a
run differs from your current tool, `vx why <project>#<task>` names
what moved in a task's key. Every problem above started as a diff like
that. More at [vznjs.github.io/vx](https://vznjs.github.io/vx/).
