# Task execution lifecycle

This document traces what happens between `vx run build` typed at the
terminal and a task succeeding or failing.

## End-to-end timeline

```
 ┌─ CLI dispatch (cli.ts, cli/run.ts)
 │    argv → { task, projects, concurrency, noCache, ignoreDependsOn,
 │             forwardArgs, verbose }
 │
 ├─ Workspace setup (orchestrator.ts:run)
 │    1. findWorkspaceRoot from process.cwd — walks up; first match
 │       wins across pnpm-workspace.yaml, package.json with a
 │       `workspaces` field (npm/yarn/bun), or a bare package.json
 │       (single-project mode).
 │    2. loadWorkspace (parses the appropriate manifest via Bun.YAML
 │       / Bun.file().json()).
 │    3. listProjects (glob package.json files, find vx.config.* siblings,
 │                     detect duplicate names).
 │    4. loadProjectConfig for each project that has a config — native
 │       Bun `await import()` with a content-hash query-string bust
 │       so config edits are picked up across runs.
 │    5. buildPackageGraph from package.json deps.
 │    6. computeNestedProjectDirs (for boundary enforcement).
 │    7. computeWorkspaceFingerprint (hash every supported lockfile +
 │       pnpm-workspace.yaml at the root: pnpm-lock.yaml,
 │       package-lock.json, npm-shrinkwrap.json, yarn.lock, bun.lock,
 │       bun.lockb).
 │
 ├─ Task graph (graph/task-graph.ts:buildTaskGraph)
 │    Starting from requested {project, task} pairs, walk dependsOn:
 │      - self entries are added in the same project
 │      - dependencies entries are added in each transitive workspace dep
 │    Detect cycles. Each node carries id, projectName, projectDir, taskName,
 │    config, sorted deps.
 │
 ├─ Scheduling (graph/scheduler.ts:runGraph)
 │    Up to N tasks concurrently, ordered topologically.
 │    For each ready node, call execute(node, upstream) → outcome.
 │    If a task fails, its dependents are marked skipped; independent siblings
 │    continue.
 │
 └─ Per-task execution (orchestrator/execute-task.ts:executeTask)
      1. Group task short-circuit — if node has no `exec`, return
         success with a derived hash (rolled up from upstream); no
         spawn, no I/O.
      2. Resolve inputs.files (gitignore-aware, boundary-aware,
         own-outputs-excluded).
      3. Resolve inputs.env values (read host process.env for listed names).
      4. Hash the resolved task config (post-evaluation).
      5. Hash the project's package.json (Turbo/Nx implicit dependency).
      6. Filter upstream cache hashes per cache.inputs.tasks.
      7. Compute cache key from (2) + (3) + (4) + (5) + (6) +
         workspaceFingerprint + taskId + forwardArgs.
      8. If cache enabled (task declares a `cache` block AND
         --no-cache is not set): try cache.get(key)
         - Hit → cleanOutputs (declared globs) → restoreOutputs from
           entry → replay captured logs → return cache-hit (durationMs
           is the wallclock for the restore op, not the original exec).
         - Miss → fall through, but first cleanOutputs (so stale files
           from a prior build don't survive a fresh exec).
      9. Build isolated env (essentials + exec.env.passThrough values
         + exec.env.define values + `<projectDir>/node_modules/.bin`
         prepended to PATH).
     10. spawn shell with exec.command (exec/runner.ts:runCommand,
         using Bun.spawn for resource usage capture), with any CLI
         forwardArgs appended (shell-quoted).
     11. Buffer chunks via onStdout / onStderr (the logger flushes
         them as one framed block on taskComplete).
     12. If exit == 0 and cache enabled:
         a. Resolve outputs.files.
         b. cache.save: copy outputs into <hash>/outputs/<rel>,
                        write stdout/stderr to <hash>/stdout and
                        <hash>/stderr, upsert the SQLite row.
     13. Return TaskOutcome { node, status, exitCode, durationMs, hash,
         stdout, stderr, cpuMs?, peakRssBytes?, wallclockStartNs?,
         wallclockEndNs? }.
```

## One command per task

`exec: ExecConfig` is a single shell command — there is no multi-step
sequence. If you need to chain commands, use shell composition (`&&` or
`;`) or split into separate tasks linked via `dependsOn.self`. Per-task
caching only happens at task granularity; splitting into smaller tasks
gives you per-step caching naturally.

## Env isolation

The child process gets, in priority order (lowest first):

1. Essential allowlist (`PATH`, `HOME`, `SHELL`, `TMPDIR`, `LANG`,
   `TERM`, `COLORTERM`, `FORCE_COLOR`, `NO_COLOR`, `CI`, `NODE_OPTIONS`,
   plus Windows essentials like `SYSTEMROOT`).
2. `exec.env.passThrough` names → values from host `process.env`.
3. `exec.env.define` literal name/value pairs.

Anything not in those three layers is invisible to the child. This
prevents incidental env leakage between machines and gives reproducible
runs.

## Failure handling

| Failure                                                       | Behavior                                                            |
| ------------------------------------------------------------- | ------------------------------------------------------------------- |
| Exec exit non-zero                                            | Task is `failed`; cache NOT written                                 |
| `execute()` throws (internal error)                           | Task marked `failed`, stderr written `[vx] internal error in <id>`  |
| Upstream task fails                                           | Dependent task is `skipped` (exit 1, durationMs 0); no command runs |
| Workspace yaml missing                                        | `findWorkspaceRoot` throws; `vx run` exits 1                        |
| Same-project task referenced in `dependsOn.self` not declared | `buildTaskGraph` throws                                             |
| Duplicate workspace package name                              | `listProjects` throws with both paths                               |
| Cycle in task graph                                           | `detectCycle` throws with the cycle path                            |

Failures don't kill the scheduler — independent tasks already in
flight finish, and unrelated tasks not yet started still run. The
overall exit code is 1 if any task ended in `failed` or `skipped`
status.

## Output capture and rendering

- **Buffered, framed.** `runCommand` listens to the child's
  stdout/stderr and calls `onStdout` / `onStderr` per chunk. The
  default logger buffers the chunks per-task and dumps the full body
  as a Turbo-style framed block on task completion — no per-line
  prefix, no interleaving between concurrent tasks.
- **Cache write.** Full stdout/stderr text is stored as
  `<hash>/stdout` and `<hash>/stderr` alongside the entry's outputs.
- **Cache hit replay.** The stored stdout/stderr is fed through the
  same logger path so the framed block looks the same as a fresh run.

There is no special handling for binary output, very large output, or
interactive prompts. Stdin is `'ignore'` (child sees a closed stdin) —
tasks that need TTY input won't work and shouldn't be cached anyway.

## Concurrency

- Default: `navigator.hardwareConcurrency` (Bun's CPU-count primitive).
- Override: `--concurrency N` or `-c N`, or a workspace-level default
  in `vx.workspace.ts`.
- `concurrency: 1` serializes execution while still respecting topo
  order.
- The scheduler never exceeds the cap; it just lets tasks queue.
- Failure of a task doesn't pause the scheduler — independent siblings
  continue running and starting.

## `--no-cache`

Bypasses cache reads **and** writes. Every task runs, and nothing is
persisted to the cache directory.

Useful when:

- You suspect cache corruption.
- You want to validate that a cache-hit task can re-run cleanly.
- You're benchmarking.
- You're forwarding args via `--` and want a one-off run that doesn't
  populate the cache with a one-off entry (though note that forwarded
  args are folded into the key, so a separate entry would form anyway).

`--cache` is accepted as a no-op for parity with vite-task.
