# Task execution lifecycle

This document traces what happens between `vx run build` typed at the
terminal and a task succeeding or failing.

## End-to-end timeline

```
 ┌─ CLI parsing (cli.ts)
 │    argv → { task, projects, concurrency, force }
 │
 ├─ Workspace setup (orchestrator.ts:run)
 │    1. findWorkspaceRoot from process.cwd (walk up to pnpm-workspace.yaml)
 │    2. loadWorkspace (parse YAML)
 │    3. listProjects (glob package.json files, find vx.config.* siblings,
 │                     detect duplicate names)
 │    4. loadProjectConfig for each project that has a config (jiti for .ts,
 │                                              native import for .mjs)
 │    5. buildPackageGraph from package.json deps
 │    6. computeNestedProjectDirs (for boundary enforcement)
 │    7. computeWorkspaceFingerprint (hash pnpm-lock.yaml + pnpm-workspace.yaml)
 │
 ├─ Task graph (task-graph.ts:buildTaskGraph)
 │    Starting from requested {project, task} pairs, walk dependsOn:
 │      - self entries are added in the same project
 │      - dependencies entries are added in each transitive workspace dep
 │    Detect cycles. Each node carries id, projectName, projectDir, taskName,
 │    config, sorted deps.
 │
 ├─ Scheduling (scheduler.ts:runGraph)
 │    Up to N tasks concurrently, ordered topologically.
 │    For each ready node, call execute(node, upstream) → outcome.
 │    If a task fails, its dependents are marked skipped; independent siblings
 │    continue.
 │
 └─ Per-task execution (orchestrator.ts:executeTask)
      1. Resolve inputs.files (gitignore-aware, boundary-aware, own-outputs-excluded)
      2. Resolve inputs.env values (read host process.env for listed names)
      3. Hash the resolved task config (post-evaluation)
      4. Filter upstream cache hashes per cache.inputs.tasks
      5. Compute cache key from (1) + (2) + (3) + (4) + workspaceFingerprint
      6. If cache enabled (task declares a `cache` block AND --no-cache
         is not set): try cache.get(key)
         - Hit → restore outputs, replay logs, return cache-hit
         - Miss → fall through
      7. Build isolated env (essentials + exec.env.passThrough values
                              + exec.env.define values)
      8. spawn shell with exec.command (runner.ts:runCommand), with any
         CLI forwarded args appended (shell-quoted)
      9. Stream chunks via onStdout / onStderr to the logger
     10. If exit == 0 and cache enabled:
         a. Resolve outputs.files
         b. cache.save: copy outputs into temp slot, write meta.json,
                        atomic rename to final hash slot
     11. Return TaskOutcome { node, status, exitCode, durationMs, hash }
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

## Output capture, replay, and live streaming

- **Live**: `runCommand` listens to the child's stdout/stderr and calls
  `onStdout` / `onStderr` callbacks chunk by chunk. The orchestrator's
  default logger prefixes each line with the task id.
- **Cache write**: full stdout/stderr text is stored in `meta.json`
  alongside the entry. No timing metadata; output is replayed as one
  blob.
- **Cache hit replay**: the stored stdout/stderr is written verbatim to
  the live terminal via the same logger. ANSI codes are preserved.

There is no special handling for binary output, very large output, or
interactive prompts. Stdin is `'ignore'` (child sees a closed stdin) —
tasks that need TTY input won't work and shouldn't be cached anyway.

## Concurrency

- Default: `os.cpus().length`.
- Override: `--concurrency N` or `-c N`.
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
