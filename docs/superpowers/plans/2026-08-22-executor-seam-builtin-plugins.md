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
Expected: PASS (8 tests).

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
export type { ExecuteRequest, ExecuteResult, ExecuteSandbox, TaskExecutor } from './exec/index.js'
```

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
git add src/index.ts tests/package-boundaries.test.ts tests/module-boundaries.test.ts docs/modules/executor.md docs/modules/builtin-plugins.md docs/modules/plugin.md docs/modules/plugin-host.md docs/modules/execute-task.md docs/modules/README.md docs/architecture.md CLAUDE.md
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
3. Executor capacity in the scheduler (remote tasks must not consume local worker slots).
4. `ExecuteResult.outputs` discriminator (`disk`/`cache`/`deferred`) + `--download`.
5. `@vzn/vx-reapi` phase 1 (remote cache over AC/CAS; the gRPC-on-Bun spike).
6. Port vx-cloud's dist to `executor`; retire `backend`.
