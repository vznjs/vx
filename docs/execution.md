# Task execution lifecycle

This document traces what happens between `vzn run build` typed at the
terminal and a task succeeding or failing.

## End-to-end timeline

```
 ┌─ CLI parsing (cli.ts)
 │    argv → { task, projects, concurrency, force }
 │
 ├─ Workspace setup (orchestrator.ts:run)
 │    1. findWorkspaceRoot from process.cwd (walk up to pnpm-workspace.yaml)
 │    2. loadWorkspace (parse YAML)
 │    3. listProjects (glob package.json files, find vzn.config.* siblings,
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
      6. If cache enabled and not --force: try cache.get(key)
         - Hit → restore outputs, replay logs, return cache-hit
         - Miss → fall through
      7. For each step in exec[]:
         a. Build isolated env (essentials + step.env.passThrough values
                                + step.env.define values)
         b. spawn shell with the command (runner.ts:runCommand)
         c. Stream chunks via onStdout / onStderr (prefixed with step index
                                                   when >1 step)
         d. Accumulate stdout/stderr/durationMs
         e. If exit != 0 → break (later steps don't run)
      8. If overall success and cache enabled:
         a. Resolve outputs.files
         b. cache.save: copy outputs into temp slot, write meta.json,
                        atomic rename to final hash slot
      9. Return TaskOutcome { node, status, exitCode, durationMs, hash }
```

## Multi-step semantics

`exec: ExecConfig[]` is a flat, sequential list:

- Steps run **one at a time**, top to bottom.
- A failing step (exit != 0) stops the sequence; later steps do NOT run.
- Each step has its own `env` block — they're built independently from
  the essentials + that step's passThrough + define.
- Captured stdout/stderr from all steps is concatenated for cache
  replay. Live output is prefixed with `[i/N]` when `N > 1`.
- The cache identity is the *whole array*. A cache hit replays all
  output as one block; no per-step granularity.

If you need per-step caching, define each step as its own task and
chain them with `dependsOn`.

## Env isolation

The child process for each step gets, in priority order (lowest first):

1. Essential allowlist (`PATH`, `HOME`, `SHELL`, `TMPDIR`, `LANG`,
   `TERM`, `COLORTERM`, `FORCE_COLOR`, `NO_COLOR`, `CI`, `NODE_OPTIONS`,
   plus Windows essentials like `SYSTEMROOT`).
2. `exec[step].env.passThrough` names → values from host `process.env`.
3. `exec[step].env.define` literal name/value pairs.

Anything not in those three layers is invisible to the child. This
prevents incidental env leakage between machines and gives reproducible
runs.

## Failure handling

| Failure | Behavior |
|---|---|
| Step exit non-zero | Remaining steps in the task skipped; task is `failed`; cache NOT written |
| `execute()` throws (internal error) | Task marked `failed`, stderr written `[vzn] internal error in <id>` |
| Upstream task fails | Dependent task is `skipped` (exit 1, durationMs 0); no command runs |
| Workspace yaml missing | `findWorkspaceRoot` throws; `vzn run` exits 1 |
| Same-project task referenced in `dependsOn.self` not declared | `buildTaskGraph` throws |
| Duplicate workspace package name | `listProjects` throws with both paths |
| Cycle in task graph | `detectCycle` throws with the cycle path |

Failures don't kill the scheduler — independent tasks already in
flight finish, and unrelated tasks not yet started still run. The
overall exit code is 1 if any task ended in `failed` or `skipped`
status.

## Output capture, replay, and live streaming

- **Live**: `runCommand` listens to the child's stdout/stderr and calls
  `onStdout` / `onStderr` callbacks chunk by chunk. The orchestrator's
  default logger prefixes each line with the task id and (in
  multi-step) the step index.
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

## `--force`

Bypasses cache reads. Cache writes still happen on success, so a
forced run refreshes stored entries.

Useful when:
- You suspect cache corruption.
- You want to validate that a cache-hit task can re-run cleanly.
- You're benchmarking.
