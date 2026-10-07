# `orchestrator/doctor.ts` — the workspace doctor's facts

## Purpose

One collector for what `vx info` prints and what `@vzn/vx-mcp`'s
`getWorkspaceInfo` returns, so the verb and the agent tool cannot
disagree: the CLI renders, this gathers.

```ts
collectInfo(cwd, { cacheDir?, warn? }): Promise<InfoFacts>
stableSandboxReason(reason: string): string // the probe's reason with the pid-named socket path masked
```

`InfoFacts` is the typed object `vx info --format json` prints: `vx`,
`bun`, `bunSupported` (false below `MIN_BUN` — `bun` itself stays the
bare version because this is a machine surface, and the prose goes in
the rendered row only), `git`, `gitStatusCache`, `workspaceRoot`,
`projects`, `tasks`,
`configErrors` (`[{ path, message }]`, the configs that did not load),
`plugins` (`[{ name, seams }]`, the seams in `PLUGIN_HOOKS` order),
`workers` (`{ count, source, cores, cpuQuota }`), `memory`
(`{ usableBytes, totalBytes, cgroupLimitBytes }`), `cacheDir`,
`cacheVersion`, `schemaVersion`, `cacheEntries`, `cacheBytes`,
`orphans`, `runs24h`, `hits24h`, `restored24h` (of those hits, the ones that restored outputs), `flakyTasks`, `lockfile`, `sandbox`
(`{ available, reason, declared, untraced }`: whether this host can run
an `exec.sandbox`, the probe's reason, how many loaded tasks declare
one, and why an available Linux sandbox cannot report the reads it
denies, else null). See
`docs/cli.md` § `vx info` for what each row means.

## Rules

- **The sandbox probe runs under the loads.** It asks nothing of the
  workspace, so it starts once the root and the workspace config are
  found (a refusal there comes first, with no probe ahead of it) and is
  awaited on every path, since the runtime it brings up holds the
  process open until it resets. The two git facts are asked while it
  runs: 113.8 → 107.3 ms median for `vx info` at 100 projects.

- **The task count is the run's.** It comes from the same staged load a
  run uses (`loadProjects`, plugin `project` stage applied); a config
  that fails to load counts as zero and never fails the doctor — the
  rest then load one project at a time through the same `loadProjects`,
  so a plugin's tasks still count — and is named in `configErrors`, with
  the message `vx run` stops on, because a `0
tasks` that hides a typo is the fact a bug report needs.
- **The machine as the process may use it.** `workers` and `memory` read
  `util/cgroup.ts`, so inside a container they say what the cgroup
  allows and name it as the source.
- **`cacheDir` follows the run's rule**: an override resolves against
  `cwd` exactly as `vx run --cache-dir` does, else the workspace's.

## Tests

`tests/show-info.test.ts` (the rows and the JSON facts end to end, the
`--cache-dir` override, the orphans row) and `@vzn/vx-mcp`'s server test
(`getWorkspaceInfo` returns the same facts over the wire).
