# `orchestrator/doctor.ts` — the workspace doctor's facts

## Purpose

One collector for what `vx info` prints and what `@vzn/vx-mcp`'s
`getWorkspaceInfo` returns, so the verb and the agent tool cannot
disagree: the CLI renders, this gathers.

```ts
collectInfo(cwd, { cacheDir?, warn? }): Promise<InfoFacts>
```

`InfoFacts` is the typed object `vx info --format json` prints: `vx`,
`bun`, `git`, `gitStatusCache`, `workspaceRoot`, `projects`, `tasks`,
`plugins` (`[{ name, seams }]`, the seams in `PLUGIN_HOOKS` order),
`workers` (`{ count, source, cores, cpuQuota }`), `memory`
(`{ usableBytes, totalBytes, cgroupLimitBytes }`), `cacheDir`,
`cacheVersion`, `schemaVersion`, `cacheEntries`, `cacheBytes`,
`orphans`, `runs24h`, `hits24h`, `flakyTasks`, `lockfile`. See
`docs/cli.md` § `vx info` for what each row means.

## Rules

- **The task count is the run's.** It comes from the same staged load a
  run uses (`loadProjects`, plugin `project` stage applied); a config
  that fails to load counts as zero and never fails the doctor.
- **The machine as the process may use it.** `workers` and `memory` read
  `util/cgroup.ts`, so inside a container they say what the cgroup
  allows and name it as the source.
- **`cacheDir` follows the run's rule**: an override resolves against
  `cwd` exactly as `vx run --cache-dir` does, else the workspace's.

## Tests

`tests/show-info.test.ts` (the rows and the JSON facts end to end, the
`--cache-dir` override, the orphans row) and `@vzn/vx-mcp`'s server test
(`getWorkspaceInfo` returns the same facts over the wire).
