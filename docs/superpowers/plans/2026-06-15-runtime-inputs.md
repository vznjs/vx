# Runtime Inputs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `cache.inputs.runtime` and `cache.inputs.workspaceRuntime` — shell commands whose combined stdout+stderr is folded into a task's cache key, resolved live at hash time so they stay correct under `--frozen`.

**Architecture:** Mirror `cache.inputs.env` exactly: the command *strings* live in the resolved config (frozen into `vx-lock.json`), the command *output* is resolved live inside `resolveInputs` on every run. `runtime` commands run in the project dir (deduped per `(projectDir, command)`); `workspaceRuntime` commands run at the workspace root (deduped globally per command). Dedup uses run-scoped `Promise` memos on the existing `HashCache`, so the first task to need a command fires it and the rest await the same promise; each task awaits only its own commands. Output is folded into `Cache.key` as two namespaced sections.

**Tech Stack:** Bun (`Bun.spawn`, `bun:test`), TypeScript, xxHash3 key derivation.

**Spec:** `docs/design/runtime-inputs-2026-06.md`

---

## Background: key files & current anchors

- `src/config.ts:254` — `interface CacheInputs` (fields: `files`, `workspaceFiles`, `env`, `tasks`).
- `src/workspace/project-loader.ts:184-264` — `cache.inputs` validation block (`env` validated at 192-213; `validateWorkspaceGlobs` helper at 267).
- `src/cache/inputs.ts:30` — `interface ResolvedInputs` (`files`, `envValues`); `:35` `ResolveInputsArgs`; `:56` `resolveInputs`; `:81` `envValues:` line; `:142` `resolveEnvValues`. `UserError` already imported at `:24`.
- `src/orchestrator/task-hash.ts:23` — `interface HashCache`; `:28` `createHashCache`; `:64` `resolveInputs` call in `computeTaskHash`; `:104` `cache.key({...})` call.
- `src/cache/cache.ts:60` — `const CACHE_VERSION = 'vx-cache-v22'`; `:74` `interface CacheKeyInput`; `:642` `async key(...)`; env folded at `:658-661`.
- `src/orchestrator/execute-task.ts:356` — second `resolveInputs` call (sandbox `allowRead` baseline); has `args.hashCache` in scope (`:54`).
- Memo plumbing already exists end-to-end for `hashCache`: created in `prepare.ts:192`, passed through `run.ts`, `plan.ts:68`, `remote-prefetch.ts:120`, `execute-task.ts:188`.

**No code constructs `CacheKeyInput` outside `task-hash.ts:104` and the test helper `baseInput()` in `tests/cache.test.ts:29`.** New `CacheKeyInput` fields are optional, so those are the only two call sites to consider.

---

## Task 1: Schema fields + loader validation

**Files:**
- Modify: `src/config.ts:254-308` (add two fields to `CacheInputs`)
- Modify: `src/workspace/project-loader.ts` (add validation after the `env` block, before `workspaceFiles` at `:253`)
- Test: `tests/project-loader.test.ts`

- [ ] **Step 1: Write failing loader-validation tests**

Add to `tests/project-loader.test.ts` (use the file's existing `loadProjectConfig`/heredoc fixture helpers — match the surrounding test style; the snippet below shows the assertions to add):

```ts
it('accepts cache.inputs.runtime and workspaceRuntime as string arrays', async () => {
  const cfg = await loadFixtureConfig(`
    export default {
      tasks: {
        build: {
          exec: { command: 'echo hi' },
          cache: {
            inputs: { files: ['src/**'], runtime: ['node -v'], workspaceRuntime: ['uname -s'] },
            outputs: { files: [] },
          },
        },
      },
    }
  `)
  expect(cfg.tasks.build.cache?.inputs.runtime).toEqual(['node -v'])
  expect(cfg.tasks.build.cache?.inputs.workspaceRuntime).toEqual(['uname -s'])
})

it('rejects non-string runtime entries', async () => {
  await expect(
    loadFixtureConfig(`
      export default {
        tasks: { build: { exec: { command: 'x' },
          cache: { inputs: { files: [], runtime: [123] }, outputs: { files: [] } } } }
      }
    `),
  ).rejects.toThrow(/cache\.inputs\.runtime must be an array of non-empty shell command strings/)
})

it('rejects empty-string workspaceRuntime entries', async () => {
  await expect(
    loadFixtureConfig(`
      export default {
        tasks: { build: { exec: { command: 'x' },
          cache: { inputs: { files: [], workspaceRuntime: [''] }, outputs: { files: [] } } } }
      }
    `),
  ).rejects.toThrow(/cache\.inputs\.workspaceRuntime must be an array of non-empty shell command strings/)
})
```

> If `tests/project-loader.test.ts` has no `loadFixtureConfig` helper, reuse whatever fixture-loading helper the file already defines (e.g. one that writes a `vx.config.mjs` to a temp git workspace and calls `loadProjectConfig`). Do not invent a new harness.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/project-loader.test.ts -t runtime`
Expected: FAIL — `runtime` is not yet a known field / not validated.

- [ ] **Step 3: Add the schema fields**

In `src/config.ts`, inside `interface CacheInputs` (after the `tasks?` field, before the closing brace at `:308`):

```ts
  /**
   * Shell commands run in the PROJECT dir at hash time; their combined,
   * trimmed (stdout + stderr) output is folded into the cache key.
   * Deduped per (projectDir, command) within a run. A non-zero exit
   * fails the run. Modeled on `env`: the COMMANDS are frozen in the
   * lock, the OUTPUT is resolved live every run — correct under
   * `--frozen`. Use for project-specific runtime probes.
   */
  runtime?: string[]
  /**
   * Like `runtime`, but commands run at the WORKSPACE ROOT and are
   * deduped GLOBALLY per command across the whole run — a `node -v`
   * declared in 500 projects spawns exactly once. The runtime-input
   * analog of `workspaceFiles`: per-task, root-anchored. Use for global
   * tool versions, OS info, etc.
   */
  workspaceRuntime?: string[]
```

- [ ] **Step 4: Add loader validation**

In `src/workspace/project-loader.ts`, immediately before the `workspaceFiles` block at `:253` (`const wsInputs = (inputs as ...).workspaceFiles`), insert:

```ts
      for (const field of ['runtime', 'workspaceRuntime'] as const) {
        const list = (inputs as Record<string, unknown>)[field]
        if (list !== undefined) {
          if (
            !Array.isArray(list) ||
            list.some((s) => typeof s !== 'string' || s.length === 0)
          ) {
            throw new UserError(
              `${where}.cache.inputs.${field} must be an array of non-empty shell command strings`,
            )
          }
        }
      }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test tests/project-loader.test.ts -t runtime`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add src/config.ts src/workspace/project-loader.ts tests/project-loader.test.ts
git commit -m "Add cache.inputs.runtime/workspaceRuntime schema + loader validation"
```

---

## Task 2: Runtime resolver in `inputs.ts`

**Files:**
- Modify: `src/cache/inputs.ts` (`ResolvedInputs`, `ResolveInputsArgs`, `resolveInputs`; add `runRuntimeCommand` + `resolveRuntimeValues`)
- Test: `tests/inputs.test.ts`

- [ ] **Step 1: Write failing resolver tests**

Add a new `describe` block to `tests/inputs.test.ts`. These call `resolveInputs` directly against a temp git workspace (mirror the existing `cleanOutputs`/git fixture setup in the file — `mkdtemp`, write files; runtime resolution itself does not require git, but `resolveInputs` resolves `files` which does, so pass `files: []`):

```ts
describe('resolveInputs — runtime values', () => {
  let root: string
  let projectDir: string

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'vx-runtime-'))
    projectDir = path.join(root, 'pkg')
    await mkdir(projectDir, { recursive: true })
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  function args(inputs: Partial<import('../src/config.js').CacheInputs>) {
    return {
      projectDir,
      workspaceRoot: root,
      envSource: {} as NodeJS.ProcessEnv,
      inputs: { files: [], ...inputs } as import('../src/config.js').CacheInputs,
      ownOutputs: [],
      nestedProjectDirs: [],
    }
  }

  it('folds trimmed stdout of a runtime command', async () => {
    const r = await resolveInputs(args({ runtime: ['echo hello'] }))
    expect(r.runtimeValues).toEqual([['echo hello', 'hello']])
  })

  it('combines stdout and stderr, trimmed', async () => {
    const r = await resolveInputs(args({ runtime: ['sh -c "echo out; echo err 1>&2"'] }))
    expect(r.runtimeValues[0]![1]).toContain('out')
    expect(r.runtimeValues[0]![1]).toContain('err')
  })

  it('sorts runtime pairs by command for deterministic folding', async () => {
    const r = await resolveInputs(args({ runtime: ['echo b', 'echo a'] }))
    expect(r.runtimeValues.map(([c]) => c)).toEqual(['echo a', 'echo b'])
  })

  it('resolves workspaceRuntime at the workspace root', async () => {
    const r = await resolveInputs(args({ workspaceRuntime: ['pwd'] }))
    expect(r.workspaceRuntimeValues[0]![1]).toBe(root)
  })

  it('resolves runtime in the project dir', async () => {
    const r = await resolveInputs(args({ runtime: ['pwd'] }))
    expect(r.runtimeValues[0]![1]).toBe(projectDir)
  })

  it('throws UserError naming the command on non-zero exit', async () => {
    await expect(resolveInputs(args({ runtime: ['sh -c "echo boom 1>&2; exit 3"'] }))).rejects.toThrow(
      /runtime command exited 3: sh -c "echo boom 1>&2; exit 3"/,
    )
  })

  it('empty fields produce empty arrays', async () => {
    const r = await resolveInputs(args({}))
    expect(r.runtimeValues).toEqual([])
    expect(r.workspaceRuntimeValues).toEqual([])
  })

  it('dedups by (projectDir, command) via the runtimeCache memo (runs once)', async () => {
    const runtimeCache = new Map<string, Promise<string>>()
    // A command with a side effect: append to a counter file, echo its length.
    const counter = path.join(root, 'count')
    const cmd = `sh -c 'printf x >> ${counter}; wc -c < ${counter}'`
    await resolveInputs({ ...args({ runtime: [cmd] }), runtimeCache })
    await resolveInputs({ ...args({ runtime: [cmd] }), runtimeCache })
    const bytes = await readFile(counter, 'utf8')
    expect(bytes.length).toBe(1) // ran exactly once despite two resolveInputs calls
  })

  it('global dedup for workspaceRuntime: two projects, one spawn', async () => {
    const workspaceRuntimeCache = new Map<string, Promise<string>>()
    const counter = path.join(root, 'wscount')
    const cmd = `sh -c 'printf x >> ${counter}; echo ok'`
    const projectB = path.join(root, 'pkgB')
    await mkdir(projectB, { recursive: true })
    await resolveInputs({ ...args({ workspaceRuntime: [cmd] }), workspaceRuntimeCache })
    await resolveInputs({
      ...args({ workspaceRuntime: [cmd] }),
      projectDir: projectB,
      workspaceRuntimeCache,
    })
    const bytes = await readFile(counter, 'utf8')
    expect(bytes.length).toBe(1)
  })
})
```

> `readFile` is already imported at the top of `tests/inputs.test.ts`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/inputs.test.ts -t "runtime values"`
Expected: FAIL — `runtimeValues` undefined / `runtime` not resolved.

- [ ] **Step 3: Extend `ResolvedInputs` and `ResolveInputsArgs`**

In `src/cache/inputs.ts`, change `interface ResolvedInputs` (`:30`) to:

```ts
export interface ResolvedInputs {
  files: string[]
  envValues: Array<[name: string, value: string]>
  runtimeValues: Array<[command: string, output: string]>
  workspaceRuntimeValues: Array<[command: string, output: string]>
}
```

Add to `interface ResolveInputsArgs` (after the `gitFilesCache?` field):

```ts
  /**
   * Run-scoped memo for `cache.inputs.runtime` command execution, keyed
   * by `projectDir + '\0' + command`. Shared across a run's tasks so a
   * project's command runs once even across build/test/lint and across
   * the hash + sandbox-baseline resolveInputs calls.
   */
  runtimeCache?: Map<string, Promise<string>>
  /**
   * Run-scoped memo for `cache.inputs.workspaceRuntime`, keyed by command
   * only — global dedup so a root-level probe spawns once per run.
   */
  workspaceRuntimeCache?: Map<string, Promise<string>>
```

- [ ] **Step 4: Add the resolver functions**

In `src/cache/inputs.ts`, add near `resolveEnvValues` (`:142`):

```ts
/**
 * Run one runtime-input command via `sh -c` (so pipelines / redirects
 * work — "shell is the API"). Returns trimmed stdout+stderr. A non-zero
 * exit is a hard UserError naming the command (fail-loud, like git).
 */
async function runRuntimeCommand(command: string, cwd: string): Promise<string> {
  let proc
  try {
    proc = Bun.spawn(['sh', '-c', command], {
      cwd,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    })
  } catch {
    throw new UserError(
      `cache.inputs runtime command failed to spawn: ${command} (cwd: ${cwd})`,
    )
  }
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  const output = `${stdout}${stderr}`.trim()
  if (exitCode !== 0) {
    throw new UserError(
      `cache.inputs runtime command exited ${exitCode}: ${command} (cwd: ${cwd})` +
        (output ? `\n${output}` : ''),
    )
  }
  return output
}

/**
 * Resolve a list of runtime-input commands to sorted [command, output]
 * pairs. Dedups via the shared `memo` (Promise per key): the first
 * caller fires the spawn, concurrent callers await the same promise.
 * `memoKeyPrefix` namespaces project (`projectDir + '\0'`) vs workspace
 * (`''`) so the two scopes never collide in one map (they're separate
 * maps anyway, but the prefix keeps intent explicit). Distinct commands
 * run concurrently via Promise.all.
 */
async function resolveRuntimeValues(
  commands: readonly string[],
  cwd: string,
  memo: Map<string, Promise<string>> | undefined,
  memoKeyPrefix: string,
): Promise<Array<[string, string]>> {
  if (commands.length === 0) return []
  const unique = [...new Set(commands)].sort()
  return Promise.all(
    unique.map(async (cmd) => {
      const key = `${memoKeyPrefix}${cmd}`
      let p = memo?.get(key)
      if (p === undefined) {
        p = runRuntimeCommand(cmd, cwd)
        memo?.set(key, p)
      }
      return [cmd, await p] as [string, string]
    }),
  )
}
```

- [ ] **Step 5: Wire into `resolveInputs`**

In `src/cache/inputs.ts`, change the `return` of `resolveInputs` (`:79-82`) to resolve both runtime lists concurrently:

```ts
  const [runtimeValues, workspaceRuntimeValues] = await Promise.all([
    resolveRuntimeValues(
      args.inputs?.runtime ?? [],
      args.projectDir,
      args.runtimeCache,
      `${args.projectDir}\0`,
    ),
    resolveRuntimeValues(
      args.inputs?.workspaceRuntime ?? [],
      args.workspaceRoot,
      args.workspaceRuntimeCache,
      '',
    ),
  ])
  return {
    files,
    envValues: resolveEnvValues(args.inputs?.env ?? [], args.envSource),
    runtimeValues,
    workspaceRuntimeValues,
  }
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `bun test tests/inputs.test.ts -t "runtime values"`
Expected: PASS (9 tests).

- [ ] **Step 7: Commit**

```bash
git add src/cache/inputs.ts tests/inputs.test.ts
git commit -m "Resolve runtime/workspaceRuntime command outputs in resolveInputs"
```

---

## Task 3: Fold into the cache key + thread memos + CACHE_VERSION bump

**Files:**
- Modify: `src/cache/cache.ts` (`CacheKeyInput`, `key()`, `CACHE_VERSION`)
- Modify: `src/orchestrator/task-hash.ts` (`HashCache`, `createHashCache`, `computeTaskHash`)
- Modify: `src/orchestrator/execute-task.ts:356` (pass memos to the sandbox-baseline `resolveInputs`)
- Test: `tests/cache.test.ts`

- [ ] **Step 1: Write failing cache-key tests**

Add to the `describe('Cache.key')` block in `tests/cache.test.ts` (uses the existing `baseInput()` helper at `:29`):

```ts
it('different runtime output → different key', async () => {
  const a = await cache.key({ ...baseInput(), runtimeValues: [['node -v', 'v20']] })
  const b = await cache.key({ ...baseInput(), runtimeValues: [['node -v', 'v22']] })
  expect(a).not.toBe(b)
})

it('same runtime output → same key', async () => {
  const a = await cache.key({ ...baseInput(), runtimeValues: [['node -v', 'v20']] })
  const b = await cache.key({ ...baseInput(), runtimeValues: [['node -v', 'v20']] })
  expect(a).toBe(b)
})

it('runtime vs workspaceRuntime are namespaced (no aliasing)', async () => {
  const a = await cache.key({ ...baseInput(), runtimeValues: [['cmd', 'out']] })
  const b = await cache.key({ ...baseInput(), workspaceRuntimeValues: [['cmd', 'out']] })
  expect(a).not.toBe(b)
})

it('absent runtime fields → key unchanged vs explicit empty', async () => {
  const a = await cache.key(baseInput())
  const b = await cache.key({ ...baseInput(), runtimeValues: [], workspaceRuntimeValues: [] })
  expect(a).toBe(b)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/cache.test.ts -t runtime`
Expected: FAIL — `runtimeValues` not a `CacheKeyInput` field / not folded (first/third tests fail to distinguish keys).

- [ ] **Step 3: Add `CacheKeyInput` fields**

In `src/cache/cache.ts`, inside `interface CacheKeyInput` (after `envValues` at `:87`):

```ts
  /**
   * Resolved `cache.inputs.runtime` commands as [command, output] pairs
   * (output = trimmed stdout+stderr, resolved live at hash time). Folded
   * into the key in a namespace distinct from workspaceRuntimeValues.
   */
  runtimeValues?: Array<[command: string, output: string]>
  /** Resolved `cache.inputs.workspaceRuntime` pairs (root-cwd commands). */
  workspaceRuntimeValues?: Array<[command: string, output: string]>
```

- [ ] **Step 4: Fold into `key()`**

In `src/cache/cache.ts`, in `key()`, immediately after the env-values loop (`:661`, the `for (const [n, v] of input.envValues) ...` line):

```ts
    const runtimeValues = input.runtimeValues ?? []
    h = xxh3(`runtime-values:${runtimeValues.length}`, h)
    for (const [c, o] of runtimeValues) h = xxh3(`${c}\0${o}`, h)

    const wsRuntimeValues = input.workspaceRuntimeValues ?? []
    h = xxh3(`ws-runtime-values:${wsRuntimeValues.length}`, h)
    for (const [c, o] of wsRuntimeValues) h = xxh3(`${c}\0${o}`, h)
```

- [ ] **Step 5: Run cache-key tests to verify they pass**

Run: `bun test tests/cache.test.ts -t runtime`
Expected: PASS (4 tests).

- [ ] **Step 6: Extend `HashCache` with the two memos**

In `src/orchestrator/task-hash.ts`, change `interface HashCache` (`:23`) and `createHashCache` (`:28`):

```ts
export interface HashCache {
  packageJson: Map<string, Promise<string>>
  taskConfig: WeakMap<TaskConfig, string>
  runtime: Map<string, Promise<string>>
  workspaceRuntime: Map<string, Promise<string>>
}

export function createHashCache(): HashCache {
  return {
    packageJson: new Map(),
    taskConfig: new WeakMap(),
    runtime: new Map(),
    workspaceRuntime: new Map(),
  }
}
```

- [ ] **Step 7: Pass memos + runtime values through `computeTaskHash`**

In `src/orchestrator/task-hash.ts`, in the `resolveInputs({...})` call (`:64`), add the memo passthrough to the args object (alongside the existing `gitFilesCache` spread):

```ts
    ...(args.hashCache !== undefined
      ? {
          runtimeCache: args.hashCache.runtime,
          workspaceRuntimeCache: args.hashCache.workspaceRuntime,
        }
      : {}),
```

Then in the `cache.key({...})` call (`:104`), add after `envValues: resolved.envValues,`:

```ts
    runtimeValues: resolved.runtimeValues,
    workspaceRuntimeValues: resolved.workspaceRuntimeValues,
```

- [ ] **Step 8: Share the memos with the sandbox-baseline resolveInputs**

In `src/orchestrator/execute-task.ts`, in `runSandboxedTask`'s `resolveInputs({...})` call (`:356`), add to the args object (so the sandbox path reuses the already-resolved command output instead of re-spawning):

```ts
      ...(args.hashCache !== undefined
        ? {
            runtimeCache: args.hashCache.runtime,
            workspaceRuntimeCache: args.hashCache.workspaceRuntime,
          }
        : {}),
```

- [ ] **Step 9: Bump CACHE_VERSION**

In `src/cache/cache.ts:60`:

```ts
const CACHE_VERSION = 'vx-cache-v23'
```

- [ ] **Step 10: Run the full lint + format + test gate**

Run: `bun src/bin.ts run lint && bun src/bin.ts run format && bun test`
Expected: lint clean, format clean, all tests pass (new runtime tests + existing suite; relational cache-key tests stay valid because empty runtime sections fold a `:0` count identically on both sides).

- [ ] **Step 11: Commit**

```bash
git add src/cache/cache.ts src/orchestrator/task-hash.ts src/orchestrator/execute-task.ts tests/cache.test.ts
git commit -m "Fold runtime inputs into cache key; bump CACHE_VERSION to v23"
```

---

## Task 4: End-to-end tests (real CLI subprocess)

**Files:**
- Create: `tests/runtime-inputs.test.ts`

Mirror the harness in `tests/lock.test.ts` (`makeWorkspace`, `addProject`, `vx` subprocess helpers — copy them into the new file; the suite spawns the real CLI so frozen-mode is exercised honestly).

- [ ] **Step 1: Write the e2e tests**

```ts
// e2e for cache.inputs.runtime / workspaceRuntime. Spawns the real CLI:
// the headline property (output resolved live even under --frozen) only
// holds across real invocations.

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from 'bun:test'

setDefaultTimeout(30_000)

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')

function git(cwd: string, ...args: string[]): void {
  const p = Bun.spawnSync({
    cmd: ['git', '-c', 'commit.gpgsign=false', ...args],
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (p.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${new TextDecoder().decode(p.stderr)}`)
}

async function makeWorkspace(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vx-runtime-e2e-'))
  await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'root', private: true }))
  await mkdir(path.join(root, 'packages'), { recursive: true })
  git(root, 'init', '-q')
  git(root, 'config', 'user.email', 't@vx.local')
  git(root, 'config', 'user.name', 'vx')
  return root
}

async function addProject(root: string, name: string, config: string): Promise<string> {
  const dir = path.join(root, 'packages', name)
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name, version: '0.0.0' }))
  await writeFile(path.join(dir, 'vx.config.mjs'), config)
  return dir
}

async function vx(root: string, args: string[], env: Record<string, string> = {}) {
  const proc = Bun.spawn([process.execPath, BIN, ...args], {
    cwd: root,
    env: { ...process.env, CI: '', GITHUB_ACTIONS: '', ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, out, err }
}

describe('runtime inputs — e2e', () => {
  let root: string
  beforeEach(async () => {
    root = await makeWorkspace()
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('runtime output change invalidates the cache (re-executes)', async () => {
    // Marker file feeds the runtime command's output; the task appends to
    // a hit-log on every real execution.
    await writeFile(path.join(root, 'marker'), 'A')
    await addProject(
      root,
      'a',
      `export default {
        tasks: {
          build: {
            exec: { command: "echo built >> $VX_LOG" },
            cache: {
              inputs: { files: [], workspaceRuntime: ['cat marker'] },
              outputs: { files: [] },
            },
          },
        },
      }`,
    )
    git(root, 'add', '-A')
    git(root, 'commit', '-q', '-m', 'init')
    const log = path.join(root, 'execlog')

    const r1 = await vx(root, ['run', 'build'], { VX_LOG: log })
    expect(r1.code).toBe(0)
    const r2 = await vx(root, ['run', 'build'], { VX_LOG: log }) // same marker → hit
    expect(r2.code).toBe(0)
    expect((await readFile(log, 'utf8')).trim().split('\n').length).toBe(1)

    await writeFile(path.join(root, 'marker'), 'B') // output changes → miss
    const r3 = await vx(root, ['run', 'build'], { VX_LOG: log })
    expect(r3.code).toBe(0)
    expect((await readFile(log, 'utf8')).trim().split('\n').length).toBe(2)
  })

  it('stays live under --frozen (re-resolves output after lock)', async () => {
    await writeFile(path.join(root, 'marker'), 'A')
    await addProject(
      root,
      'a',
      `export default {
        tasks: {
          build: {
            exec: { command: "echo built >> $VX_LOG" },
            cache: {
              inputs: { files: [], workspaceRuntime: ['cat marker'] },
              outputs: { files: [] },
            },
          },
        },
      }`,
    )
    git(root, 'add', '-A')
    git(root, 'commit', '-q', '-m', 'init')
    const log = path.join(root, 'execlog')

    const lock = await vx(root, ['lock'], { VX_LOG: log })
    expect(lock.code).toBe(0)
    const r1 = await vx(root, ['run', 'build', '--frozen'], { VX_LOG: log })
    expect(r1.code).toBe(0)
    expect((await readFile(log, 'utf8')).trim().split('\n').length).toBe(1)

    await writeFile(path.join(root, 'marker'), 'B') // command string unchanged; output differs
    const r2 = await vx(root, ['run', 'build', '--frozen'], { VX_LOG: log })
    expect(r2.code).toBe(0)
    // Lock froze only the command 'cat marker'; output is resolved live →
    // the changed output must produce a miss and re-execute.
    expect((await readFile(log, 'utf8')).trim().split('\n').length).toBe(2)
  })

  it('non-zero runtime command fails the run', async () => {
    await addProject(
      root,
      'a',
      `export default {
        tasks: {
          build: {
            exec: { command: "echo hi" },
            cache: { inputs: { files: [], runtime: ['sh -c "exit 7"'] }, outputs: { files: [] } },
          },
        },
      }`,
    )
    git(root, 'add', '-A')
    git(root, 'commit', '-q', '-m', 'init')
    const r = await vx(root, ['run', 'build'])
    expect(r.code).not.toBe(0)
    expect(`${r.out}${r.err}`).toMatch(/runtime command exited 7/)
  })

  it('workspaceRuntime shared by two projects spawns once', async () => {
    const counter = path.join(root, 'spawncount')
    const cfg = (n: string) => `export default {
      tasks: {
        build: {
          exec: { command: "echo ${n}" },
          cache: {
            inputs: { files: [], workspaceRuntime: ["sh -c 'printf x >> ${counter}; echo v1'"] },
            outputs: { files: [] },
          },
        },
      },
    }`
    await addProject(root, 'a', cfg('a'))
    await addProject(root, 'b', cfg('b'))
    git(root, 'add', '-A')
    git(root, 'commit', '-q', '-m', 'init')

    const r = await vx(root, ['run', 'build', '--all'])
    expect(r.code).toBe(0)
    // Both projects declare the identical workspaceRuntime command →
    // global dedup → exactly one spawn for the whole run.
    expect((await readFile(counter, 'utf8')).length).toBe(1)
  })
})
```

> Confirm the run-all flag name against `src/cli/run.ts` (`--all` per the output-redesign decision log). If a fixture's first run reports "no project declares task", check the config shape against another e2e fixture (e.g. `tests/orchestrator.test.ts`).

- [ ] **Step 2: Run the e2e tests**

Run: `bun test tests/runtime-inputs.test.ts`
Expected: PASS (4 tests). The `--frozen` test is the headline correctness proof.

- [ ] **Step 3: Commit**

```bash
git add tests/runtime-inputs.test.ts
git commit -m "Add runtime-inputs e2e tests (output drift, --frozen live, dedup, fail)"
```

---

## Task 5: Docs + decision log

**Files:**
- Modify: `docs/schema.md` (document the two fields)
- Modify: `docs/caching.md` (invalidation table + CACHE_VERSION bump note + env-parallel asymmetry)
- Modify: `docs/modules/cache.md` (CacheKeyInput shape, if it lists fields)
- Modify: `CLAUDE.md` (decision-log entry)

- [ ] **Step 1: Document the schema fields**

In `docs/schema.md`, in the `cache.inputs` section (next to `env` / `workspaceFiles`), add entries for `runtime` and `workspaceRuntime`. Cover: each is a `string[]` of shell commands; combined trimmed stdout+stderr is folded into the cache key; `runtime` runs in the project dir, `workspaceRuntime` at the workspace root; commands are run via `sh -c`; a non-zero exit fails the run; commands are frozen by `vx lock` but their output is resolved live every run (correct under `--frozen`). Example:

````markdown
```ts
cache: {
  inputs: {
    files: ['src/**'],
    workspaceRuntime: ['node -v'],      // tool version → key (runs once per run)
    runtime: ['./scripts/probe.sh'],    // project-local probe (project-dir cwd)
  },
  outputs: { files: ['dist/**'] },
}
```
````

- [ ] **Step 2: Update caching docs**

In `docs/caching.md`:
- Add invalidation-table rows: `cache.inputs.runtime` / `cache.inputs.workspaceRuntime` → "combined stdout+stderr of the command(s), resolved at hash time".
- Add a short subsection noting the env-parallel asymmetry: the lock freezes the command *strings* (they're in the resolved config) but the *output* is resolved live every run — identical to how the lock freezes env *names* but reads env *values* live, so `lock --check` does not (and need not) flag runtime-output drift.
- Append to the "Bumping `CACHE_VERSION`" section: `v22 → v23: fold cache.inputs.runtime / workspaceRuntime command output into the key (two namespaced sections after env-values).`

- [ ] **Step 3: Update the cache module doc**

In `docs/modules/cache.md`, if it enumerates `CacheKeyInput` fields, add `runtimeValues` and `workspaceRuntimeValues` (`Array<[command, output]>`, optional, folded as namespaced sections). If it does not enumerate the shape, skip.

- [ ] **Step 4: Add the decision-log entry**

In `CLAUDE.md`, prepend to the "Decision log" a `- **2026-06**:` entry: runtime inputs shipped as the single canonical mechanism (`cache.inputs.runtime` project-dir/per-project-dedup + `cache.inputs.workspaceRuntime` root-cwd/global-dedup); modeled on `inputs.env` (commands frozen in lock, output resolved live at hash time via `resolveInputs`, correct under `--frozen` where the TS escape hatch goes stale); stdout+stderr trimmed, folded as two namespaced sections in `Cache.key`; non-zero exit → `UserError`; run via `sh -c` with run-scoped `Promise` memos on `HashCache` (a task awaits only its own commands); CACHE_VERSION → v23, no SCHEMA bump; Nx parity (Turbo lacks this, vercel/turborepo#4124). Reference `docs/design/runtime-inputs-2026-06.md`.

- [ ] **Step 5: Run the full local gate**

Run: `bun src/bin.ts run ci`
Expected: install → format:check → lint → test all green.

- [ ] **Step 6: Commit**

```bash
git add docs/schema.md docs/caching.md docs/modules/cache.md CLAUDE.md
git commit -m "Document runtime inputs + log the decision"
```

---

## Final verification

- [ ] `bun src/bin.ts run ci` is green.
- [ ] `git log --oneline` shows 5 focused commits (schema, resolver, key+bump, e2e, docs).
- [ ] Spot-check: a config with no `runtime`/`workspaceRuntime` derives a byte-identical key to one with explicit empty arrays (covered by Task 3 Step 1's "absent → unchanged" test).
- [ ] Push to `main` per the project workflow (direct push after the gate).

---

## Self-review notes (author)

- **Spec coverage:** schema (T1), loader validation (T1), resolver + cwd split + dedup + stdout+stderr + non-zero fail (T2), key folding + namespacing + CACHE_VERSION bump + memo threading incl. sandbox path (T3), e2e incl. `--frozen` live-resolution + global dedup (T4), lock/`lock --check` no-op note + docs + decision log (T5). All spec sections map to a task.
- **No SCHEMA bump:** confirmed — no on-disk/SQLite format change; only `Cache.key` derivation gains two folded sections.
- **Type consistency:** config fields `runtime`/`workspaceRuntime` (string[]); resolved arrays + `CacheKeyInput` fields `runtimeValues`/`workspaceRuntimeValues` (`Array<[string,string]>`); memo maps `Map<string, Promise<string>>` on `HashCache.runtime`/`.workspaceRuntime` and `ResolveInputsArgs.runtimeCache`/`.workspaceRuntimeCache`. Names consistent across T1–T5.
