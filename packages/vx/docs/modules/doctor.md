# `orchestrator/doctor.ts` — the workspace doctor's facts

## Purpose

One collector for what `vx info` prints and its `--format json`
returns: the CLI renders, this gathers.

```ts
collectInfo(cwd, opts?: CollectInfoOptions): Promise<InfoFacts> // { cacheDir?, warn? }
stableSandboxReason(reason: string): string // the probe's reason with the pid-named socket path masked
```

`InfoFacts` is the typed object `vx info --format json` prints: `vx`,
`vxPath` and `handedOffFrom` (which vx ran, and the global one that
handed it the call, `handoff.md`), `bun`, `bunSupported` (false below `MIN_BUN` — `bun` itself stays the
bare version because this is a machine surface, and the prose goes in
the rendered row only), `git`, `gitStatusCache`, `workspaceRoot`,
`projects`, `tasks`,
`plugins` (`[{ name, seams }]`, the seams in `PLUGIN_HOOKS` order),
`workers` (`{ count, source, cores, cpuQuota }`), `memory`
(`{ usableBytes, totalBytes, cgroupLimitBytes }`), `cacheDir`,
`cacheVersion`, `schemaVersion`, `cacheEntries`, `cacheBytes`,
`settings` (`{ [path]: { value, source } }`),
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
  run uses (`loadProjects` over the lock, plugin `project` stage
  applied). The doctor evaluates no config: with no lock, or one a run
  would refuse, the task and sandbox counts are zero and `lockfile` is
  the answer — a broken config is `vx lock`'s to report.
- **The machine as the process may use it.** `workers` and `memory` read
  `util/cgroup.ts`, so inside a container they say what the cgroup
  allows and name it as the source.
- **`cache.dir` follows the run's rule**: an override resolves against
  `cwd` exactly as `vx run --cache-dir` does, else the workspace's.

## Tests

`tests/show-info.test.ts` (the rows and the JSON facts end to end, the
`--cache-dir` override, the orphans row); `tests/info-lock.test.ts` (no
lock, and a config edited after the lock, are never evaluated).
