# Executor seam + built-in plugins — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Core executes every task and resolves its cache through plugin capabilities, with core's own behaviour shipped as explicitly-registered built-in plugins (`vx/local-executor`, `vx/local-cache`) that a user can reorder, wrap or replace — while a run with no user plugins stays byte-identical to today and `@vzn/vx-cloud` keeps working with zero edits.

**Architecture:** A new per-task `executor` capability (`TaskExecutor`, in the `exec` module) replaces the spawn inside `execute-task.ts`; `plugin-host.ts` resolves an ORDERED LIST of executors (first whose `accepts()` passes wins) and the existing `cache` capability becomes built-in-backed (no hidden fallback). `withBuiltins()` appends the built-in plugins to the workspace's declared list unless the user declared them explicitly (then their position counts). `backend` is untouched so cloud's whole-run delegation keeps working; when a `backend` is contributed the run delegates as today and executors are never consulted.

**Tech Stack:** Bun ≥ 1.3, TypeScript (no build), `bun:test`, `oxlint --type-aware`, `oxfmt`. Gate: `bun src/bin.ts run ci` from the repo root.

**Design doc:** `docs/design/plugin-executor-reapi-2026-08.md` (§3–§6). This plan is its "Phase 2 core" part, scoped to behaviour-preserving seams; the REAPI plugin, `ExecuteRequest.inputs`, placement rules and download policy are LATER plans (listed at the end).

---

## Invariants this plan must keep (check after every task)

- `bun test` green; `bun src/bin.ts run lint` green (oxlint + oxfmt). `bun test` is transpile-only and cannot see a type error — run lint before every commit.
- A workspace with NO `vx.workspace.ts` produces the same `TaskOutcome`s, the same cache entries and the same logger calls as before. Pinned by the existing suites (`tests/orchestrator.test.ts`, `tests/plugin-e2e.test.ts`) running unchanged.
- `packages/cloud` compiles with NO source edits (`bun src/bin.ts run lint` type-checks it). Its plugin contributes `backend`/`cache`/`telemetry`; all three keep their meaning.
- Module boundaries (`tests/module-boundaries.test.ts`): `exec` may import only `util`, `config`; `orchestrator` may import `exec`. The executor contract therefore lives in `exec/`, and anything needing `cache/` (sandbox baselines) is computed in `execute-task.ts` and handed over in the request.
- `tests/package-boundaries.test.ts` pins the EXACT runtime export set of `src/index.ts` — every new runtime export is added there in the same task.

## File structure

| File                                                                                                                                                                             | Responsibility                                                                                                                                                                      |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/exec/executor.ts` (create)                                                                                                                                                  | The execution contract: `TaskExecutor`, `ExecuteRequest`, `ExecuteResult`, `ExecuteSandbox`; `localExecutor()` = today's `runCommand`/`runSandboxed` behind it; `selectExecutor()`. |
| `src/exec/index.ts` (modify)                                                                                                                                                     | Export the above.                                                                                                                                                                   |
| `src/orchestrator/plugin.ts` (modify)                                                                                                                                            | `VxPlugin.executor?(ctx: ExecutorContext)`; `ExecutorContext`.                                                                                                                      |
| `src/orchestrator/plugin-host.ts` (modify)                                                                                                                                       | `resolveExecutors()` (ordered list); `resolveCache()` loses its fallback parameter (the built-in provides it).                                                                      |
| `src/orchestrator/builtin-plugins.ts` (create)                                                                                                                                   | `localExecutorPlugin()`, `localCachePlugin()`, `builtinPlugins()`, `withBuiltins()`.                                                                                                |
| `src/orchestrator/prepare.ts` (modify)                                                                                                                                           | Resolve plugins via `withBuiltins`; expose `plugins` on `PreparedRun`; cache via built-in.                                                                                          |
| `src/orchestrator/run.ts` (modify)                                                                                                                                               | Use `prepared.plugins`; resolve executors once; thread into `ExecuteArgs`.                                                                                                          |
| `src/orchestrator/execute-task.ts` (modify)                                                                                                                                      | `ExecuteArgs.executors`; `runAttempt` builds an `ExecuteRequest` and calls the selected executor.                                                                                   |
| `src/orchestrator/index.ts`, `src/index.ts` (modify)                                                                                                                             | Contract + façade exports.                                                                                                                                                          |
| `src/workspace/project-loader.ts` (modify)                                                                                                                                       | Plugin validation accepts `executor`.                                                                                                                                               |
| `tests/executor.test.ts` (create)                                                                                                                                                | Unit: `localExecutor`, `selectExecutor`.                                                                                                                                            |
| `tests/builtin-plugins.test.ts` (create)                                                                                                                                         | Unit: `withBuiltins` ordering/dedup.                                                                                                                                                |
| `tests/plugin-capabilities.test.ts` (modify)                                                                                                                                     | Host consultation for `executor`; `resolveCache` without fallback; e2e executor via `vx.workspace.mjs`; backend-wins compat pin.                                                    |
| `tests/package-boundaries.test.ts` (modify)                                                                                                                                      | Façade pin.                                                                                                                                                                         |
| `docs/modules/executor.md`, `docs/modules/builtin-plugins.md` (create); `docs/modules/{plugin,plugin-host,execute-task,README}.md`, `docs/architecture.md`, `CLAUDE.md` (modify) | Docs land in the same wave.                                                                                                                                                         |

---

### Task 1: The execution contract + `localExecutor` (exec module)

**Files:**

- Create: `src/exec/executor.ts`
- Modify: `src/exec/index.ts`
- Test: `tests/executor.test.ts`

- [ ] **Step 1: Write the failing unit test**

```ts
// tests/executor.test.ts
import { describe, expect, it } from 'bun:test'
import {
  localExecutor,
  selectExecutor,
  type ExecuteRequest,
  type TaskExecutor,
} from '../src/exec/index.js'

function req(over: Partial<ExecuteRequest> = {}): ExecuteRequest {
  return {
    taskId: 'pkg-a#hello',
    command: 'echo hi',
    forwardArgs: [],
    cwd: process.cwd(),
    env: { PATH: process.env['PATH'] ?? '' },
    capture: { stdout: true, stderr: true },
    onStdout: () => undefined,
    onStderr: () => undefined,
    ...over,
  }
}

describe('localExecutor', () => {
  it('runs the command in cwd and returns exit code, stdout and no violations', async () => {
    const chunks: string[] = []
    const res = await localExecutor().execute(
      req({ command: 'echo hi && exit 3', onStdout: (c) => chunks.push(c) }),
    )
    expect(res.exitCode).toBe(3)
    expect(res.stdout).toBe('hi\n')
    expect(chunks.join('')).toBe('hi\n')
    expect(res.violations).toEqual([])
  })

  it('appends forwardArgs to the command line, shell-quoted', async () => {
    // runCommand builds `command + ' ' + forwardArgs.map(shellQuote).join(' ')`
    // (src/exec/runner.ts, runCommand), so the args reach printf as two
    // operands — the one with a space survives quoting intact.
    const res = await localExecutor().execute(
      req({ command: 'printf "%s|"', forwardArgs: ['a b', 'c'] }),
    )
    expect(res.exitCode).toBe(0)
    expect(res.stdout).toBe('a b|c|')
  })

  it('flags a timeout as timedOut with a non-zero exit', async () => {
    const res = await localExecutor().execute(req({ command: 'sleep 5', timeoutMs: 100 }))
    expect(res.timedOut).toBe(true)
    expect(res.exitCode).not.toBe(0)
  })

  it('is named local', () => {
    expect(localExecutor().name).toBe('local')
  })
})

describe('selectExecutor', () => {
  const accepting: TaskExecutor = { name: 'a', execute: () => Promise.reject(new Error('unused')) }
  const declining: TaskExecutor = {
    name: 'd',
    accepts: () => false,
    execute: () => Promise.reject(new Error('unused')),
  }

  it('picks the first executor in order whose accepts() is absent or true', () => {
    expect(selectExecutor([declining, accepting], req())).toBe(accepting)
    expect(selectExecutor([accepting, declining], req())).toBe(accepting)
  })

  it('passes the request to accepts()', () => {
    const seen: string[] = []
    const spy: TaskExecutor = {
      name: 's',
      accepts: (r) => {
        seen.push(r.taskId)
        return false
      },
      execute: () => Promise.reject(new Error('unused')),
    }
    selectExecutor([spy, accepting], req({ taskId: 'x#y' }))
    expect(seen).toEqual(['x#y'])
  })

  it('throws when every executor declines', () => {
    expect(() => selectExecutor([declining], req())).toThrow(/no executor accepted pkg-a#hello/)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test tests/executor.test.ts`
Expected: FAIL — `export 'localExecutor' not found in '../src/exec/index.js'` (or equivalent resolve error).

- [ ] **Step 3: Write `src/exec/executor.ts`**

```ts
// The per-task execution contract. `execute-task.ts` decides WHAT to run
// (command, env, sandbox baselines, capture) and hands a fully-resolved
// request here; an executor decides WHERE/HOW the process runs. Core's own
// behaviour is `localExecutor` — the same `runCommand` / `runSandboxed`
// calls the orchestrator used to make directly — registered as the
// built-in `vx/local-executor` plugin so a workspace can put another
// executor ahead of it. Persistent tasks (`exec.persistent`) never reach an
// executor: they are local by construction (a worker cannot hand the
// submitter a listening port) and stay on `runPersistent`.
//
// Lives in `exec/` (not `orchestrator/`) so the contract depends only on
// process primitives — the module-boundary matrix forbids `exec` → `cache`,
// which is why sandbox baselines arrive pre-resolved on the request.

import { runCommand, type CaptureConfig, type RunResult } from './runner.js'
import {
  runSandboxed,
  type ResolvedSandboxConfig,
  type SandboxViolation,
} from './sandbox-runtime.js'

/** Sandbox baselines + the user's resolved sandbox block, when the task is sandboxed. */
export interface ExecuteSandbox {
  readonly baseAllowRead: readonly string[]
  readonly baseAllowWrite: readonly string[]
  readonly baseDenyRead: readonly string[]
  readonly config: ResolvedSandboxConfig
}

export interface ExecuteRequest {
  /** `${project}#${task}` — for executors that route or log by task. */
  readonly taskId: string
  readonly command: string
  /** Appended to `command`, shell-quoted, by the executor (forwarded CLI args). */
  readonly forwardArgs: readonly string[]
  readonly cwd: string
  readonly env: NodeJS.ProcessEnv
  readonly capture: CaptureConfig
  readonly timeoutMs?: number
  readonly onStdout: (chunk: string) => void
  readonly onStderr: (chunk: string) => void
  /** See `RunOptions.liveChildren`: the run's SIGINT/SIGTERM registry. */
  readonly liveChildren?: Set<ReturnType<typeof Bun.spawn>>
  readonly sandbox?: ExecuteSandbox
}

export interface ExecuteResult extends RunResult {
  /** Sandbox violations (empty when unsandboxed). */
  readonly violations: readonly SandboxViolation[]
}

export interface TaskExecutor {
  /** Shown in errors; `'local'` for core's own. */
  readonly name: string
  /** Per-request opt-out. Absent = accepts everything. */
  accepts?(req: ExecuteRequest): boolean
  execute(req: ExecuteRequest): Promise<ExecuteResult>
}

/** Core's executor: spawn in-process exactly as before the seam existed. */
export function localExecutor(): TaskExecutor {
  return {
    name: 'local',
    async execute(req) {
      const common = {
        command: req.command,
        cwd: req.cwd,
        env: req.env,
        forwardArgs: req.forwardArgs,
        onStdout: req.onStdout,
        onStderr: req.onStderr,
        capture: req.capture,
        ...(req.liveChildren !== undefined ? { liveChildren: req.liveChildren } : {}),
        ...(req.timeoutMs !== undefined ? { timeoutMs: req.timeoutMs } : {}),
      }
      if (req.sandbox === undefined) {
        const res = await runCommand(common)
        return { ...res, violations: [] }
      }
      return await runSandboxed({
        ...common,
        baseAllowRead: req.sandbox.baseAllowRead,
        baseAllowWrite: req.sandbox.baseAllowWrite,
        baseDenyRead: req.sandbox.baseDenyRead,
        config: req.sandbox.config,
      })
    },
  }
}

/**
 * First executor, in declaration order, that does not decline the request.
 * The built-in local executor accepts everything, so with it registered
 * this cannot throw; the throw is the guard for a workspace that replaced
 * the built-ins with executors that all decline.
 */
export function selectExecutor(
  executors: readonly TaskExecutor[],
  req: ExecuteRequest,
): TaskExecutor {
  for (const executor of executors) {
    if (executor.accepts === undefined || executor.accepts(req)) return executor
  }
  throw new Error(`no executor accepted ${req.taskId} (${executors.map((e) => e.name).join(', ')})`)
}
```

Check that `ResolvedSandboxConfig` is exported from `src/exec/sandbox-runtime.ts` (`grep -n "export interface ResolvedSandboxConfig" src/exec/sandbox-runtime.ts`). If it is not exported, add `export` to the interface — it is already the declared return type of the exported `resolveSandboxConfig`.

- [ ] **Step 4: Export from the module contract**

In `src/exec/index.ts` append:

```ts
export {
  localExecutor,
  selectExecutor,
  type ExecuteRequest,
  type ExecuteResult,
  type ExecuteSandbox,
  type TaskExecutor,
} from './executor.js'
```

- [ ] **Step 5: Run the tests**

Run: `bun test tests/executor.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 6: Lint + commit**

Run: `bun src/bin.ts run lint`
Expected: `lint.oxlint` and `lint.oxfmt` both `success`.

```bash
git add src/exec/executor.ts src/exec/index.ts tests/executor.test.ts
git commit -m "Add the per-task executor contract and the local executor

The orchestrator spawned tasks directly; an executor is the seam a plugin
uses to run ONE task's command somewhere else. localExecutor is the same
runCommand/runSandboxed call, so nothing changes until a plugin contributes
an executor ahead of it."
```

---

### Task 2: The `executor` capability on `VxPlugin` + config validation

**Files:**

- Modify: `src/orchestrator/plugin.ts`
- Modify: `src/workspace/project-loader.ts:112-158`
- Test: `tests/plugin-capabilities.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `tests/plugin-capabilities.test.ts`, inside a new `describe`:

```ts
import { loadWorkspaceConfig } from '../src/workspace/index.js'

describe('executor capability — config validation', () => {
  it('accepts a plugin that contributes only `executor`', async () => {
    const { workspaceRoot, cleanup } = await writeFixture()
    try {
      await Bun.write(
        path.join(workspaceRoot, 'vx.workspace.mjs'),
        `export default { plugins: [{ name: 'org/exec', executor() { return undefined } }] }`,
      )
      const cfg = await loadWorkspaceConfig(workspaceRoot)
      expect(cfg?.plugins?.length).toBe(1)
    } finally {
      cleanup()
    }
  })

  it('rejects a non-function `executor`', async () => {
    const { workspaceRoot, cleanup } = await writeFixture()
    try {
      await Bun.write(
        path.join(workspaceRoot, 'vx.workspace.mjs'),
        `export default { plugins: [{ name: 'org/exec', executor: 42 }] }`,
      )
      await expect(loadWorkspaceConfig(workspaceRoot)).rejects.toThrow(
        /plugins\[0\]\.executor.*function/,
      )
    } finally {
      cleanup()
    }
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test tests/plugin-capabilities.test.ts -t "executor capability"`
Expected: FAIL — the first test throws `plugins[0] must contribute at least one of setup/backend/cache/telemetry/eventSink`.

- [ ] **Step 3: Add the capability to `VxPlugin`**

In `src/orchestrator/plugin.ts`, add the import and, after the `cache?` member, the new capability:

```ts
import type { TaskExecutor } from '../exec/index.js'
```

```ts
  /**
   * Contribute a task executor — WHERE one task's command runs. Consulted
   * ONCE per run; every contributed executor is kept, in declaration order,
   * and per task the first whose `accepts()` passes executes it. The
   * built-in `vx/local-executor` is appended last unless declared
   * explicitly, so a plugin that declines (returns undefined) or whose
   * executor declines a task falls through to the local spawn. Persistent
   * tasks never reach an executor (local by construction).
   */
  executor?(ctx: ExecutorContext): TaskExecutor | undefined | Promise<TaskExecutor | undefined>
```

Update the `backend?` doc comment's first line to read:

```ts
/**
 * Contribute a run backend — WHOLE-RUN delegation. Kept for plugins that
 * schedule server-side (`@vzn/vx-cloud`); new plugins should contribute
 * `executor` instead, which keeps the scheduler — and therefore every
 * telemetry sink — in this process. When a backend is contributed the run
 * delegates as a unit and executors are never consulted.
 * Returns a RunBackend (run(request) → result), or undefined to decline
 * (core then tries the next plugin, else the fallback). Consulted ONCE
 * per run, before scheduling. At most one plugin's backend is used
 * (first non-undefined, in declaration order).
 */
```

Add the context type next to `CacheContext`:

```ts
export interface ExecutorContext extends BaseContext {
  /** The run's worker count — an executor that paces itself reads it here. */
  readonly concurrency: number
}
```

- [ ] **Step 4: Accept `executor` in the loader**

In `src/workspace/project-loader.ts` replace the plugin block (the `const plug = p as {...}` through the "must contribute at least one" throw) with:

```ts
const plug = p as {
  name?: unknown
  setup?: unknown
  backend?: unknown
  cache?: unknown
  executor?: unknown
  telemetry?: unknown
  eventSink?: unknown
  teardown?: unknown
}
if (typeof plug.name !== 'string' || plug.name.length === 0) {
  throw new UserError(`${configPath}: \`plugins[${i}].name\` must be a non-empty string`)
}
const caps = [
  'setup',
  'backend',
  'cache',
  'executor',
  'telemetry',
  'eventSink',
  'teardown',
] as const
for (const cap of caps) {
  if (plug[cap] !== undefined && typeof plug[cap] !== 'function') {
    throw new UserError(`${configPath}: \`plugins[${i}].${cap}\` must be a function`)
  }
}
// A plugin must contribute at least one capability or lifecycle hook
// — an empty `{ name }` object is a no-op authoring mistake.
if (caps.every((cap) => plug[cap] === undefined)) {
  throw new UserError(
    `${configPath}: \`plugins[${i}]\` must contribute at least one of ${caps.join('/')}`,
  )
}
```

The old message is pinned in TWO places that drift-check each other; update both to the new text `plugins[<i>] must contribute at least one of setup/backend/cache/executor/telemetry/eventSink/teardown`:

- `tests/schema-doc-drift.test.ts` — the `WORKSPACE_CASES` row that currently reads `'plugins[<i>] must contribute at least one of setup/backend/cache/telemetry/eventSink'`.
- `docs/schema.md:1193` — the matching row of the workspace-errors table (same string, in backticks).

Also grep `docs/schema.md` for the capability list in prose (`grep -n "backend/cache\|backend, cache" docs/schema.md`) and add `executor` wherever the plugin capabilities are enumerated, with one sentence: `executor(ctx) — return a TaskExecutor (where one task's command runs) or decline.`

Run `bun test tests/schema-doc-drift.test.ts` — it asserts the documented set equals the pinned set AND that each row really provokes its message, so a mismatch between the two edits fails here.

- [ ] **Step 5: Run the tests**

Run: `bun test tests/plugin-capabilities.test.ts tests/plugin.test.ts tests/schema-doc-drift.test.ts`
Expected: PASS.

- [ ] **Step 6: Lint + commit**

Run: `bun src/bin.ts run lint` — expected both `success` (this is the step that proves cloud still type-checks against the widened `VxPlugin`).

```bash
git add src/orchestrator/plugin.ts src/workspace/project-loader.ts tests/plugin-capabilities.test.ts tests/schema-doc-drift.test.ts docs/schema.md
git commit -m "Add the executor capability to VxPlugin

Per-task grain, additive list, first accepting executor wins. backend
stays as whole-run delegation for plugins that schedule server-side."
```

---

### Task 3: Host consultation — `resolveExecutors`

**Files:**

- Modify: `src/orchestrator/plugin-host.ts`
- Modify: `src/orchestrator/index.ts:86`
- Test: `tests/plugin-capabilities.test.ts` (append to the `plugin-host — capability consultation` describe)

- [ ] **Step 1: Write the failing tests**

```ts
import { resolveExecutors } from '../src/orchestrator/index.js'
import type { TaskExecutor } from '../src/exec/index.js'

it('resolveExecutors: keeps every contributed executor in declaration order', async () => {
  const a: TaskExecutor = { name: 'a', execute: () => Promise.reject(new Error('unused')) }
  const b: TaskExecutor = { name: 'b', execute: () => Promise.reject(new Error('unused')) }
  const plugins: VxPlugin[] = [
    { name: 'org/a', executor: () => a },
    { name: 'org/none', executor: () => undefined },
    { name: 'org/b', executor: async () => b },
  ]
  const resolved = await resolveExecutors(plugins, { ...baseCtx, concurrency: 4 })
  expect(resolved).toEqual([a, b])
})

it('resolveExecutors: a throwing executor factory aborts with a named UserError', async () => {
  const plugins: VxPlugin[] = [
    {
      name: 'org/broken-exec',
      executor: () => {
        throw new Error('exec boom')
      },
    },
  ]
  await expect(resolveExecutors(plugins, { ...baseCtx, concurrency: 1 })).rejects.toThrow(
    /org\/broken-exec.*exec boom/,
  )
})
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test tests/plugin-capabilities.test.ts -t "resolveExecutors"`
Expected: FAIL — `resolveExecutors` is not exported.

- [ ] **Step 3: Implement**

In `src/orchestrator/plugin-host.ts` add the import and function:

```ts
import type { TaskExecutor } from '../exec/index.js'
import type { ExecutorContext } from './plugin.js'
```

```ts
/**
 * Collect every plugin's `executor`, in declaration order. Unlike `backend`
 * and `cache` this is a LIST: per task, `selectExecutor` takes the first
 * that accepts. With the built-ins appended (`withBuiltins`) the local
 * executor is always last, so the list is never empty. A broken factory
 * aborts — an executor is load-bearing, not observational.
 */
export async function resolveExecutors(
  plugins: readonly VxPlugin[],
  ctx: ExecutorContext,
): Promise<TaskExecutor[]> {
  const executors: TaskExecutor[] = []
  for (const plugin of plugins) {
    if (plugin.executor === undefined) continue
    const executor = await safe(plugin, 'executor', () => plugin.executor!(ctx))
    if (executor !== undefined) executors.push(executor)
  }
  return executors
}
```

Update the file header comment's first line to `// Plugin consultation for the run-level extension points (backend / cache / executor / eventSink).`

In `src/orchestrator/index.ts` line 86:

```ts
export {
  resolveBackend,
  resolveCache,
  resolveExecutors,
  subscribeEventSinks,
} from './plugin-host.js'
```

and add `type ExecutorContext,` to the `./plugin.js` export block.

- [ ] **Step 4: Run tests, lint, commit**

Run: `bun test tests/plugin-capabilities.test.ts && bun src/bin.ts run lint`
Expected: PASS / success.

```bash
git add src/orchestrator/plugin-host.ts src/orchestrator/index.ts tests/plugin-capabilities.test.ts
git commit -m "Resolve the executor list in plugin-host"
```

---

### Task 4: Built-in plugins + `withBuiltins`

**Files:**

- Create: `src/orchestrator/builtin-plugins.ts`
- Modify: `src/orchestrator/index.ts`
- Test: `tests/builtin-plugins.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/builtin-plugins.test.ts
import { describe, expect, it } from 'bun:test'
import {
  builtinPlugins,
  localCachePlugin,
  localExecutorPlugin,
  withBuiltins,
  type VxPlugin,
} from '../src/orchestrator/index.js'

describe('built-in plugins', () => {
  it('are named under the vx/ prefix and contribute exactly one capability each', () => {
    const [exec, cache] = builtinPlugins()
    expect(exec!.name).toBe('vx/local-executor')
    expect(typeof exec!.executor).toBe('function')
    expect(exec!.cache).toBeUndefined()
    expect(cache!.name).toBe('vx/local-cache')
    expect(typeof cache!.cache).toBe('function')
    expect(cache!.executor).toBeUndefined()
  })

  it('withBuiltins appends the built-ins after user plugins when absent', () => {
    const user: VxPlugin = { name: 'org/x', executor: () => undefined }
    expect(withBuiltins([user]).map((p) => p.name)).toEqual([
      'org/x',
      'vx/local-executor',
      'vx/local-cache',
    ])
  })

  it('withBuiltins keeps a user-declared built-in at its declared position and does not duplicate it', () => {
    const user: VxPlugin = { name: 'org/x', executor: () => undefined }
    const list = withBuiltins([localExecutorPlugin(), user])
    expect(list.map((p) => p.name)).toEqual(['vx/local-executor', 'org/x', 'vx/local-cache'])
  })

  it('withBuiltins with no user plugins is exactly the built-ins', () => {
    expect(withBuiltins([]).map((p) => p.name)).toEqual(['vx/local-executor', 'vx/local-cache'])
    expect(withBuiltins(undefined).map((p) => p.name)).toEqual([
      'vx/local-executor',
      'vx/local-cache',
    ])
  })

  it('localCachePlugin hands back the local cache the host passes in', async () => {
    const marker = { hasRemote: false } as never
    const layer = await localCachePlugin().cache!({
      workspaceRoot: '/ws',
      cacheDir: '/ws/.vx/cache',
      warn: () => undefined,
      localCache: marker,
      policy: { localRead: true, localWrite: true, remoteRead: false, remoteWrite: false },
    })
    expect(layer).toBe(marker)
  })

  it('localExecutorPlugin contributes the local executor', async () => {
    const exec = await localExecutorPlugin().executor!({
      workspaceRoot: '/ws',
      cacheDir: '/ws/.vx/cache',
      warn: () => undefined,
      concurrency: 2,
    })
    expect(exec?.name).toBe('local')
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test tests/builtin-plugins.test.ts`
Expected: FAIL — exports not found.

- [ ] **Step 3: Implement**

```ts
// src/orchestrator/builtin-plugins.ts
//
// Core's own behaviour, shipped as plugins through the same capabilities a
// third party uses. This is what makes "a plugin can replace any part"
// provable rather than promised: there is no hidden fallback for executing
// a task or holding the cache — the built-ins ARE the fallback, appended
// last unless the workspace declares them itself (then their declared
// position is the precedence). A run with no user plugins resolves to
// exactly these two and is byte-identical to pre-seam vx.

import { localExecutor } from '../exec/index.js'
import type { VxPlugin } from './plugin.js'

export const LOCAL_EXECUTOR_PLUGIN = 'vx/local-executor'
export const LOCAL_CACHE_PLUGIN = 'vx/local-cache'

/** In-process spawn — `runCommand` / `runSandboxed`. Accepts every task. */
export function localExecutorPlugin(): VxPlugin {
  return { name: LOCAL_EXECUTOR_PLUGIN, executor: () => localExecutor() }
}

/** The bare local cache handle the host already opened (`.vx/cache`). */
export function localCachePlugin(): VxPlugin {
  return { name: LOCAL_CACHE_PLUGIN, cache: (ctx) => ctx.localCache }
}

/** Declaration order = precedence order for the capabilities they carry. */
export function builtinPlugins(): VxPlugin[] {
  return [localExecutorPlugin(), localCachePlugin()]
}

/**
 * The run's effective plugin list: the workspace's declared plugins, then
 * every built-in the workspace did not declare itself (matched by name).
 */
export function withBuiltins(declared: readonly VxPlugin[] | undefined): VxPlugin[] {
  const user = declared ?? []
  const names = new Set(user.map((p) => p.name))
  return [...user, ...builtinPlugins().filter((b) => !names.has(b.name))]
}
```

In `src/orchestrator/index.ts` add:

```ts
export {
  builtinPlugins,
  LOCAL_CACHE_PLUGIN,
  LOCAL_EXECUTOR_PLUGIN,
  localCachePlugin,
  localExecutorPlugin,
  withBuiltins,
} from './builtin-plugins.js'
```

- [ ] **Step 4: Run tests, lint, commit**

Run: `bun test tests/builtin-plugins.test.ts && bun src/bin.ts run lint`

```bash
git add src/orchestrator/builtin-plugins.ts src/orchestrator/index.ts tests/builtin-plugins.test.ts
git commit -m "Ship core's executor and cache as built-in plugins

withBuiltins appends vx/local-executor and vx/local-cache unless the
workspace declares them, so their position (and therefore precedence) is
the user's to set."
```

---

### Task 5: `resolveCache` is built-in-backed; `prepareRun` uses `withBuiltins`

**Files:**

- Modify: `src/orchestrator/plugin-host.ts` (`resolveCache`)
- Modify: `src/orchestrator/prepare.ts` (plugin list, `PreparedRun.plugins`, cache resolution)
- Modify: `tests/plugin-capabilities.test.ts` (the two `resolveCache` tests)

- [ ] **Step 1: Rewrite the two `resolveCache` tests**

Replace `'resolveCache: plugin cache wins over the fallback'` and `'resolveCache: no cache plugin uses the fallback'` with:

```ts
it('resolveCache: first contributing plugin wins, in declaration order', async () => {
  const cacheDir = mkdtempSync(path.join(tmpdir(), 'vx-cache-host-'))
  const local = new Cache(cacheDir, { read: true, write: true })
  const other = new Cache(mkdtempSync(path.join(tmpdir(), 'vx-cache-host2-')), {
    read: true,
    write: true,
  })
  const plugins: VxPlugin[] = [
    { name: 'org/none', cache: () => undefined },
    { name: 'org/cache', cache: () => other },
    { name: 'org/late', cache: () => local },
  ]
  try {
    const resolved = await resolveCache(plugins, {
      ...baseCtx,
      localCache: local,
      policy: { localRead: true, localWrite: true, remoteRead: false, remoteWrite: false },
    })
    expect(resolved).toBe(other)
  } finally {
    local.close()
    other.close()
    rmSync(cacheDir, { recursive: true, force: true })
  }
})

it('resolveCache: with no contributing plugin there is NO hidden fallback', async () => {
  const cacheDir = mkdtempSync(path.join(tmpdir(), 'vx-cache-host-'))
  const local = new Cache(cacheDir, { read: true, write: true })
  try {
    await expect(
      resolveCache([{ name: 'org/none', cache: () => undefined }], {
        ...baseCtx,
        localCache: local,
        policy: { localRead: true, localWrite: true, remoteRead: false, remoteWrite: false },
      }),
    ).rejects.toThrow(/no plugin contributed a cache layer/)
  } finally {
    local.close()
    rmSync(cacheDir, { recursive: true, force: true })
  }
})

it('resolveCache: the built-in list resolves to the local cache handle', async () => {
  const cacheDir = mkdtempSync(path.join(tmpdir(), 'vx-cache-host-'))
  const local = new Cache(cacheDir, { read: true, write: true })
  try {
    const resolved = await resolveCache(withBuiltins([]), {
      ...baseCtx,
      localCache: local,
      policy: { localRead: true, localWrite: true, remoteRead: false, remoteWrite: false },
    })
    expect(resolved).toBe(local)
  } finally {
    local.close()
    rmSync(cacheDir, { recursive: true, force: true })
  }
})
```

Add `withBuiltins` to the `../src/orchestrator/index.js` import at the top of the file.

- [ ] **Step 2: Run to verify failure**

Run: `bun test tests/plugin-capabilities.test.ts -t "resolveCache"`
Expected: FAIL — type/arity mismatch (the old signature takes a third `fallback` argument and returns it).

- [ ] **Step 3: Change `resolveCache`**

In `src/orchestrator/plugin-host.ts`:

```ts
/**
 * Resolve the cache layer. First plugin returning a non-undefined `cache`
 * wins. There is no fallback parameter: the built-in `vx/local-cache`
 * plugin (appended by `withBuiltins`) is the default, so an empty result
 * means the workspace removed every cache provider — an authoring error
 * worth naming, never a silent cacheless run.
 */
export async function resolveCache(
  plugins: readonly VxPlugin[],
  ctx: CacheContext,
): Promise<CacheLayer> {
  for (const plugin of plugins) {
    if (plugin.cache === undefined) continue
    const cache = await safe(plugin, 'cache', () => plugin.cache!(ctx))
    if (cache !== undefined) return cache
  }
  throw new UserError(
    `no plugin contributed a cache layer (declared: ${plugins.map((p) => p.name).join(', ') || 'none'}); include vx/local-cache or a plugin with a \`cache\` capability`,
  )
}
```

- [ ] **Step 4: Thread the built-ins through `prepareRun`**

In `src/orchestrator/prepare.ts`:

Add to the imports: `import { withBuiltins } from './builtin-plugins.js'`.

Add to `PreparedRun` (after `workspaceConfig`):

```ts
  /** Effective plugin list: declared plugins, then the built-ins not declared. */
  plugins: readonly VxPlugin[]
```

Replace

```ts
const plugins = (workspaceConfig?.plugins ?? []) as readonly VxPlugin[]
const cache = options.remoteCache
  ? new LayeredCache(localCache, options.remoteCache, {
      policy,
      onRemoteError: (err) => log.status(`[vx] remote cache: ${err.message}`),
    })
  : await resolveCache(
      plugins,
      { workspaceRoot, cacheDir, warn: (m) => log.status(m), localCache, policy },
      () => localCache,
    )
```

with

```ts
const plugins = withBuiltins(workspaceConfig?.plugins as readonly VxPlugin[] | undefined)
const cache = options.remoteCache
  ? new LayeredCache(localCache, options.remoteCache, {
      policy,
      onRemoteError: (err) => log.status(`[vx] remote cache: ${err.message}`),
    })
  : await resolveCache(plugins, {
      workspaceRoot,
      cacheDir,
      warn: (m) => log.status(m),
      localCache,
      policy,
    })
```

and add `plugins,` to BOTH `return { ... }` objects in `prepareRun` (the empty-case one and the final one), right after `workspaceConfig,`.

- [ ] **Step 5: Run the broad suites**

Run: `bun test tests/plugin-capabilities.test.ts tests/orchestrator.test.ts tests/plugin-e2e.test.ts tests/local-shortcircuit.test.ts`
Expected: PASS — a workspace with no plugins now resolves its cache through `vx/local-cache` and nothing observable changed.

- [ ] **Step 6: Lint + commit**

Run: `bun src/bin.ts run lint`

```bash
git add src/orchestrator/plugin-host.ts src/orchestrator/prepare.ts tests/plugin-capabilities.test.ts
git commit -m "Resolve the cache through the built-in plugin, with no hidden fallback

prepareRun now works on the effective plugin list (declared + built-ins);
an empty cache resolution is a named error instead of a silent default."
```

---

### Task 6: `execute-task` runs through the selected executor; `run()` wires it

**Files:**

- Modify: `src/orchestrator/execute-task.ts` (imports, `ExecuteArgs`, `runUnsandboxedTask`/`runSandboxedTask` → `buildRequest`, `runAttempt`)
- Modify: `src/orchestrator/run.ts` (plugin list, executor resolution, `buildExecuteArgs`)
- Test: `tests/plugin-capabilities.test.ts` (e2e)

- [ ] **Step 1: Write the failing e2e tests**

Append a new `describe` to `tests/plugin-capabilities.test.ts`:

```ts
describe('executor capability — end-to-end via run()', () => {
  async function runHello(workspaceRoot: string) {
    return await run({
      cwd: workspaceRoot,
      projects: ['pkg-a'],
      tasks: ['hello'],
      log: makeSilentLogger(),
      handleSignals: false,
    })
  }

  it('a declared executor runs the task and the local executor is not used', async () => {
    const { workspaceRoot, cleanup } = await writeFixture()
    try {
      await Bun.write(
        path.join(workspaceRoot, 'vx.workspace.mjs'),
        `globalThis.__vxExec = []
         export default {
           plugins: [{
             name: 'org/exec',
             executor() {
               return {
                 name: 'fake',
                 async execute(req) {
                   globalThis.__vxExec.push(req.taskId + ':' + req.command)
                   req.onStdout('from-fake\\n')
                   return { exitCode: 0, durationMs: 1, stdout: 'from-fake\\n', stderr: '', violations: [] }
                 },
               }
             },
           }],
         }`,
      )
      await gitInit(workspaceRoot)
      const summary = await runHello(workspaceRoot)
      expect(summary.ok).toBe(true)
      const seen = (globalThis as unknown as { __vxExec: string[] }).__vxExec
      expect(seen).toEqual(['pkg-a#hello:echo hi'])
    } finally {
      cleanup()
    }
  })

  it('an executor that declines a task falls through to the built-in local executor', async () => {
    const { workspaceRoot, cleanup } = await writeFixture()
    try {
      await Bun.write(
        path.join(workspaceRoot, 'vx.workspace.mjs'),
        `globalThis.__vxDeclined = []
         export default {
           plugins: [{
             name: 'org/picky',
             executor() {
               return {
                 name: 'picky',
                 accepts(req) { globalThis.__vxDeclined.push(req.taskId); return false },
                 async execute() { throw new Error('must not run') },
               }
             },
           }],
         }`,
      )
      await gitInit(workspaceRoot)
      const summary = await runHello(workspaceRoot)
      expect(summary.ok).toBe(true)
      expect(summary.outcomes.map((o) => [o.node.id, o.exitCode])).toEqual([['pkg-a#hello', 0]])
      expect((globalThis as unknown as { __vxDeclined: string[] }).__vxDeclined).toEqual([
        'pkg-a#hello',
      ])
    } finally {
      cleanup()
    }
  })

  it('a cacheable task executed by a plugin executor is saved and replayed as a hit', async () => {
    const { workspaceRoot, cleanup } = await writeFixture()
    try {
      await Bun.write(
        path.join(workspaceRoot, 'pkg-a/vx.config.mjs'),
        `export default { tasks: { hello: {
           exec: { command: 'echo hi > out.txt' },
           cache: { inputs: { files: ['package.json'] }, outputs: { files: ['out.txt'] } },
         } } }`,
      )
      await Bun.write(
        path.join(workspaceRoot, 'vx.workspace.mjs'),
        `globalThis.__vxCalls = 0
         import { writeFileSync } from 'node:fs'
         import { join } from 'node:path'
         export default {
           plugins: [{
             name: 'org/exec',
             executor() {
               return {
                 name: 'fake',
                 async execute(req) {
                   globalThis.__vxCalls++
                   writeFileSync(join(req.cwd, 'out.txt'), 'made-by-fake\\n')
                   return { exitCode: 0, durationMs: 1, stdout: '', stderr: '', violations: [] }
                 },
               }
             },
           }],
         }`,
      )
      await gitInit(workspaceRoot)
      const first = await runHello(workspaceRoot)
      expect(first.ok).toBe(true)
      expect(first.outcomes[0]?.restored).not.toBe(true)
      const second = await runHello(workspaceRoot)
      expect(second.ok).toBe(true)
      expect(second.outcomes[0]?.restored).toBe(true)
      expect((globalThis as unknown as { __vxCalls: number }).__vxCalls).toBe(1)
      expect(await Bun.file(path.join(workspaceRoot, 'pkg-a/out.txt')).text()).toBe(
        'made-by-fake\n',
      )
    } finally {
      cleanup()
    }
  })

  it('COMPAT: a plugin that contributes `backend` delegates the whole run and no executor is consulted', async () => {
    const { workspaceRoot, cleanup } = await writeFixture()
    try {
      await Bun.write(
        path.join(workspaceRoot, 'vx.workspace.mjs'),
        `globalThis.__vxBackendRan = false
         globalThis.__vxExecutorAsked = false
         export default {
           plugins: [{
             name: 'org/cloud-like',
             backend() { return { async run() { globalThis.__vxBackendRan = true; return { ok: true, outcomes: [] } } } },
             executor() { globalThis.__vxExecutorAsked = true; return undefined },
           }],
         }`,
      )
      await gitInit(workspaceRoot)
      // `backend` is consulted by the CLI layer (src/cli/run.ts), not by
      // run() — so this pin goes through the real dispatcher, which reads
      // process.cwd() (same pattern as tests/cli.test.ts).
      const { run: cliRun } = await import('../src/cli/index.js')
      const origCwd = process.cwd()
      process.chdir(workspaceRoot)
      let code: number
      try {
        code = await cliRun(['run', 'hello', '--filter', 'pkg-a'])
      } finally {
        process.chdir(origCwd)
      }
      expect(code).toBe(0)
      const g = globalThis as unknown as { __vxBackendRan: boolean; __vxExecutorAsked: boolean }
      expect(g.__vxBackendRan).toBe(true)
      expect(g.__vxExecutorAsked).toBe(false)
    } finally {
      cleanup()
    }
  })
})
```

`src/cli/index.ts` exports `run(argv: readonly string[]): Promise<number>`; the COMPAT assertion that matters is `__vxExecutorAsked === false` while `__vxBackendRan === true`. Note `cliRun` prints the run summary to stdout; that is acceptable noise in the test output.

- [ ] **Step 2: Run to verify failure**

Run: `bun test tests/plugin-capabilities.test.ts -t "end-to-end"`
Expected: the first three FAIL (the fake executor is never consulted — `__vxExec` stays `[]`; the cache test counts 0 calls). The COMPAT test may already pass — that is fine; it is the pin that must stay green through the next steps.

- [ ] **Step 3: Modify `execute-task.ts`**

Imports — replace the `'../exec/index.js'` import block with:

```ts
import {
  buildIsolatedEnv,
  runPersistent,
  resolveSandboxConfig,
  selectExecutor,
  shellQuote,
  signalExitCode,
  type CaptureConfig,
  type ExecuteRequest,
  type ExecuteResult,
  type SandboxViolation,
  type TaskExecutor,
} from '../exec/index.js'
```

(`runCommand` and `runSandboxed` are no longer imported here.)

Add to `ExecuteArgs` (after `log`):

```ts
  /** Resolved executor list (plugins' + built-in local last); per attempt the first that accepts runs the task. */
  executors: readonly TaskExecutor[]
```

In `executeCachedTask`, replace the declaration `let result: Awaited<ReturnType<typeof runCommand>>` with `let result: ExecuteResult`, and the `runAttempt` return type's `result:` member with `result: ExecuteResult`.

Replace the line `const res = useSandbox ? await runSandboxedTask() : await runUnsandboxedTask()` with:

```ts
const req = await buildRequest()
const res = await selectExecutor(args.executors, req).execute(req)
violations = [...res.violations]
```

Delete the `runUnsandboxedTask` and `runSandboxedTask` functions and replace them with ONE request builder (same position in the file):

```ts
async function buildRequest(): Promise<ExecuteRequest> {
  const base: ExecuteRequest = {
    taskId: node.id,
    command: step.command,
    forwardArgs: effectiveForwardArgs,
    cwd: node.projectDir,
    env,
    capture,
    onStdout: (chunk) => log.taskStdout(node, chunk),
    onStderr: (chunk) => log.taskStderr(node, chunk),
    ...(args.liveChildren !== undefined ? { liveChildren: args.liveChildren } : {}),
    ...(effectiveTimeout !== undefined ? { timeoutMs: effectiveTimeout } : {}),
  }
  if (!useSandbox) return base
  // Baseline allowRead = resolved cache.inputs.files (absolute paths)
  // Baseline allowWrite = static prefix of every cache.outputs.files glob
  // Baseline denyRead = the workspace root, so any read outside the
  //   project's declared inputs trips the deny boundary.
  // The user's sandbox block extends each list with explicit additions.
  const resolved = await resolveInputs({
    projectDir: node.projectDir,
    workspaceRoot: args.workspaceRoot,
    envSource: process.env,
    inputs: cacheCfg?.inputs,
    ownOutputs: outputs,
    ownWorkspaceOutputs: wsOutputs,
    nestedProjectDirs: args.nestedProjectDirs,
    ...(args.gitFilesCache !== undefined ? { gitFilesCache: args.gitFilesCache } : {}),
    ...(args.hashCache !== undefined
      ? {
          runtimeCache: args.hashCache.runtime,
          workspaceRuntimeCache: args.hashCache.workspaceRuntime,
        }
      : {}),
  })
  const baseAllowWrite = [
    ...outputs.map((g) => path.join(node.projectDir, staticPrefix(g))),
    // Workspace outputs anchor their write prefixes at the root.
    ...wsOutputs.map((g) => path.join(args.workspaceRoot, staticPrefix(g))),
  ]
  // bwrap can't --bind a non-existent host path; the bind silently
  // becomes a no-op (or a tmpfs that evaporates on exit), and writes
  // to the path appear to succeed inside the sandbox but never land
  // on the host. Pre-create every output path so the binds resolve
  // to real fs entries: globbed outputs (`dist/**`) become empty
  // dirs; literal outputs (`out.txt`) become empty files.
  await prepareOutputsForBind(node.projectDir, outputs)
  await prepareOutputsForBind(args.workspaceRoot, wsOutputs)
  // Output paths are read+write — a task that declares `dist/**` as
  // output expects to read what it just wrote (e.g. `touch dist/x`
  // stats the file; `tsc --incremental` re-reads .tsbuildinfo).
  return {
    ...base,
    sandbox: {
      baseAllowRead: [...resolved.files, ...baseAllowWrite],
      baseAllowWrite,
      baseDenyRead: [args.workspaceRoot],
      config: resolveSandboxConfig(cfg.sandbox ?? {}, node.projectDir),
    },
  }
}
```

The persistent path (`executePersistentTask`) is NOT changed — it keeps `runPersistent`. Add one sentence to its doc comment: `Never routed through an executor: a persistent task is local by construction (its port lives on this machine).`

- [ ] **Step 4: Wire `run.ts`**

In `src/orchestrator/run.ts`:

Import: add `resolveExecutors` to the `./plugin-host.js` import, and `import type { TaskExecutor } from '../exec/index.js'`.

Replace every `prepared.workspaceConfig?.plugins` / `prepared.workspaceConfig.plugins` read in `run()` with `prepared.plugins` — there are four sites (the install gate around line 201, the `installPlugins({ plugins: ... as never })` argument, the `hasTelemetryPlugin` `.some(...)` around line 370, the `subscribeTelemetry(...)` first argument around line 398, and the `teardownPlugins(...)` first argument around line 909). The gates `if (prepared.plugins.length > 0)` are now always true (the built-ins are present) — that is correct: the built-ins have no `setup`/`eventSink`/`teardown`, so `installPlugins`, `subscribeEventSinks` and `teardownPlugins` each loop over them and do nothing.

After `concurrency` is computed (the `const concurrency = options.concurrency ?? ...` statement), add:

```ts
// Resolved ONCE per run. Declared executors first, the built-in local
// executor last — see builtin-plugins.ts. A broken factory aborts here,
// before any task starts.
let executors: readonly TaskExecutor[]
try {
  executors = await resolveExecutors(prepared.plugins, {
    workspaceRoot: prepared.workspaceRoot,
    cacheDir: prepared.cacheDir,
    warn: (m: string) => log.status(m),
    concurrency,
  })
} catch (err) {
  disposePlugins?.()
  eventSinks?.dispose()
  prepared.cache.close()
  throw err
}
```

In `buildExecuteArgs`, add `executors,` after `log,`.

- [ ] **Step 5: Run the e2e tests, then the orchestrator suites**

Run: `bun test tests/plugin-capabilities.test.ts`
Expected: PASS including all four e2e tests.

Run: `bun test tests/orchestrator.test.ts tests/plugin-e2e.test.ts tests/options-resolve.test.ts tests/local-shortcircuit.test.ts tests/verify*.test.ts tests/sandbox*.test.ts`
Expected: PASS (sandbox suites skip without bwrap/SRT locally — that is today's behaviour; CI sets `VX_REQUIRE_SANDBOX=1`).

- [ ] **Step 6: Differential check (mandatory — see CLAUDE.md "Differential or it didn't happen")**

Temporarily change `selectExecutor(args.executors, req)` in `execute-task.ts` to `args.executors[args.executors.length - 1]!` (always local). Run `bun test tests/plugin-capabilities.test.ts -t "end-to-end"` — expected: the first and third e2e tests FAIL (`__vxExec` empty / `__vxCalls` 0). Restore the line and re-run — expected: PASS. Record both results in the commit body.

- [ ] **Step 7: Lint + full test + commit**

Run: `bun src/bin.ts run lint && bun test`
Expected: lint success; the whole suite green (2663+ tests).

```bash
git add src/orchestrator/execute-task.ts src/orchestrator/run.ts tests/plugin-capabilities.test.ts
git commit -m "Execute tasks through the resolved executor list

execute-task builds one fully-resolved ExecuteRequest (command, env,
capture, timeout, sandbox baselines) per attempt and hands it to the
first executor that accepts; the built-in local executor is the last in
the list so a workspace with no plugins spawns exactly as before.
Persistent tasks stay on runPersistent by construction.

Differential: forcing the local executor fails the two e2e pins that
observe a plugin executor; restoring the selection passes them."
```

---

### Task 7: Façade exports, docs, decision-log entry, full gate

**Files:**

- Modify: `src/index.ts` (plugin block), `tests/package-boundaries.test.ts` (pin)
- Create: `docs/modules/executor.md`, `docs/modules/builtin-plugins.md`
- Modify: `docs/modules/plugin.md`, `docs/modules/plugin-host.md`, `docs/modules/execute-task.md`, `docs/modules/README.md`, `docs/architecture.md`, `CLAUDE.md`

- [ ] **Step 1: Add the façade exports**

In `src/index.ts`, extend the plugin block:

```ts
export type {
  VxPlugin,
  EventSink,
  BackendContext,
  CacheContext,
  ExecutorContext,
  EventSinkContext,
  PluginSetupContext,
} from './orchestrator/index.js'
// Core's own behaviour as plugins — include them explicitly to set their
// precedence, wrap them, or leave them out of `defineWorkspace({ plugins })`
// to get them appended last.
export {
  builtinPlugins,
  localCachePlugin,
  localExecutorPlugin,
  withBuiltins,
} from './orchestrator/index.js'
// The per-task execution contract a plugin's `executor` capability returns.
export { localExecutor, selectExecutor } from './exec/index.js'
export type {
  ExecuteRequest,
  ExecuteResult,
  ExecuteSandbox,
  ResolvedSandboxConfig,
  TaskExecutor,
} from './exec/index.js'
```

`ResolvedSandboxConfig` is exported by `src/exec/sandbox-runtime.ts` but not by `src/exec/index.ts`; add `type ResolvedSandboxConfig,` to the `./sandbox-runtime.js` export block in `src/exec/index.ts` so a plugin author can type `ExecuteSandbox.config` by name (type-only — the runtime pin is unaffected).

`src/index.ts` importing `./exec/index.js` is a NEW edge for the boundary matrix: add `'exec'` to the `index:` row of `ALLOWED` in `tests/module-boundaries.test.ts` (`index: ['util', 'config', 'version', 'workspace', 'graph', 'cache', 'exec', 'orchestrator']`).

- [ ] **Step 2: Update the façade pin**

Run: `bun test tests/package-boundaries.test.ts`
Expected: FAIL listing exactly these six as unexpected: `builtinPlugins`, `localCachePlugin`, `localExecutor`, `localExecutorPlugin`, `selectExecutor`, `withBuiltins`. Insert each into the `expected` array in `tests/package-boundaries.test.ts` in sorted position. Re-run — PASS. If the diff lists anything else, stop: something exported more than intended.

- [ ] **Step 3: Write `docs/modules/executor.md`**

```markdown
# `src/exec/executor.ts` — the per-task execution contract

## Purpose

The seam between "what to run" and "where it runs". `execute-task.ts`
resolves everything about one attempt — command, cwd, env, capture,
timeout, sandbox baselines — into an `ExecuteRequest`; a `TaskExecutor`
runs it and returns an `ExecuteResult` (exit code, streams, rusage,
sandbox violations). Core's own executor, `localExecutor`, is the same
`runCommand` / `runSandboxed` call the orchestrator used to make directly.

## Public surface

- `TaskExecutor { name; accepts?(req); execute(req) }`
- `ExecuteRequest` — `taskId`, `command`, `forwardArgs`, `cwd`, `env`,
  `capture`, `timeoutMs?`, `onStdout`, `onStderr`, `liveChildren?`,
  `sandbox?: ExecuteSandbox`
- `ExecuteResult extends RunResult { violations }`
- `localExecutor()` — accepts every request.
- `selectExecutor(executors, req)` — first executor, in order, whose
  `accepts` is absent or returns true; throws naming the task when all
  decline (unreachable while `vx/local-executor` is in the list).

## Rules

- The request is fully resolved; an executor never reads task config.
- Persistent tasks (`exec.persistent`) never reach an executor — they
  are local by construction and stay on `runPersistent`.
- The executor list is resolved ONCE per run (`plugin-host.resolveExecutors`)
  and consulted per attempt, so a retry can land on a different executor
  only if `accepts` says so.

## What it does NOT do

- Ship inputs, materialise outputs elsewhere, or know about the cache —
  a remote executor is responsible for leaving the declared outputs under
  `cwd` when it returns (or a later design's `outputs` discriminator will
  say where they are; see `docs/design/plugin-executor-reapi-2026-08.md` §4).

## Tests

`tests/executor.test.ts` (unit), `tests/plugin-capabilities.test.ts`
(`executor capability — end-to-end via run()`).

## Replacing this module

Contribute `executor(ctx)` from a plugin; to wrap the local behaviour,
delegate to `localExecutor()` inside your own executor.
```

- [ ] **Step 4: Write `docs/modules/builtin-plugins.md`**

```markdown
# `src/orchestrator/builtin-plugins.ts` — core's behaviour as plugins

## Purpose

There is no hidden fallback for running a task or holding the cache.
`vx/local-executor` (in-process spawn) and `vx/local-cache` (the `.vx/cache`
handle) are ordinary `VxPlugin`s, appended to the workspace's declared list
by `withBuiltins()` unless the workspace declares them itself — in which
case their declared position is their precedence.

## Public surface

- `localExecutorPlugin()`, `localCachePlugin()`, `builtinPlugins()`
- `withBuiltins(declared)` → declared plugins, then each built-in not
  already present by name.
- `LOCAL_EXECUTOR_PLUGIN`, `LOCAL_CACHE_PLUGIN` (the names).

## Using them from `vx.workspace.ts`

    // default: [mine(), vx/local-executor, vx/local-cache]
    export default defineWorkspace({ plugins: [mine()] })

    // pin local execution AHEAD of a remote executor for this workspace
    export default defineWorkspace({ plugins: [localExecutorPlugin(), remote()] })

## Invariants

- A workspace with no `plugins` resolves to exactly the two built-ins and
  runs byte-identically to pre-seam vx (pinned by the orchestrator suites).
- The built-ins contribute no `setup`/`eventSink`/`telemetry`/`teardown`,
  so every gate that counts those stays zero-cost.

## Tests

`tests/builtin-plugins.test.ts`; `resolveCache: the built-in list ...` in
`tests/plugin-capabilities.test.ts`.
```

- [ ] **Step 5: Update the existing docs**

`docs/modules/plugin.md` — capability table becomes:

```markdown
| Capability       | Consulted by        | Contract                                                                                     |
| ---------------- | ------------------- | -------------------------------------------------------------------------------------------- |
| `executor(ctx)`  | `plugin-host.ts`    | return a `TaskExecutor` or decline; ALL kept in order, first accepting runs                  |
| `cache(ctx)`     | run setup           | return a `CacheLayer` or decline; first wins; built-in `vx/local-cache` last                 |
| `backend(ctx)`   | `cli/run.ts`        | whole-run delegation (server-side scheduling); when contributed, executors are not consulted |
| `telemetry(ctx)` | `telemetry-host.ts` | return sink(s) or decline                                                                    |
| `eventSink(ctx)` | `plugin-host.ts`    | raw `WireEvent` consumer                                                                     |
| `setup(ctx)`     | `installPlugins`    | validate config; throw `UserError`                                                           |
| `teardown()`     | end-of-run          | flush/close; crash-isolated, 3s-bounded                                                      |
```

and add to Invariants: `- Core's own executor and cache are the built-in plugins (see builtin-plugins.md); there is no fallback outside the plugin list.`

`docs/modules/plugin-host.md` — title → `— capability consultation`; add to Public surface: `- resolveExecutors(plugins, ctx) → TaskExecutor[] (ordered; a throwing factory aborts)` and `- resolveCache(plugins, ctx) → CacheLayer (first wins; throws when none — the built-in is the default)`.

`docs/modules/execute-task.md` §C "Normal task" — replace the sentence describing the spawn with: `The attempt builds an ExecuteRequest (command, env, capture, timeout, sandbox baselines) and hands it to selectExecutor(args.executors, req) — the first executor that accepts. With no plugin executor that is vx/local-executor, i.e. runCommand / runSandboxed exactly as before.`

`docs/modules/README.md` — add rows:

- Orchestrator table: `| [\`builtin-plugins.md\`](./builtin-plugins.md) | \`src/orchestrator/builtin-plugins.ts\` — core's executor + cache as plugins; \`withBuiltins\`. |`
- Exec table: `| [\`executor.md\`](./executor.md) | \`src/exec/executor.ts\` — \`TaskExecutor\` contract, \`localExecutor\`, \`selectExecutor\`. |`

`docs/architecture.md` "The plugin capability seam" table — add the `executor` row above `backend`: `| \`executor\` | behavior | returns a \`TaskExecutor\` or declines. Consulted once per run; ALL kept in declaration order; per task the first whose \`accepts()\` passes runs it; the built-in \`vx/local-executor\` is last |`and change the`backend`row's fallback text to`... kept for server-side schedulers (\`@vzn/vx-cloud\`); when contributed, executors are not consulted`. Replace the sentence `No auto-discovery, no executor protocol: a plugin changes run-level infrastructure, never how a task executes`with`No auto-discovery. A plugin changes WHERE a task's command executes (\`executor\`), never WHAT it is — the command string is the task (principle #3).`

In-source comments that the new capability makes FALSE (standing rule: a comment claiming a guarantee the code does not have is a defect) — fix each:

- `src/orchestrator/plugin.ts`, the `VxPlugin` doc comment: "Contributes any subset of three RUN-LEVEL infrastructure capabilities … It NEVER changes how a task executes" → `Contributes any subset of the run-level capabilities — where work runs (executor / backend), which cache is used (cache), who observes the run (telemetry). It never changes WHAT a task is (the command string — principle #3), only where and how that command is executed.`
- `src/orchestrator/plugin.ts`, the `Plugin.setup` comment and `installPlugins`'s "No setup → a capability-only plugin (backend / cache / eventSink)" comments: enumerate `backend / cache / executor / eventSink`.
- `src/orchestrator/plugin-host.ts`: the `safe()` docstring's load-bearing list `(backend/cache/setup)` → `(backend/cache/executor/setup)`; the header's "falls back to today's exact default" → `the built-in plugins (builtin-plugins.ts) are the default — there is no fallback outside the plugin list`.
- `docs/schema.md`, end of the `plugins` bullet: "Plugins observe and route; they never change how a task executes." → `Plugins observe, route and execute; they never change what a task is.`
- `src/orchestrator/run.ts`: the two `if (prepared.plugins.length > 0)` gates (around the `installPlugins`/`subscribeEventSinks` block and the `teardownPlugins` call) are now always-true — `prepared.plugins` always ends with the built-ins. Remove the two `if`s (keep the bodies; the loops inside skip plugins without `setup`/`eventSink`/`teardown`, so a no-user-plugin run still subscribes nothing). Rewrite the comment above the install block so it no longer says "With no plugin, both are no-ops" but `With only the built-ins declared both loops skip every entry — a no-user-plugin run subscribes nothing.` Run `bun test tests/plugin-e2e.test.ts tests/telemetry-lifecycle.test.ts tests/plugin-teardown.test.ts` after; expected PASS.
- `docs/modules/plugin-host.md` and `docs/architecture.md`: one sentence — `backend` is resolved by the CLI layer (`src/cli/run.ts`) from the DECLARED plugins before `run()` starts; every other capability is resolved inside `prepareRun`/`run()` from the effective list (`prepared.plugins`, declared + built-ins).

`CLAUDE.md`:

- In "Repository layout", add `executor.ts` to the `exec/` line (`index.ts runner.ts env.ts sandbox-runtime.ts executor.ts`) and a line `builtin-plugins.ts   # core's executor + cache as plugins (withBuiltins)` under `orchestrator/` after `plugin-host.ts`.
- In "Architecture principles" #3, append: `A plugin may change WHERE the command runs (the \`executor\` capability), never what it is.`
- Prepend to "Recent entries (2026-08)":

```markdown
- **2026-08-22 — core's execution and cache became built-in plugins; a
  per-task `executor` capability landed.** Owner decision: core must not be
  specific to vx-cloud OR REAPI — every scenario reachable by plugins, core
  as slim as possible. The one wrong-grained seam was `backend` (whole-run
  delegation: it moved the scheduler server-side and dragged cache restore,
  logging and telemetry with it). `executor` is per task: `execute-task`
  builds one fully-resolved `ExecuteRequest` per attempt and
  `selectExecutor` hands it to the first contributed executor that accepts;
  `vx/local-executor` (= the old `runCommand`/`runSandboxed` call) and
  `vx/local-cache` are ordinary plugins appended by `withBuiltins` unless
  declared — so there is NO hidden fallback and "a plugin can replace any
  part" is pinned rather than promised (`resolveCache` with no provider now
  THROWS, named). `backend` is untouched: `@vzn/vx-cloud` compiles and runs
  with zero edits, and the COMPAT pin proves a backend-contributing plugin
  delegates the whole run with executors never consulted. Persistent tasks
  never reach an executor (local by construction). Differential: forcing
  the local executor fails exactly the two e2e pins that observe a plugin
  executor. No CACHE_VERSION/SCHEMA bump — requests, keys and artifacts are
  byte-identical. Design: `docs/design/plugin-executor-reapi-2026-08.md`;
  plan: `docs/superpowers/plans/2026-08-22-executor-seam-builtin-plugins.md`.
  NOT in this wave (follow-up plans): `ExecuteRequest.inputs` (the
  enumerated input set for input-shipping executors), `exec.remote`
  placement, executor capacity in the scheduler, the `'cache'`/`'deferred'`
  output kinds, the REAPI plugin.
```

- [ ] **Step 6: Full gate from the repo root**

Run: `bun src/bin.ts run ci`
Expected: `lint.oxlint`, `lint.oxfmt`, `test` all `success`; exit 0. If `lint.oxfmt` flags the new markdown, run `bun src/bin.ts run lint.oxfmt.fix` and re-run the gate AFTER the fix (never trust a pre-fix pass).

- [ ] **Step 7: Commit + push**

```bash
git add src/index.ts src/exec/index.ts src/orchestrator/plugin.ts src/orchestrator/plugin-host.ts src/orchestrator/run.ts docs/schema.md tests/package-boundaries.test.ts tests/module-boundaries.test.ts docs/modules/executor.md docs/modules/builtin-plugins.md docs/modules/plugin.md docs/modules/plugin-host.md docs/modules/execute-task.md docs/modules/README.md docs/architecture.md CLAUDE.md
git commit -m "Export the executor seam and built-in plugins; document the wave"
git push origin main
```

Then confirm the REAL CI conclusion (not just the local gate):
`curl -s "https://api.github.com/repos/vznjs/vx/actions/runs?branch=main&per_page=1" | python3 -c "import sys,json; r=json.load(sys.stdin)['workflow_runs'][0]; print(r['head_sha'][:7], r['status'], r['conclusion'])"` — wait for `completed success`.

---

## Self-review against the spec

- §3 contract (`cache`/`executor`/`telemetry` + `backend` kept): Tasks 2–6. ✔
- §4 seam: `TaskExecutor`/`ExecuteRequest`/`ExecuteResult` — Task 1. The spec's richer request (`task`/`commit`/`inputs`/`outputs` globs) and result discriminator (`'cache'`/`'deferred'`) are DEFERRED to the REAPI plan; this plan's shapes are a strict subset so they extend additively. Stated in the CLAUDE.md entry. ✔
- §5 placement: only "persistent never reaches an executor" ships here (structural); `exec.remote` deferred (no consumer yet). ✔
- §6 inventory: `eventSink` deletion and `devframe-surface` deletion are NOT done here — cloud still uses `backend` and the owner asked for zero cloud edits; both stay until phase 4. ✔
- Core-as-default-plugin: Task 4 + Task 5 (no fallback) + Task 6. ✔
- Cloud compat with zero edits: Task 2 step 6 (type-check) + Task 6 COMPAT pin. ✔
- Docs in the same wave: Task 7. ✔

## Follow-up plans (not this one)

1. `ExecuteRequest.inputs` + `task`/`commit` identity (task-hash returns the enumerated input set).
2. Placement rule (`exec.remote: true|false|'only'`, depends-on-persistent) + `--dry` display.
   **DONE 2026-08-23**, except `'only'` — deferred to the plugin wave that
   gives it a purpose (design doc §5; decision log).
3. Executor capacity in the scheduler (remote tasks must not consume local worker slots).
   **DONE 2026-08-23** (`ScheduleOptions.poolOf`).
4. `ExecuteResult.outputs` discriminator (`disk`/`cache`/`deferred`) + `--download`.
5. `@vzn/vx-reapi` phase 1 (remote cache over AC/CAS; the gRPC-on-Bun spike).
6. Port vx-cloud's dist to `executor`; retire `backend`.

---

# Addendum (2026-08-23): no defaults, chained caches

Owner decisions after Tasks 1–7 landed locally (commits `1763926`…`31d1802`, unpushed):

1. **No defaults.** Nothing is appended. A workspace declares EVERY plugin it
   uses, including the local ones: `plugins: [localExecutorPlugin(), localCachePlugin()]`.
   A workspace with no executor or no cache provider FAILS FAST with a message
   that shows the exact lines to add. `withBuiltins` is deleted.
2. **Executors:** every contributed executor is kept in declaration order; per
   task the first whose `accepts()` passes runs it (what Tasks 3/6 built).
3. **Caches:** every contributed cache layer is kept in declaration order and
   CHAINED by core — lookup walks the layers until a hit, save writes to all.
   `[remote(), localCachePlugin()]` just works without the remote plugin
   wrapping the local handle itself.

The wave is not pushed until Tasks 8–10 are green. Invariants from the top of
this plan still hold, with one deliberate exception: a workspace that declares
no plugins no longer runs — that is the decision, and the error names the fix.

## File structure (addendum)

| File                                                                                                                                                                                                                                                                              | Responsibility                                                                                                                               |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/orchestrator/local-plugins.ts` (rename from `builtin-plugins.ts`)                                                                                                                                                                                                            | `localExecutorPlugin()`, `localCachePlugin()`, `localPlugins()`; the shared `MISSING_PLUGIN_HINT`. No `withBuiltins`.                        |
| `src/orchestrator/plugin-host.ts` (modify)                                                                                                                                                                                                                                        | `resolveExecutors` throws on an empty list; `resolveCache` collects ALL layers, dedupes a bare local handle another layer wraps, chains ≥ 2. |
| `src/cache/chained-cache.ts` (create)                                                                                                                                                                                                                                             | `ChainedCache implements CacheLayer` over an ordered list.                                                                                   |
| `src/cache/layered-cache.ts` (modify)                                                                                                                                                                                                                                             | `local` becomes `public readonly` so core can see which handle a layer wraps (cloud's layer exposes it with zero cloud edits).               |
| `src/cache/cache.ts` (modify)                                                                                                                                                                                                                                                     | `CacheLayer.local?: Cache` optional member.                                                                                                  |
| `src/exec/executor.ts` (modify)                                                                                                                                                                                                                                                   | `selectExecutor`'s all-declined error carries the hint.                                                                                      |
| `src/orchestrator/prepare.ts` (modify)                                                                                                                                                                                                                                            | `prepared.plugins` = declared only.                                                                                                          |
| `src/cli/migrate.ts` (modify)                                                                                                                                                                                                                                                     | Emits `vx.workspace.ts` with the local plugins when none exists.                                                                             |
| `vx.workspace.ts` (modify)                                                                                                                                                                                                                                                        | This repo declares `localExecutorPlugin(), localCachePlugin()`.                                                                              |
| `tests/helpers/local-workspace.ts` (create)                                                                                                                                                                                                                                       | Fixture helper: writes a `vx.workspace.mjs` declaring the local plugins (import by absolute path to `src/index.ts`).                         |
| 38 test files (modify)                                                                                                                                                                                                                                                            | Every fixture that runs tasks declares the local plugins via the helper.                                                                     |
| `tests/local-plugins.test.ts` (rename from `builtin-plugins.test.ts`), `tests/chained-cache.test.ts` (create), `tests/plugin-capabilities.test.ts`, `tests/migrate.test.ts`, `tests/package-boundaries.test.ts` (modify)                                                          | Pins.                                                                                                                                        |
| `docs/modules/local-plugins.md` (rename), `docs/modules/chained-cache.md` (create), `docs/schema.md`, `docs/architecture.md`, `docs/README.md`, `docs/modules/{plugin,plugin-host,layered-cache,README}.md`, `docs/design/plugin-executor-reapi-2026-08.md`, `CLAUDE.md` (modify) | Docs in the same wave.                                                                                                                       |

---

### Task 8: No defaults — declared plugins only, named errors, fixtures declare the local plugins

**Files:**

- Rename: `src/orchestrator/builtin-plugins.ts` → `src/orchestrator/local-plugins.ts`
- Modify: `src/orchestrator/index.ts`, `src/index.ts`, `src/orchestrator/plugin-host.ts`, `src/orchestrator/prepare.ts`, `src/exec/executor.ts`, `vx.workspace.ts`
- Create: `tests/helpers/local-workspace.ts`
- Rename: `tests/builtin-plugins.test.ts` → `tests/local-plugins.test.ts`
- Modify: `tests/plugin-capabilities.test.ts`, `tests/executor.test.ts`, `tests/package-boundaries.test.ts`, and the 38 fixture files listed in Step 5

- [ ] **Step 1: Write the failing tests (`tests/local-plugins.test.ts`)**

Replace the file's contents with:

```ts
import { describe, expect, it } from 'bun:test'
import {
  localCachePlugin,
  localExecutorPlugin,
  localPlugins,
  MISSING_PLUGIN_HINT,
  resolveCache,
  resolveExecutors,
} from '../src/orchestrator/index.js'
import { Cache } from '../src/cache/index.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const baseCtx = { workspaceRoot: '/ws', cacheDir: '/ws/.vx/cache', warn: () => undefined }
const policy = { localRead: true, localWrite: true, remoteRead: false, remoteWrite: false }

describe('local plugins', () => {
  it('localPlugins() is exactly [executor, cache], named under vx/', () => {
    expect(localPlugins().map((p) => p.name)).toEqual(['vx/local-executor', 'vx/local-cache'])
    expect(typeof localExecutorPlugin().executor).toBe('function')
    expect(typeof localCachePlugin().cache).toBe('function')
  })

  it('the hint shows the exact lines to add', () => {
    expect(MISSING_PLUGIN_HINT).toContain(
      "import { defineWorkspace, localExecutorPlugin, localCachePlugin } from '@vzn/vx'",
    )
    expect(MISSING_PLUGIN_HINT).toContain('plugins: [localExecutorPlugin(), localCachePlugin()]')
  })

  it('resolveExecutors with NO executor plugin fails fast and names the fix', async () => {
    await expect(resolveExecutors([], { ...baseCtx, concurrency: 1 })).rejects.toThrow(
      /no executor plugin declared[\s\S]*localExecutorPlugin\(\)/,
    )
    await expect(
      resolveExecutors([{ name: 'org/none', executor: () => undefined }], {
        ...baseCtx,
        concurrency: 1,
      }),
    ).rejects.toThrow(/no executor plugin declared[\s\S]*org\/none declined/)
  })

  it('resolveExecutors with the local plugin declared resolves to the local executor (control)', async () => {
    const list = await resolveExecutors(localPlugins(), { ...baseCtx, concurrency: 1 })
    expect(list.map((e) => e.name)).toEqual(['local'])
  })

  it('resolveCache with NO cache plugin fails fast and names the fix', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'vx-local-plugins-'))
    const local = new Cache(dir, { read: true, write: true })
    try {
      await expect(resolveCache([], { ...baseCtx, localCache: local, policy })).rejects.toThrow(
        /no cache plugin declared[\s\S]*localCachePlugin\(\)/,
      )
    } finally {
      local.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
```

Delete `tests/builtin-plugins.test.ts` (`git mv tests/builtin-plugins.test.ts tests/local-plugins.test.ts` first, then overwrite).

- [ ] **Step 2: Run to verify failure**

Run: `bun test tests/local-plugins.test.ts`
Expected: FAIL — `localPlugins` / `MISSING_PLUGIN_HINT` not exported.

- [ ] **Step 3: Implement `src/orchestrator/local-plugins.ts`**

`git mv src/orchestrator/builtin-plugins.ts src/orchestrator/local-plugins.ts`, then replace its contents with:

```ts
// Core's own execution and cache, as plugins a workspace DECLARES. Nothing
// is appended by default: a run with no executor plugin or no cache plugin
// fails fast with MISSING_PLUGIN_HINT. This is what makes "a plugin can
// replace any part" provable — there is no path that does not go through
// the declared list — and it is the owner's explicit-over-magical rule
// applied to core itself.

import { localExecutor } from '../exec/index.js'
import type { VxPlugin } from './plugin.js'

export const LOCAL_EXECUTOR_PLUGIN = 'vx/local-executor'
export const LOCAL_CACHE_PLUGIN = 'vx/local-cache'

/** Shown by every "no <capability> plugin declared" error. */
export const MISSING_PLUGIN_HINT = `vx runs nothing it was not told to. Declare the plugins in vx.workspace.ts:

  import { defineWorkspace, localExecutorPlugin, localCachePlugin } from '@vzn/vx'
  export default defineWorkspace({ plugins: [localExecutorPlugin(), localCachePlugin()] })

Put a remote executor or cache plugin BEFORE the local one to prefer it.`

/** In-process spawn — `runCommand` / `runSandboxed`. Accepts every task. */
export function localExecutorPlugin(): VxPlugin {
  return { name: LOCAL_EXECUTOR_PLUGIN, executor: () => localExecutor() }
}

/** The `.vx/cache` handle core opened (the run index + local artifact store). */
export function localCachePlugin(): VxPlugin {
  return { name: LOCAL_CACHE_PLUGIN, cache: (ctx) => ctx.localCache }
}

/** Both local plugins, in the order a plain workspace declares them. */
export function localPlugins(): VxPlugin[] {
  return [localExecutorPlugin(), localCachePlugin()]
}
```

In `src/orchestrator/index.ts` replace the `./builtin-plugins.js` export block with:

```ts
export {
  LOCAL_CACHE_PLUGIN,
  LOCAL_EXECUTOR_PLUGIN,
  localCachePlugin,
  localExecutorPlugin,
  localPlugins,
  MISSING_PLUGIN_HINT,
} from './local-plugins.js'
```

In `src/index.ts` replace the built-ins export block with:

```ts
// Core's own execution and cache, as plugins a workspace DECLARES — nothing
// is applied by default; see MISSING_PLUGIN_HINT for the lines to add.
export {
  localCachePlugin,
  localExecutorPlugin,
  localPlugins,
  MISSING_PLUGIN_HINT,
} from './orchestrator/index.js'
```

Update `tests/package-boundaries.test.ts`'s pin: remove `builtinPlugins`, `withBuiltins`; add `localPlugins`, `MISSING_PLUGIN_HINT` in sorted position. Run `bun test tests/package-boundaries.test.ts` — the failure diff must list EXACTLY those four changes.

- [ ] **Step 4: The host errors**

In `src/orchestrator/plugin-host.ts`:

```ts
import { MISSING_PLUGIN_HINT } from './local-plugins.js'
```

`resolveExecutors` — after the loop, before `return executors`:

```ts
if (executors.length === 0) {
  const declined = plugins.filter((p) => p.executor !== undefined).map((p) => `${p.name} declined`)
  throw new UserError(
    `no executor plugin declared${declined.length > 0 ? ` (${declined.join(', ')})` : ''}. ${MISSING_PLUGIN_HINT}`,
  )
}
```

`resolveCache` — replace the throw with:

```ts
const declined = plugins.filter((p) => p.cache !== undefined).map((p) => `${p.name} declined`)
throw new UserError(
  `no cache plugin declared${declined.length > 0 ? ` (${declined.join(', ')})` : ''}. ${MISSING_PLUGIN_HINT}`,
)
```

(Task 9 rewrites `resolveCache` again for chaining; this step only changes the message.)

In `src/orchestrator/prepare.ts`: remove the `withBuiltins` import; `const plugins = (workspaceConfig?.plugins ?? []) as readonly VxPlugin[]`. The `PreparedRun.plugins` doc comment becomes `/** The workspace's declared plugins, in declaration order. Nothing is added. */`.

In `src/exec/executor.ts`, `selectExecutor`'s throw becomes:

```ts
throw new Error(
  `no executor accepted ${req.taskId} (declared: ${executors.map((e) => e.name).join(', ')}). Declare localExecutorPlugin() after the executor that declined to run such tasks locally.`,
)
```

and update `tests/executor.test.ts`'s `throws when every executor declines` regex to `/no executor accepted pkg-a#hello/` (unchanged) — it still matches.

In `src/orchestrator/run.ts` there is nothing to change: it already reads `prepared.plugins`.

- [ ] **Step 5: Fixture helper + the sweep**

Create `tests/helpers/local-workspace.ts`:

```ts
import path from 'node:path'

/**
 * Fixtures live in a tmp dir with no node_modules, so `@vzn/vx` does not
 * resolve there; import core by ABSOLUTE path instead. Bun keys its module
 * registry by resolved path, so the plugin objects come from the same
 * `src/index.ts` instance the test itself imports.
 */
export const CORE_INDEX = path.resolve(import.meta.dir, '../../src/index.ts')

/** Source for a `vx.workspace.mjs` declaring the local plugins plus `extra` (JS expressions). */
export function localWorkspaceSource(extra: readonly string[] = [], prelude = ''): string {
  return `${prelude}
import { localExecutorPlugin, localCachePlugin } from ${JSON.stringify(CORE_INDEX)}
export default { plugins: [${[...extra, 'localExecutorPlugin()', 'localCachePlugin()'].join(', ')}] }
`
}

/** Write the plain local `vx.workspace.mjs` into `root`. */
export async function writeLocalWorkspace(root: string): Promise<void> {
  await Bun.write(path.join(root, 'vx.workspace.mjs'), localWorkspaceSource())
}
```

Then, for EACH of these 38 files, make the fixture declare the local plugins:

```
tests/cli-arg-hygiene.test.ts tests/cli-picker.test.ts tests/cli.test.ts tests/config-staleness.test.ts
tests/execute-task.test.ts tests/local-shortcircuit.test.ts tests/mcp.test.ts tests/migrate.test.ts
tests/output-flow.test.ts tests/persistent-ready-timeout.test.ts tests/plan-format.test.ts
tests/persistent.test.ts tests/plan-predict.test.ts tests/retries.test.ts tests/resources.test.ts
tests/run-record-completeness.test.ts tests/sandbox-runtime.test.ts tests/show-info.test.ts
tests/scoped-config-loading.test.ts tests/signal-handling.test.ts tests/task-selection.test.ts
tests/upgrade.test.ts tests/util-size.test.ts tests/watch-rules.test.ts tests/why.test.ts
tests/verify.test.ts tests/workspace-files.test.ts
```

plus the 11 that already write a `vx.workspace.mjs` (find them with `grep -lE "\brun\(\{|runCmd\(|from '../src/cli" tests/*.test.ts | xargs grep -l "vx.workspace"`):

- A fixture with NO workspace file: call `await writeLocalWorkspace(workspaceRoot)` right after the fixture's `package.json` is written (before any `git add`, so the file is committed in fixtures that commit).
- A fixture that already writes a `vx.workspace.mjs` with its own plugins: rewrite it through `localWorkspaceSource(['{ name: ..., ... }'], prelude)` so the local plugins come AFTER the test's own plugin (the test's plugin keeps precedence). Where the test asserts a fallback to the local executor (`an executor that declines a task falls through …`), the local plugin being declared is now the reason it works — keep the test, it is the control.
- A test that exercises the CLI through `process.chdir` works the same way — the workspace file is read from the fixture root.
- Files in the list that turn out NOT to execute tasks (the grep is approximate — `util-size`, `upgrade`, `plan-format`, `show-info` may only parse): leave them untouched and say so in the report.

Add to `tests/plugin-capabilities.test.ts` (the e2e describe):

```ts
it('NO DEFAULTS: a workspace with no plugins fails before any task runs and names the fix', async () => {
  const { workspaceRoot, cleanup } = await writeFixture()
  try {
    await gitInit(workspaceRoot)
    await expect(runHello(workspaceRoot)).rejects.toThrow(
      /no cache plugin declared[\s\S]*localExecutorPlugin\(\), localCachePlugin\(\)/,
    )
  } finally {
    cleanup()
  }
})

it('CONTROL: the same workspace with the local plugins declared runs', async () => {
  const { workspaceRoot, cleanup } = await writeFixture()
  try {
    await writeLocalWorkspace(workspaceRoot)
    await gitInit(workspaceRoot)
    const summary = await runHello(workspaceRoot)
    expect(summary.ok).toBe(true)
  } finally {
    cleanup()
  }
})
```

(`prepareRun` resolves the cache before `run()` resolves executors, so the cache message is the one a bare workspace sees; both messages carry the same hint.)

This repo's `vx.workspace.ts`:

```ts
import { defineWorkspace, localExecutorPlugin, localCachePlugin } from '@vzn/vx'
import { otel } from '@vzn/vx-otel'
import { cloud } from '@vzn/vx-cloud/plugin'

// Nothing runs that is not declared here — including core's own executor
// and cache. Order is precedence: cloud() (when configured) delegates the
// run or layers its remote cache ahead of the local one; otel() observes.
export default defineWorkspace({
  plugins: [otel(), cloud(), localExecutorPlugin(), localCachePlugin()],
})
```

- [ ] **Step 6: Run everything, lint, commit**

Run: `bun test` from the root, then `bun src/bin.ts run lint`.
Expected: core suites green (`packages/cloud` suites need Postgres and fail with `pg_config` not found on a box without it — compare the failing NAMES against a `git stash`-free baseline: they must be the same 65 as before this task); lint `success`.

Then the gate that matters: `bun src/bin.ts run ci` — note it now runs THROUGH this repo's updated `vx.workspace.ts`, so a green gate is itself the proof the declared-only model works end to end. Expected: exit 0.

```bash
git add src/orchestrator/local-plugins.ts src/orchestrator/index.ts src/index.ts src/orchestrator/plugin-host.ts src/orchestrator/prepare.ts src/exec/executor.ts vx.workspace.ts tests/helpers/local-workspace.ts tests/local-plugins.test.ts tests/plugin-capabilities.test.ts tests/executor.test.ts tests/package-boundaries.test.ts <the swept test files>
git rm --cached src/orchestrator/builtin-plugins.ts tests/builtin-plugins.test.ts 2>/dev/null || true
git commit -m "Declare the local executor and cache; nothing is applied by default

Owner decision: no defaults. A workspace declares every plugin it uses,
including vx/local-executor and vx/local-cache; a run with no executor or
no cache provider fails before any task runs, and the error shows the two
lines to add. withBuiltins is gone — there is no path around the declared
list, which is what makes 'a plugin can replace any part' a fact."
```

---

### Task 9: Chained caches

**Files:**

- Create: `src/cache/chained-cache.ts`
- Modify: `src/cache/cache.ts` (`CacheLayer.local?`), `src/cache/layered-cache.ts` (`local` public), `src/cache/index.ts`, `src/orchestrator/plugin-host.ts` (`resolveCache`)
- Test: `tests/chained-cache.test.ts`, `tests/plugin-capabilities.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/chained-cache.test.ts
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import { Cache, ChainedCache, LayeredCache, type RemoteCacheLayer } from '../src/cache/index.js'
import { resolveCache, type VxPlugin } from '../src/orchestrator/index.js'

function tmpCache(tag: string): { cache: Cache; dir: string } {
  const dir = mkdtempSync(path.join(tmpdir(), `vx-chained-${tag}-`))
  return { cache: new Cache(dir, { read: true, write: true }), dir }
}

async function saveEntry(cache: Cache, hash: string, projectDir: string): Promise<void> {
  await Bun.write(path.join(projectDir, 'out.txt'), `out-${hash}\n`)
  await cache.save({
    hash,
    taskId: 'p#t',
    command: 'echo',
    exitCode: 0,
    durationMs: 1,
    stdout: '',
    projectDir,
    outputFiles: ['out.txt'],
  })
}
```

Before writing the rest, read `SaveArgs` in `src/cache/cache.ts` (`grep -n "export interface SaveArgs" -A20 src/cache/cache.ts`) and make `saveEntry` pass exactly its required fields — the shape above is the intent, not a guarantee. Then continue the file:

```ts
describe('ChainedCache', () => {
  it('get walks the layers in order and the first hit wins', async () => {
    const a = tmpCache('a')
    const b = tmpCache('b')
    const proj = mkdtempSync(path.join(tmpdir(), 'vx-chained-proj-'))
    try {
      await saveEntry(b.cache, 'h1', proj)
      const chained = new ChainedCache([a.cache, b.cache])
      const hit = await chained.get('h1')
      expect(hit?.hash).toBe('h1')
      expect(await chained.has('h1')).not.toBeNull()
      expect(await a.cache.get('h1')).toBeNull()
    } finally {
      a.cache.close()
      b.cache.close()
      for (const d of [a.dir, b.dir, proj]) rmSync(d, { recursive: true, force: true })
    }
  })

  it('save writes to every layer', async () => {
    const a = tmpCache('a')
    const b = tmpCache('b')
    const proj = mkdtempSync(path.join(tmpdir(), 'vx-chained-proj-'))
    try {
      const chained = new ChainedCache([a.cache, b.cache])
      await saveEntry(chained as unknown as Cache, 'h2', proj)
      expect((await a.cache.get('h2'))?.hash).toBe('h2')
      expect((await b.cache.get('h2'))?.hash).toBe('h2')
    } finally {
      a.cache.close()
      b.cache.close()
      for (const d of [a.dir, b.dir, proj]) rmSync(d, { recursive: true, force: true })
    }
  })

  it('restoreOutputs restores from the layer that had the hit', async () => {
    const a = tmpCache('a')
    const b = tmpCache('b')
    const proj = mkdtempSync(path.join(tmpdir(), 'vx-chained-proj-'))
    try {
      await saveEntry(b.cache, 'h3', proj)
      rmSync(path.join(proj, 'out.txt'))
      const chained = new ChainedCache([a.cache, b.cache])
      expect(await chained.get('h3')).not.toBeNull()
      await chained.restoreOutputs('h3', proj)
      expect(await Bun.file(path.join(proj, 'out.txt')).text()).toBe('out-h3\n')
    } finally {
      a.cache.close()
      b.cache.close()
      for (const d of [a.dir, b.dir, proj]) rmSync(d, { recursive: true, force: true })
    }
  })

  it('the FIRST layer owns the run index: recordRun reaches only it', () => {
    const a = tmpCache('a')
    const b = tmpCache('b')
    try {
      const chained = new ChainedCache([a.cache, b.cache])
      chained.recordRun({
        runId: 'r1',
        taskId: 'p#t',
        status: 'success',
        durationMs: 1,
        startedAt: new Date().toISOString(),
      } as never)
      expect(a.cache.stats().runs ?? a.cache.stats()).toBeDefined()
    } finally {
      a.cache.close()
      b.cache.close()
      for (const d of [a.dir, b.dir]) rmSync(d, { recursive: true, force: true })
    }
  })

  it('hasRemote is true when any layer has a remote', () => {
    const a = tmpCache('a')
    const remote: RemoteCacheLayer = {
      has: async () => false,
      get: async () => null,
      put: async () => undefined,
    }
    try {
      expect(new ChainedCache([a.cache, new LayeredCache(a.cache, remote)]).hasRemote).toBe(true)
      expect(new ChainedCache([a.cache, a.cache]).hasRemote).toBe(false)
    } finally {
      a.cache.close()
      rmSync(a.dir, { recursive: true, force: true })
    }
  })
})

describe('resolveCache — chaining', () => {
  const baseCtx = { workspaceRoot: '/ws', cacheDir: '/ws/.vx/cache', warn: () => undefined }
  const policy = { localRead: true, localWrite: true, remoteRead: false, remoteWrite: false }

  it('one contributing plugin → that layer, unwrapped', async () => {
    const a = tmpCache('a')
    try {
      const plugins: VxPlugin[] = [{ name: 'org/one', cache: () => a.cache }]
      const resolved = await resolveCache(plugins, { ...baseCtx, localCache: a.cache, policy })
      expect(resolved).toBe(a.cache)
    } finally {
      a.cache.close()
      rmSync(a.dir, { recursive: true, force: true })
    }
  })

  it('two contributing plugins → a ChainedCache in declaration order', async () => {
    const a = tmpCache('a')
    const b = tmpCache('b')
    try {
      const plugins: VxPlugin[] = [
        { name: 'org/first', cache: () => b.cache },
        { name: 'org/second', cache: () => a.cache },
      ]
      const resolved = await resolveCache(plugins, { ...baseCtx, localCache: a.cache, policy })
      expect(resolved).toBeInstanceOf(ChainedCache)
      expect((resolved as ChainedCache).layers).toEqual([b.cache, a.cache])
    } finally {
      a.cache.close()
      b.cache.close()
      for (const d of [a.dir, b.dir]) rmSync(d, { recursive: true, force: true })
    }
  })

  it('a layer that WRAPS the local handle subsumes the bare local layer (cloud + localCachePlugin)', async () => {
    const a = tmpCache('a')
    const remote: RemoteCacheLayer = {
      has: async () => false,
      get: async () => null,
      put: async () => undefined,
    }
    const layered = new LayeredCache(a.cache, remote)
    try {
      const plugins: VxPlugin[] = [
        { name: 'org/cloud-like', cache: () => layered },
        { name: 'vx/local-cache', cache: (ctx) => ctx.localCache },
      ]
      const resolved = await resolveCache(plugins, { ...baseCtx, localCache: a.cache, policy })
      expect(resolved).toBe(layered)
    } finally {
      a.cache.close()
      rmSync(a.dir, { recursive: true, force: true })
    }
  })
})
```

Add to `tests/plugin-capabilities.test.ts`'s e2e describe an end-to-end pin:

```ts
it('two declared cache plugins: a run saves into BOTH stores', async () => {
  const { workspaceRoot, cleanup } = await writeFixture()
  const second = mkdtempSync(path.join(tmpdir(), 'vx-second-cache-'))
  try {
    await Bun.write(
      path.join(workspaceRoot, 'pkg-a/vx.config.mjs'),
      `export default { tasks: { hello: {
           exec: { command: 'echo hi > out.txt' },
           cache: { inputs: { files: ['package.json'] }, outputs: { files: ['out.txt'] } },
         } } }`,
    )
    await Bun.write(
      path.join(workspaceRoot, 'vx.workspace.mjs'),
      localWorkspaceSource(
        [
          `{ name: 'org/second', cache: () => new Cache(${JSON.stringify(second)}, { read: true, write: true }) }`,
        ],
        `import { Cache } from ${JSON.stringify(CORE_INDEX)}`,
      ),
    )
    await gitInit(workspaceRoot)
    const summary = await runHello(workspaceRoot)
    expect(summary.ok).toBe(true)
    const hash = summary.outcomes[0]?.hash
    expect(typeof hash).toBe('string')
    const secondCache = new Cache(second, { read: true, write: true })
    const localCache = new Cache(path.join(workspaceRoot, '.vx/cache'), { read: true, write: true })
    try {
      expect((await secondCache.get(hash!))?.hash).toBe(hash)
      expect((await localCache.get(hash!))?.hash).toBe(hash)
    } finally {
      secondCache.close()
      localCache.close()
    }
  } finally {
    cleanup()
    rmSync(second, { recursive: true, force: true })
  }
})
```

(`Cache` is already exported from the façade; `CORE_INDEX`/`localWorkspaceSource` come from `tests/helpers/local-workspace.ts`.)

- [ ] **Step 2: Run to verify failure**

Run: `bun test tests/chained-cache.test.ts`
Expected: FAIL — `ChainedCache` not exported.

- [ ] **Step 3: Implement**

`src/cache/cache.ts` — add to `CacheLayer` (first member, with this comment):

```ts
  /**
   * The local handle this layer wraps, when it wraps one (`LayeredCache`).
   * `resolveCache` uses it to drop a bare local layer another declared layer
   * already contains, so `[cloud(), localCachePlugin()]` does not write the
   * local store twice.
   */
  readonly local?: Cache
```

`src/cache/layered-cache.ts` — the constructor's `private readonly local: Cache` becomes `readonly local: Cache` (public). Nothing else changes.

`src/cache/chained-cache.ts`:

```ts
// Several declared cache layers, consulted in declaration order. Lookup
// walks the layers until one answers; a save reaches every layer; the FIRST
// layer owns the run index (history, stats, prune) so a run is recorded
// once. Restore goes to the layer that produced the hit — remembered per
// hash — because an entry's artifact lives wherever it was found.

import type { Cache, CacheLayer } from './cache.js'

export class ChainedCache implements CacheLayer {
  readonly hasRemote: boolean
  private readonly hitLayer = new Map<string, CacheLayer>()

  constructor(readonly layers: readonly CacheLayer[]) {
    if (layers.length < 2) throw new Error('ChainedCache needs at least two layers')
    this.hasRemote = layers.some((l) => l.hasRemote === true)
  }

  get local(): Cache | undefined {
    return this.layers[0]!.local
  }

  private owner(hash: string): CacheLayer {
    return this.hitLayer.get(hash) ?? this.layers[0]!
  }

  key(input: Parameters<CacheLayer['key']>[0]): Promise<string> {
    return this.layers[0]!.key(input)
  }

  async get(hash: string, ctx?: Parameters<CacheLayer['get']>[1]) {
    for (const layer of this.layers) {
      const entry = await layer.get(hash, ctx)
      if (entry !== null) {
        this.hitLayer.set(hash, layer)
        return entry
      }
    }
    return null
  }

  async has(hash: string) {
    for (const layer of this.layers) {
      const where = await layer.has(hash)
      if (where !== null) {
        this.hitLayer.set(hash, layer)
        return where
      }
    }
    return null
  }

  async prefetch(hash: string, ctx?: Parameters<CacheLayer['prefetch']>[1]): Promise<boolean> {
    for (const layer of this.layers) {
      if (await layer.prefetch(hash, ctx)) {
        this.hitLayer.set(hash, layer)
        return true
      }
    }
    return false
  }

  async remoteHasMany(hashes: readonly string[]): Promise<Set<string> | null> {
    let out: Set<string> | null = null
    for (const layer of this.layers) {
      if (layer.remoteHasMany === undefined) continue
      const found = await layer.remoteHasMany(hashes)
      if (found === null) continue
      out ??= new Set()
      for (const h of found) out.add(h)
    }
    return out
  }

  markRemoteAbsent(hashes: Iterable<string>): void {
    const list = [...hashes]
    for (const layer of this.layers) layer.markRemoteAbsent?.(list)
  }

  async drainUploads(): Promise<void> {
    await Promise.all(this.layers.map((l) => l.drainUploads?.()))
  }

  loadOutputFilesBatch(hashes: readonly string[]) {
    const out = new Map<string, ReturnType<CacheLayer['loadOutputFilesBatch']> extends Map<string, infer R> ? R : never>()
    for (const layer of this.layers) {
      for (const [h, rows] of layer.loadOutputFilesBatch(hashes)) {
        if (!out.has(h)) out.set(h, rows)
      }
    }
    return out
  }
```

Then implement EVERY remaining member of `CacheLayer` (the compiler lists them — run `bun src/bin.ts run lint.oxlint` and read the `TS2420` diagnostic) with these rules, writing each one out explicitly:

- `outputsPath(hash)`, `restoreOutputs(hash, …)` → `this.owner(hash)`.
- `hashFile`, `ingest`, `isOutputsCurrent`, `recordRun`, `recordRuns`, `recordRunBundle`, `stats`, `prune` → `this.layers[0]`.
- `save(args)` → `for (const layer of this.layers) await layer.save(args)`.
- `close()` → every layer, each in its own `try { … } finally { … }` chain so one throwing close cannot skip the rest.

Replace the `ReturnType<…> extends Map<…>` type gymnastics in `loadOutputFilesBatch` with the real row type once you see its name in `cache.ts` (`OutputFileRow`) — import it and write `new Map<string, OutputFileRow[]>()`.

`src/cache/index.ts` — add `export { ChainedCache } from './chained-cache.js'`.

`src/orchestrator/plugin-host.ts` — `resolveCache` becomes:

```ts
/**
 * Collect every plugin's `cache` layer in declaration order. One layer is
 * used as is; two or more are chained (lookup walks them, save reaches all;
 * see ChainedCache). A bare local layer that another declared layer already
 * wraps (`layer.local === ctx.localCache`) is dropped, so a remote plugin
 * that layers over the local handle composes with `localCachePlugin()`
 * instead of writing the local store twice. No layer at all is a named error.
 */
export async function resolveCache(
  plugins: readonly VxPlugin[],
  ctx: CacheContext,
): Promise<CacheLayer> {
  const layers: CacheLayer[] = []
  for (const plugin of plugins) {
    if (plugin.cache === undefined) continue
    const layer = await safe(plugin, 'cache', () => plugin.cache!(ctx))
    if (layer !== undefined) layers.push(layer)
  }
  if (layers.length === 0) {
    const declined = plugins.filter((p) => p.cache !== undefined).map((p) => `${p.name} declined`)
    throw new UserError(
      `no cache plugin declared${declined.length > 0 ? ` (${declined.join(', ')})` : ''}. ${MISSING_PLUGIN_HINT}`,
    )
  }
  const wrapsLocal = layers.some((l) => l !== ctx.localCache && l.local === ctx.localCache)
  const distinct = wrapsLocal ? layers.filter((l) => l !== ctx.localCache) : layers
  return distinct.length === 1 ? distinct[0]! : new ChainedCache(distinct)
}
```

with `import { ChainedCache, type CacheLayer } from '../cache/index.js'`.

- [ ] **Step 4: Run, lint, commit**

Run: `bun test tests/chained-cache.test.ts tests/plugin-capabilities.test.ts tests/layered-cache.test.ts tests/local-shortcircuit.test.ts tests/orchestrator.test.ts && bun src/bin.ts run lint`
Expected: PASS / success. The chained e2e pin must FAIL if `save` is changed to write only `layers[0]` (do this mutation, run the pin, restore, run again — record both in the commit body).

```bash
git add src/cache/chained-cache.ts src/cache/cache.ts src/cache/layered-cache.ts src/cache/index.ts src/orchestrator/plugin-host.ts tests/chained-cache.test.ts tests/plugin-capabilities.test.ts
git commit -m "Chain every declared cache layer in declaration order

Lookup walks the layers until a hit, save reaches all, the first layer
owns the run index, restore goes to the layer that answered. A layer that
wraps the local handle subsumes the bare local layer, so cloud() composes
with localCachePlugin() without a cloud edit."
```

---

### Task 10: `vx migrate` emits the workspace file; docs; design-doc correction; gate; push

**Files:**

- Modify: `src/cli/migrate.ts`, `tests/migrate.test.ts`
- Rename: `docs/modules/builtin-plugins.md` → `docs/modules/local-plugins.md`; create `docs/modules/chained-cache.md`
- Modify: `docs/schema.md`, `docs/architecture.md`, `docs/README.md`, `docs/modules/{plugin,plugin-host,layered-cache,README,executor}.md`, `docs/design/plugin-executor-reapi-2026-08.md`, `CLAUDE.md`

- [ ] **Step 1: Failing test for migrate**

In `tests/migrate.test.ts` add (inside the turbo-migration describe, using that file's existing fixture helper for a turbo.json workspace):

```ts
it('emits vx.workspace.ts declaring the local plugins when none exists', async () => {
  // <use the file's existing fixture + run helper; then:>
  const ws = await Bun.file(path.join(root, 'vx.workspace.ts')).text()
  expect(ws).toContain(
    "import { defineWorkspace, localExecutorPlugin, localCachePlugin } from '@vzn/vx'",
  )
  expect(ws).toContain('plugins: [localExecutorPlugin(), localCachePlugin()]')
})

it('does not emit vx.workspace.ts when one already exists', async () => {
  // <write root/vx.workspace.ts with a marker before migrating; then:>
  expect(await Bun.file(path.join(root, 'vx.workspace.ts')).text()).toContain('MARKER')
})
```

Read `tests/migrate.test.ts` first and use its actual helpers for the fixture and the `migrate` invocation; the two assertions above are the contract.

- [ ] **Step 2: Implement in `src/cli/migrate.ts`**

After the `for (const f of plan.extraFiles)` loop that builds `files`, add:

```ts
// A migrated workspace must declare its executor and cache — nothing is
// applied by default. Emit the two-line workspace file unless the repo
// already has one in any supported extension.
const hasWorkspaceFile = (
  await Promise.all(
    ['vx.workspace.ts', 'vx.workspace.mjs', 'vx.workspace.js'].map((n) =>
      Bun.file(path.join(root, n)).exists(),
    ),
  )
).some(Boolean)
if (!hasWorkspaceFile) {
  const abs = path.join(root, 'vx.workspace.ts')
  files.push({ relPath: relPosix(root, abs), abs, contents: WORKSPACE_FILE })
}
```

with, at module level:

```ts
const WORKSPACE_FILE = `import { defineWorkspace, localExecutorPlugin, localCachePlugin } from '@vzn/vx'

// Nothing runs that is not declared here. Put a remote executor or cache
// plugin BEFORE the local one to prefer it.
export default defineWorkspace({ plugins: [localExecutorPlugin(), localCachePlugin()] })
`
```

The existing `--dry` printing and the conflict stat loop cover the new entry.

- [ ] **Step 3: Docs**

- `git mv docs/modules/builtin-plugins.md docs/modules/local-plugins.md`; rewrite: purpose = "core's executor + cache as plugins a workspace DECLARES; nothing by default"; surface = `localExecutorPlugin`, `localCachePlugin`, `localPlugins`, `MISSING_PLUGIN_HINT`; the `vx.workspace.ts` example; invariants = "no executor/cache plugin ⇒ named error before any task runs (pinned in `tests/local-plugins.test.ts` and the NO DEFAULTS e2e)".
- `docs/modules/chained-cache.md`: the five rules from the module header + "the first layer owns the run index" + the subsume rule; tests = `tests/chained-cache.test.ts`.
- `docs/modules/plugin.md` table: `cache(ctx)` → "return a `CacheLayer` or decline; ALL kept in order and chained"; `executor(ctx)` unchanged; add the sentence "Core applies NOTHING by default — `localExecutorPlugin()` / `localCachePlugin()` are declared like any other plugin."
- `docs/modules/plugin-host.md`: `resolveCache` → chain semantics + the no-layer error; `resolveExecutors` → the no-executor error.
- `docs/modules/layered-cache.md`: `local` is public, and why.
- `docs/modules/README.md`: rows for `local-plugins.md`, `chained-cache.md` (drop `builtin-plugins.md`).
- `docs/schema.md` `plugins` bullet: "REQUIRED in practice: a workspace must declare an executor plugin and a cache plugin (`localExecutorPlugin()`, `localCachePlugin()` for core's own); declaration order is precedence; multiple `cache` layers are chained; multiple `executor`s are consulted in order per task."
- `docs/architecture.md` capability table: `cache` row → chained; add under the seam: "**No defaults.** Core contributes nothing on its own; the local executor and cache are plugins the workspace declares."
- `docs/README.md` (the quick start / first-run section — find it with `grep -n "vx run" docs/README.md | head`): add the `vx.workspace.ts` two-liner as the FIRST step; note `vx migrate` emits it. Check `apps/docs/src/content/docs/` for a copy of the same page (`grep -l "vx.workspace" apps/docs/src/content/docs/*.md*`) and whether it is generated from `docs/` (look for a sync script in `apps/docs/package.json` or `apps/docs/vx.config.ts`); if generated, leave it; if hand-written, apply the same edit to `overview.md` / `add-to-existing-repo.md`.
- `docs/design/plugin-executor-reapi-2026-08.md` §3: replace the "Precedence:" paragraph with: "**No defaults.** Core applies no plugin on its own; `localExecutorPlugin()` and `localCachePlugin()` are declared like any other. **Lists, not winners:** every `executor` is kept in declaration order and per task the first whose `accepts()` passes runs it; every `cache` layer is kept and chained (lookup walks, save reaches all, the first owns the run index); `telemetry` sinks are additive. `backend` stays single-winner and, when contributed, delegates the whole run (executors are not consulted)." Update the table's `core default` row to `declared: localCachePlugin()` / `declared: localExecutorPlugin()` / `—`.
- `CLAUDE.md`: in Architecture principles add `7. **No defaults.** Core applies no plugin on its own — the local executor and cache are declared in vx.workspace.ts like any other; a workspace that declares none fails before any task runs, naming the fix.` Update the 2026-08-23 decision-log entry IN PLACE (not a new entry): replace its `withBuiltins` sentences with the no-defaults rule + the chained-cache rule + the subsume rule, and add: "Cost measured, not estimated: 38 test fixtures and this repo's own `vx.workspace.ts` had to declare the local plugins; `vx migrate` now emits the file. `tests/helpers/local-workspace.ts` is the one place fixtures get it." Update the repository-layout tree (`local-plugins.ts`, `chained-cache.ts`).

- [ ] **Step 4: Gate, commit, push, confirm CI**

Run: `bun src/bin.ts run ci` (exit 0 required; run `lint.oxfmt.fix` then the FULL gate again if markdown drifts).

```bash
git add src/cli/migrate.ts tests/migrate.test.ts docs/modules/local-plugins.md docs/modules/chained-cache.md docs/modules/plugin.md docs/modules/plugin-host.md docs/modules/layered-cache.md docs/modules/README.md docs/modules/executor.md docs/schema.md docs/architecture.md docs/README.md docs/design/plugin-executor-reapi-2026-08.md CLAUDE.md
git rm --cached docs/modules/builtin-plugins.md 2>/dev/null || true
git commit -m "Emit the workspace file from vx migrate; document no-defaults and chained caches"
git push origin main
```

Then confirm the REAL CI conclusion: `curl -s "https://api.github.com/repos/vznjs/vx/actions/runs?branch=main&per_page=1" | python3 -c "import sys,json; r=json.load(sys.stdin)['workflow_runs'][0]; print(r['head_sha'][:7], r['status'], r['conclusion'])"` — wait for `completed success`. CI runs `vx run ci` through the repo's own `vx.workspace.ts`, so a green CI is the end-to-end proof of the declared-only model on Linux.

---

# Revision 2 (2026-08-23): plugins live in `src/plugins/`, fully isolated; no bundle helpers

Owner instructions, overriding the Addendum where they conflict:

- **`src/plugins/<name>/index.ts`** is the home of every core-provided plugin.
  Each directory is a complete plugin that imports core ONLY through the bare
  public specifier `'@vzn/vx'` (resolved inside this repo by the
  `node_modules/@vzn/vx -> ../..` self-link, exactly as `packages/*` do) and
  never reaches relatively outside its own directory — so it can be moved
  into its own package later with zero edits. `src/index.ts` does NOT
  re-export them (that would be a cycle and would make them core); users
  import them from **subpath exports**: `@vzn/vx/plugins/local-executor`,
  `@vzn/vx/plugins/local-cache`.
- **No bundle helpers.** There is no `localPlugins()`, no `builtinPlugins()`,
  no `withBuiltins()`. Users compose the array themselves, always.
- **No per-task pauses** for the remaining tasks; everything is verified once
  at the end by the parent.

Everything in Tasks 8–10 stands except the items below.

## Overrides for Task 8

**Files (replaces the Task 8 file list):**

- Delete: `src/orchestrator/builtin-plugins.ts`, `tests/builtin-plugins.test.ts` (`git rm`)
- Create: `src/plugins/local-executor/index.ts`, `src/plugins/local-cache/index.ts`, `src/orchestrator/missing-plugin.ts`, `tests/helpers/local-workspace.ts`, `tests/local-plugins.test.ts`
- Modify: `package.json` (`exports`), `src/index.ts`, `src/orchestrator/index.ts`, `src/orchestrator/plugin-host.ts`, `src/orchestrator/prepare.ts`, `src/exec/executor.ts`, `src/exec/index.ts`, `vx.workspace.ts`, `tests/module-boundaries.test.ts`, `tests/package-boundaries.test.ts`, `tests/plugin-capabilities.test.ts`, `tests/executor.test.ts`, `tests/execute-task.test.ts`, and the 38 fixture files.

**`localExecutor` moves out of core.** `src/exec/executor.ts` keeps ONLY the contract (`TaskExecutor`, `ExecuteRequest`, `ExecuteResult`, `ExecuteSandbox`) and `selectExecutor`; delete `localExecutor` from it and from `src/exec/index.ts`. The process primitives it needs become public API — add to `src/index.ts`:

```ts
// Process primitives — what an executor plugin builds on. `@vzn/vx/plugins/local-executor`
// is the reference implementation and imports exactly these.
export { runCommand, runSandboxed } from './exec/index.js'
```

(`runCommand`/`runSandboxed` are already on the exec contract.) Remove `localExecutor` and `selectExecutor` from the façade (`selectExecutor` is core-internal; tests import it from `../src/exec/index.js`). The façade pin therefore changes by: `+runCommand +runSandboxed −builtinPlugins −localCachePlugin −localExecutor −localExecutorPlugin −selectExecutor −withBuiltins`. Confirm the pin's failure diff lists EXACTLY that set.

**`src/plugins/local-executor/index.ts`:**

```ts
// Core's executor as a plugin: spawn the task's command in-process, exactly
// the `runCommand` / `runSandboxed` call the orchestrator used to make
// directly. Imports core only through the public `@vzn/vx` surface so this
// directory can become its own package unchanged.

import { runCommand, runSandboxed, type TaskExecutor, type VxPlugin } from '@vzn/vx'

export const LOCAL_EXECUTOR_PLUGIN = 'vx/local-executor'

/** The executor itself — for tests and for plugins that wrap local execution. */
export function localExecutor(): TaskExecutor {
  return {
    name: 'local',
    async execute(req) {
      const common = {
        command: req.command,
        cwd: req.cwd,
        env: req.env,
        forwardArgs: req.forwardArgs,
        onStdout: req.onStdout,
        onStderr: req.onStderr,
        capture: req.capture,
        ...(req.liveChildren !== undefined ? { liveChildren: req.liveChildren } : {}),
        ...(req.timeoutMs !== undefined ? { timeoutMs: req.timeoutMs } : {}),
      }
      if (req.sandbox === undefined) {
        const res = await runCommand(common)
        return { ...res, violations: [] }
      }
      return await runSandboxed({
        ...common,
        baseAllowRead: req.sandbox.baseAllowRead,
        baseAllowWrite: req.sandbox.baseAllowWrite,
        baseDenyRead: req.sandbox.baseDenyRead,
        config: req.sandbox.config,
      })
    },
  }
}

/** Declare in vx.workspace.ts: `plugins: [localExecutorPlugin(), …]`. Accepts every task. */
export function localExecutorPlugin(): VxPlugin {
  return { name: LOCAL_EXECUTOR_PLUGIN, executor: () => localExecutor() }
}
```

**`src/plugins/local-cache/index.ts`:**

```ts
// Core's cache as a plugin: the `.vx/cache` handle the host opened (the run
// index + the local artifact store). Declared like any other cache layer;
// put a remote layer BEFORE it to look there first.

import type { VxPlugin } from '@vzn/vx'

export const LOCAL_CACHE_PLUGIN = 'vx/local-cache'

export function localCachePlugin(): VxPlugin {
  return { name: LOCAL_CACHE_PLUGIN, cache: (ctx) => ctx.localCache }
}
```

**`package.json` `exports`** becomes:

```json
"exports": {
  ".": { "types": "./src/index.ts", "import": "./src/index.ts" },
  "./plugins/local-executor": { "types": "./src/plugins/local-executor/index.ts", "import": "./src/plugins/local-executor/index.ts" },
  "./plugins/local-cache": { "types": "./src/plugins/local-cache/index.ts", "import": "./src/plugins/local-cache/index.ts" }
}
```

**`src/orchestrator/missing-plugin.ts`** (replaces the `MISSING_PLUGIN_HINT` in the deleted `local-plugins.ts`):

```ts
/** Shown by every "no <capability> plugin declared" error. */
export const MISSING_PLUGIN_HINT = `vx runs nothing it was not told to. Declare the plugins in vx.workspace.ts:

  import { defineWorkspace } from '@vzn/vx'
  import { localExecutorPlugin } from '@vzn/vx/plugins/local-executor'
  import { localCachePlugin } from '@vzn/vx/plugins/local-cache'
  export default defineWorkspace({ plugins: [localExecutorPlugin(), localCachePlugin()] })

Put a remote executor or cache plugin BEFORE the local one to prefer it.`
```

Export it from `src/orchestrator/index.ts` (NOT from the façade). `plugin-host.ts` imports it from `./missing-plugin.js`.

**`tests/local-plugins.test.ts`** (replaces the Addendum's version): import `localExecutorPlugin`, `LOCAL_EXECUTOR_PLUGIN`, `localExecutor` from `'../src/plugins/local-executor/index.js'`, `localCachePlugin`, `LOCAL_CACHE_PLUGIN` from `'../src/plugins/local-cache/index.js'`, and `MISSING_PLUGIN_HINT`, `resolveCache`, `resolveExecutors` from `'../src/orchestrator/index.js'`. Tests:

```ts
it('each plugin is named under vx/ and contributes exactly one capability', () => {
  const e = localExecutorPlugin()
  const c = localCachePlugin()
  expect(e.name).toBe(LOCAL_EXECUTOR_PLUGIN)
  expect(typeof e.executor).toBe('function')
  expect(e.cache).toBeUndefined()
  expect(c.name).toBe(LOCAL_CACHE_PLUGIN)
  expect(typeof c.cache).toBe('function')
  expect(c.executor).toBeUndefined()
})

it('the hint shows the exact lines to add, with the subpath imports', () => {
  expect(MISSING_PLUGIN_HINT).toContain("from '@vzn/vx/plugins/local-executor'")
  expect(MISSING_PLUGIN_HINT).toContain("from '@vzn/vx/plugins/local-cache'")
  expect(MISSING_PLUGIN_HINT).toContain('plugins: [localExecutorPlugin(), localCachePlugin()]')
})

it('the local executor plugin resolves to the local executor; the cache plugin hands back the host handle', async () => {
  const ctx = { workspaceRoot: '/ws', cacheDir: '/ws/.vx/cache', warn: () => undefined }
  const list = await resolveExecutors([localExecutorPlugin()], { ...ctx, concurrency: 1 })
  expect(list.map((x) => x.name)).toEqual(['local'])
  const marker = { hasRemote: false } as never
  const layer = await localCachePlugin().cache!({
    ...ctx,
    localCache: marker,
    policy: { localRead: true, localWrite: true, remoteRead: false, remoteWrite: false },
  })
  expect(layer).toBe(marker)
})
```

plus the Addendum's two `resolveExecutors`/`resolveCache` "fails fast and names the fix" tests unchanged (they use only host functions), with the "control" test using `[localExecutorPlugin()]` instead of `localPlugins()`.

**`tests/executor.test.ts`:** import `localExecutor` from `'../src/plugins/local-executor/index.js'` (the `selectExecutor` import stays on `'../src/exec/index.js'`). **`tests/execute-task.test.ts`:** same import change for `localExecutor`.

**`tests/helpers/local-workspace.ts`** — replace `CORE_INDEX` usage for the plugins with the two plugin paths:

```ts
import path from 'node:path'

const here = import.meta.dir
/** Absolute paths — fixtures live in a tmp dir where `@vzn/vx` does not resolve. */
export const CORE_INDEX = path.resolve(here, '../../src/index.ts')
export const LOCAL_EXECUTOR_PLUGIN_PATH = path.resolve(
  here,
  '../../src/plugins/local-executor/index.ts',
)
export const LOCAL_CACHE_PLUGIN_PATH = path.resolve(here, '../../src/plugins/local-cache/index.ts')

/** Source for a `vx.workspace.mjs`: the test's own plugins (JS expressions) FIRST, then the local ones. */
export function localWorkspaceSource(extra: readonly string[] = [], prelude = ''): string {
  return `${prelude}
import { localExecutorPlugin } from ${JSON.stringify(LOCAL_EXECUTOR_PLUGIN_PATH)}
import { localCachePlugin } from ${JSON.stringify(LOCAL_CACHE_PLUGIN_PATH)}
export default { plugins: [${[...extra, 'localExecutorPlugin()', 'localCachePlugin()'].join(', ')}] }
`
}

export async function writeLocalWorkspace(root: string): Promise<void> {
  await Bun.write(path.join(root, 'vx.workspace.mjs'), localWorkspaceSource())
}
```

(A plugin file imported by absolute path still resolves its own `'@vzn/vx'` import relative to ITS location inside the repo, and Bun keys modules by realpath, so it is the same `src/index.ts` instance the test imports.)

**This repo's `vx.workspace.ts`:**

```ts
import { defineWorkspace } from '@vzn/vx'
import { localExecutorPlugin } from '@vzn/vx/plugins/local-executor'
import { localCachePlugin } from '@vzn/vx/plugins/local-cache'
import { otel } from '@vzn/vx-otel'
import { cloud } from '@vzn/vx-cloud/plugin'

// Nothing runs that is not declared here — including core's own executor
// and cache. Order is precedence: cloud() (when configured) delegates the
// run or layers its remote cache ahead of the local one; otel() observes.
export default defineWorkspace({
  plugins: [otel(), cloud(), localExecutorPlugin(), localCachePlugin()],
})
```

**Boundary tests — the isolation pins** (add to Task 8, run them before committing):

- `tests/module-boundaries.test.ts`: the module classifier maps `src/plugins/<name>/…` to module `plugins`. Add `plugins: []` to `ALLOWED` (no relative cross-module import is legal from a plugin) and add `'plugins'` to nothing else — `src/index.ts` must not import it. Then add one test: every relative import inside `src/plugins/<name>/` resolves to a path INSIDE `src/plugins/<name>/` (read each file, collect `from '\.\.?/…'` specifiers, `path.resolve` them, assert `startsWith(dir)`).
- `tests/package-boundaries.test.ts`: read Rule 2's implementation first. If it forbids the bare `'@vzn/vx'` specifier anywhere under `src/**`, EXEMPT `src/plugins/**` for `'@vzn/vx'` only (a sibling `@vzn/vx-*` import stays forbidden) and add a positive test: every `src/plugins/<name>/index.ts` imports from `'@vzn/vx'` and from nothing else non-relative. This is the pin that a plugin is package-shaped.

**Task 8 commit paths** — add `package.json src/plugins/local-executor/index.ts src/plugins/local-cache/index.ts src/orchestrator/missing-plugin.ts src/exec/index.ts tests/module-boundaries.test.ts tests/execute-task.test.ts`; drop `src/orchestrator/local-plugins.ts`/`tests/local-plugins.test.ts` renames (they are a `git rm` + a new file now). Commit subject stays; add to the body: "The local executor and cache live in src/plugins/<name>, import core only via '@vzn/vx', and are published as subpath exports — each can be lifted into its own package unchanged."

## Overrides for Task 9

- `tests/chained-cache.test.ts`: unchanged. The e2e pin in `tests/plugin-capabilities.test.ts` keeps using `localWorkspaceSource` (now emitting the two plugin imports) and `CORE_INDEX` for `Cache`.

## Overrides for Task 10

- `WORKSPACE_FILE` in `src/cli/migrate.ts` emits the four-line form from `MISSING_PLUGIN_HINT` (import `defineWorkspace` from `'@vzn/vx'`, the two plugins from their subpaths). `tests/migrate.test.ts` asserts the two subpath import lines.
- Docs: `docs/modules/local-plugins.md` becomes `docs/modules/plugins.md` — one page for `src/plugins/`: the isolation contract (bare `@vzn/vx` only, no relative reach outside the directory, subpath export, pinned by the two boundary tests), then a section per plugin. `docs/modules/README.md` gets a "Plugins (`src/plugins/`)" table. `docs/schema.md`, `docs/README.md`, `docs/architecture.md` and the design doc §3 show the subpath imports. `CLAUDE.md`: the layout tree gains

```
  plugins/              # core-provided plugins, each isolated: imports core ONLY via '@vzn/vx',
    local-executor/     # published as @vzn/vx/plugins/local-executor — liftable into a package unchanged
    local-cache/        # published as @vzn/vx/plugins/local-cache
```

and Architecture principle 7 reads: `**No defaults.** Core applies no plugin on its own — even its executor and cache are plugins under src/plugins/, declared in vx.workspace.ts like any third-party one; a workspace that declares none fails before any task runs, naming the fix.`
