# Workstream V — the all-cached run (2026-10-06)

The owner's ask, with a `VX_TIMING=1` table of an all-cached run of this
repo (`vx run build --all`, 16 keys, 107 ms on macOS): "optimize these".
Measured here on Linux with the compiled binary, `run build --all` in two
worktrees of this repo (one per arm, each warmed by its own binary),
fifteen interleaved rounds, min and median per stage. A git config that
weakens stat (`core.checkStat=minimal`) hashes every input from disk, so
the rounds run with `GIT_CONFIG_GLOBAL=/dev/null`.

| stage            | before (min / med) | after (min / med) |
| ---------------- | ------------------ | ----------------- |
| load configs     | 14.2 / 16.5        | 1.9 / 2.2         |
| classify + probe | 20.8 / 23.6        | 16.0 / 17.7       |
| run graph        | 17.3 / 23.6        | 12.6 / 14.2       |
| whole run        | 127.2 / 135.9      | 96.4 / 107.1      |

- **V-1.** Two configs were evaluated on every run: the eval cache's
  purity scan counts every `import` word and refuses a file whose count
  its import forms do not account for, and vx-docs declares a task named
  `import`. `import` followed by `:` is a property key, which no import
  form spells, so it is no longer counted. vx-bench's regex literal (the
  scan refuses any bare `/`) became a string replace. Row:
  `config-cache.test.ts` (a key named `import` is keyed; a member named
  `import` still fails closed).
- **V-2.** `@vzn/vx-mcp` imported its server at load, and every run
  evaluates `vx.workspace.ts`: ~12 ms of the workspace config stage. The
  verb imports it now.
- **V-3.** The filter gate's `git check-attr` waited for `git status`, the
  one spawn that walks the tree, and ran after it (~8 ms here; this repo's
  root `.gitattributes` sets a merge driver). When the index listing alone
  shows an attributes file, it starts beside status. Row:
  `stale-hit.test.ts` (status is held until check-attr starts; the old
  order times out).
- **V-4.** With a telemetry plugin declared, every run spawned git twice in
  series for the run context (~7 ms): `config --get remote.origin.url` and
  `symbolic-ref` for origin/HEAD. The URL is the enumeration's own
  `git var -l`; origin/HEAD is read from its ref file as HEAD already was.
  Each falls back to the spawn. Rows: `run-context.test.ts` (no spawn,
  linked worktree included; a workspace below the repo root still asks).
- **V-5.** A literal output naming a file refused the directory snapshot,
  so its task walked its output glob on every warm hit: vx-docs' `import`
  and `build.playground`. The prefix is recorded as a file (`mtime_ms`
  -2) and holds while a regular file stands there. Rows:
  `output-dirs.test.ts` (recorded and skipped; a tampered file and a
  directory in its place still restore).
- **V-6.** Every input file was matched against its task's globs one
  `Bun.Glob` call each (positives, seven always-ignored, negatives), and
  each literal against every file: ~3.7 µs a file, 6.8 ms of CPU under
  `stable keys` here. A task glob without a brace, escape or leading `!`
  is a RegExp now, a side's list one RegExp, and a literal a binary
  search with the walk as its fallback; CPU there 12.2 → ~6 ms. The wall
  barely moved: what is left is cold code and GC. Rows: `util-paths.test.ts`
  (RegExp and list agree with `Bun.Glob` on 50 patterns × 70 paths; no
  native call), `inputs-resolution.test.ts` (a sibling sorting between a
  directory literal and its tree).
- **V-7.** `@vzn/vx-lockfile` loaded all four parsers and `prune` at
  import, and every run evaluates `vx.workspace.ts`: ~2.5 ms for a
  workspace that declares one manager. A parser loads (`require`, the
  digest seam is sync) when its manager first digests, `prune` when the
  verb runs. Row: `vx-lockfile/tests/lazy-load.test.ts`.

Left: `workspace config` is mostly the plugin packages' transpile, half of
it `@vzn/vx-otel` (owned by another thread); `git enumeration` is now the
wait for `git status` it overlaps.
