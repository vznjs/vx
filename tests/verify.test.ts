// Provable cache correctness — Phase 1 (determinism). `vx run --verify`
// re-executes each cacheable task after its save and content-compares the
// outputs: a divergence proves the task is non-hermetic (its cache entry
// would replay arbitrary past bytes) and fails the run. A pure side-channel:
// never folded into a cache key. See docs/design/cache-correctness-2026-07.md.

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { probeSandbox } from '../src/exec/index.js'
import type { Logger } from '../src/orchestrator/index.js'
import { run } from '../src/orchestrator/index.js'
import { undeclaredInputPaths } from '../src/orchestrator/verify.js'

const TIMEOUT = 20_000

interface Fixture {
  root: string
  out: string[]
  err: string[]
}
let fixture: Fixture

const capturingLogger = (f: Fixture): Logger => ({
  status() {},
  taskStdout(_n, c) {
    f.out.push(c)
  },
  taskStderr(_n, c) {
    f.err.push(c)
  },
  taskComplete() {},
})

async function makeWorkspace(): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vx-verify-'))
  await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'fixture-root', private: true }, null, 2),
  )
  await mkdir(path.join(root, 'packages'), { recursive: true })
  const git = (...a: string[]) => {
    const p = Bun.spawnSync({ cmd: ['git', '-c', 'commit.gpgsign=false', ...a], cwd: root })
    if (p.exitCode !== 0) throw new Error(`git ${a.join(' ')}`)
  }
  git('init', '-q')
  git('config', 'user.email', 't@vx.local')
  git('config', 'user.name', 'vx')
  return { root, out: [], err: [] }
}

async function addProject(root: string, name: string, config: string): Promise<string> {
  const dir = path.join(root, 'packages', name)
  await mkdir(dir, { recursive: true })
  await writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify({ name, version: '0.0.0' }, null, 2),
  )
  await writeFile(path.join(dir, 'vx.config.mjs'), config)
  return dir
}

const DETERMINISM = { determinism: true, inputs: false, allow: new Set<string>() }

/** A cacheable task whose output is written by `cmd` (a node -e expression body). */
const project = (cmd: string, outputs = "['out.txt']") =>
  `export default {
    tasks: {
      run: {
        exec: { command: ${JSON.stringify(`node -e '${cmd}'`)} },
        cache: { inputs: { files: ['package.json'] }, outputs: { files: ${outputs} } },
      },
    },
  }`

describe('vx run --verify (determinism)', () => {
  beforeEach(async () => {
    fixture = await makeWorkspace()
  })
  afterEach(async () => {
    await rm(fixture.root, { recursive: true, force: true })
  })

  it(
    'proves a deterministic task safe',
    async () => {
      await addProject(
        fixture.root,
        'a',
        project('require("fs").writeFileSync("out.txt","stable")'),
      )
      const r = await run({
        cwd: fixture.root,
        tasks: ['run'],
        projects: ['a'],
        verify: DETERMINISM,
        log: capturingLogger(fixture),
      })
      expect(r.ok).toBe(true)
      expect(r.outcomes[0]!.verify).toEqual({ kind: 'proven-deterministic' })
    },
    TIMEOUT,
  )

  it(
    'catches a non-deterministic task, names the diverging output, fails the run',
    async () => {
      await addProject(
        fixture.root,
        'a',
        project('require("fs").writeFileSync("out.txt",String(Math.random()))'),
      )
      const r = await run({
        cwd: fixture.root,
        tasks: ['run'],
        projects: ['a'],
        verify: DETERMINISM,
        log: capturingLogger(fixture),
      })
      expect(r.ok).toBe(false)
      const v = r.outcomes[0]!.verify
      expect(v?.kind).toBe('nondeterministic')
      if (v?.kind === 'nondeterministic') expect(v.changed).toContain('out.txt')
    },
    TIMEOUT,
  )

  it(
    'reports a cacheable task with no declared outputs as no-outputs (nothing to replay)',
    async () => {
      await addProject(fixture.root, 'a', project('process.stdout.write("hi")', '[]'))
      const r = await run({
        cwd: fixture.root,
        tasks: ['run'],
        projects: ['a'],
        verify: DETERMINISM,
        log: capturingLogger(fixture),
      })
      expect(r.ok).toBe(true)
      expect(r.outcomes[0]!.verify).toEqual({ kind: 'no-outputs' })
    },
    TIMEOUT,
  )

  it(
    '--verify-allow exempts a known-nondeterministic task from failing the run',
    async () => {
      await addProject(
        fixture.root,
        'a',
        project('require("fs").writeFileSync("out.txt",String(Math.random()))'),
      )
      const r = await run({
        cwd: fixture.root,
        tasks: ['run'],
        projects: ['a'],
        verify: { determinism: true, inputs: false, allow: new Set(['a#run']) },
        log: capturingLogger(fixture),
      })
      expect(r.ok).toBe(true)
      expect(r.outcomes[0]!.verify?.kind).toBe('allowed-nondeterministic')
    },
    TIMEOUT,
  )

  it(
    'a cache hit is not-verified; --verify never changes the cache key (hits a plain entry)',
    async () => {
      await addProject(
        fixture.root,
        'a',
        project('require("fs").writeFileSync("out.txt","stable")'),
      )
      // Plain run saves a normal entry.
      const plain = await run({
        cwd: fixture.root,
        tasks: ['run'],
        projects: ['a'],
        log: capturingLogger(fixture),
      })
      expect(plain.outcomes[0]!.status).toBe('success')
      // A --verify run HITS that entry — proving the key is byte-identical
      // with and without --verify — and the hit is flagged not-verified.
      const verified = await run({
        cwd: fixture.root,
        tasks: ['run'],
        projects: ['a'],
        verify: DETERMINISM,
        log: capturingLogger({ root: fixture.root, out: [], err: [] }),
      })
      expect(verified.outcomes[0]!.status).toBe('cache-hit')
      expect(verified.outcomes[0]!.verify).toEqual({ kind: 'not-verified' })
    },
    TIMEOUT,
  )

  it(
    '--force re-executes a warm graph so it can be verified',
    async () => {
      await addProject(
        fixture.root,
        'a',
        project('require("fs").writeFileSync("out.txt","stable")'),
      )
      await run({
        cwd: fixture.root,
        tasks: ['run'],
        projects: ['a'],
        log: capturingLogger(fixture),
      })
      // --force = reads off, writes on → re-executes → verifiable.
      const r = await run({
        cwd: fixture.root,
        tasks: ['run'],
        projects: ['a'],
        cache: { localRead: false, localWrite: true, remoteRead: false, remoteWrite: true },
        verify: DETERMINISM,
        log: capturingLogger({ root: fixture.root, out: [], err: [] }),
      })
      expect(r.outcomes[0]!.status).toBe('success')
      expect(r.outcomes[0]!.verify).toEqual({ kind: 'proven-deterministic' })
    },
    TIMEOUT,
  )

  it(
    'a plain run (no --verify) attaches no verdict',
    async () => {
      await addProject(
        fixture.root,
        'a',
        project('require("fs").writeFileSync("out.txt","stable")'),
      )
      const r = await run({
        cwd: fixture.root,
        tasks: ['run'],
        projects: ['a'],
        log: capturingLogger(fixture),
      })
      expect(r.outcomes[0]!.verify).toBeUndefined()
    },
    TIMEOUT,
  )
})

describe('undeclaredInputPaths (pure)', () => {
  it('extracts the bracketed abs path and makes it workspace-relative', () => {
    const ws = '/work/space'
    const v = [
      { line: `openat(secret.txt) = -1 ENOENT  [${ws}/pkg/a/secret.txt]` },
      { line: `openat(other) = -1 ENOENT  [${ws}/pkg/b/other.env]` },
    ]
    expect(undeclaredInputPaths(v, ws)).toEqual(['pkg/a/secret.txt', 'pkg/b/other.env'])
  })

  it('dedups + sorts and falls back to the raw line when no bracket is present', () => {
    const ws = '/w'
    const v = [
      { line: `openat(x) = -1 ENOENT  [${ws}/z.txt]` },
      { line: `openat(x) = -1 ENOENT  [${ws}/z.txt]` }, // dup
      { line: `openat(x) = -1 ENOENT  [${ws}/a.txt]` },
      { line: 'sandbox: some macos syscall line with no bracket' }, // fallback
    ]
    expect(undeclaredInputPaths(v, ws)).toEqual([
      'a.txt',
      'sandbox: some macos syscall line with no bracket',
      'z.txt',
    ])
  })
})

// Phase 2 (input-completeness) needs the OS sandbox. It's installed in CI's
// "Install sandbox runtime deps" step, so these run there; a dev host without
// bwrap/strace skips cleanly (mirrors tests/sandbox-runtime.test.ts).
const sandbox = await probeSandbox()
if (!sandbox.available) {
  // eslint-disable-next-line no-console
  console.warn(`[verify inputs tests] skipping — sandbox unavailable: ${sandbox.reason}`)
}

/** A cacheable task that reads `readCmd` (a node -e body) and writes out.txt. */
const inputProject = (readExpr: string, inputs = "['src/**','package.json']") =>
  `export default {
    tasks: {
      run: {
        exec: { command: ${JSON.stringify(`node -e '${readExpr}'`)} },
        cache: { inputs: { files: ${inputs} }, outputs: { files: ['out.txt'] } },
      },
    },
  }`

const INPUTS = { determinism: false, inputs: true, allow: new Set<string>() }

describe.skipIf(!sandbox.available)('vx run --verify=inputs (input-completeness)', () => {
  beforeEach(async () => {
    fixture = await makeWorkspace()
  })
  afterEach(async () => {
    await rm(fixture.root, { recursive: true, force: true })
  })

  it(
    'proves a task whose declared inputs are complete',
    async () => {
      const dir = await addProject(
        fixture.root,
        'a',
        inputProject('require("fs").writeFileSync("out.txt","ok")'),
      )
      await mkdir(path.join(dir, 'src'), { recursive: true })
      await writeFile(path.join(dir, 'src', 'in.txt'), 'x')
      const r = await run({
        cwd: fixture.root,
        tasks: ['run'],
        projects: ['a'],
        verify: INPUTS,
        log: capturingLogger(fixture),
      })
      expect(r.ok).toBe(true)
      expect(r.outcomes[0]!.verify).toEqual({ kind: 'proven-complete' })
    },
    TIMEOUT,
  )

  it(
    'catches a read outside the declared inputs, names the path, fails the run',
    async () => {
      const dir = await addProject(
        fixture.root,
        'a',
        // Reads secret.txt (NOT under src/** or package.json). The read is
        // denied under the sandbox; the attempt is still flagged.
        inputProject(
          'const fs=require("fs");let s="d";try{s=fs.readFileSync("secret.txt","utf8")}catch(e){}fs.writeFileSync("out.txt",s)',
        ),
      )
      await mkdir(path.join(dir, 'src'), { recursive: true })
      await writeFile(path.join(dir, 'src', 'in.txt'), 'x')
      await writeFile(path.join(dir, 'secret.txt'), 'SECRET')
      const r = await run({
        cwd: fixture.root,
        tasks: ['run'],
        projects: ['a'],
        verify: INPUTS,
        log: capturingLogger(fixture),
      })
      expect(r.ok).toBe(false)
      const v = r.outcomes[0]!.verify
      expect(v?.kind).toBe('undeclared-inputs')
      if (v?.kind === 'undeclared-inputs') {
        expect(v.paths.some((p) => p.endsWith('secret.txt'))).toBe(true)
      }
    },
    TIMEOUT,
  )

  it(
    'a cache hit is not-verified under --verify=inputs (never re-runs)',
    async () => {
      const cfg = inputProject('require("fs").writeFileSync("out.txt","ok")')
      const dir = await addProject(fixture.root, 'a', cfg)
      await mkdir(path.join(dir, 'src'), { recursive: true })
      await writeFile(path.join(dir, 'src', 'in.txt'), 'x')
      await run({
        cwd: fixture.root,
        tasks: ['run'],
        projects: ['a'],
        log: capturingLogger(fixture),
      })
      const r = await run({
        cwd: fixture.root,
        tasks: ['run'],
        projects: ['a'],
        verify: INPUTS,
        log: capturingLogger({ root: fixture.root, out: [], err: [] }),
      })
      expect(r.outcomes[0]!.status).toBe('cache-hit')
      expect(r.outcomes[0]!.verify).toEqual({ kind: 'not-verified' })
    },
    TIMEOUT,
  )

  it(
    '--verify=all reports undeclared-inputs (short-circuits determinism) for a leaky task',
    async () => {
      const dir = await addProject(
        fixture.root,
        'a',
        inputProject(
          'const fs=require("fs");try{fs.readFileSync("secret.txt")}catch(e){}fs.writeFileSync("out.txt","ok")',
        ),
      )
      await mkdir(path.join(dir, 'src'), { recursive: true })
      await writeFile(path.join(dir, 'src', 'in.txt'), 'x')
      await writeFile(path.join(dir, 'secret.txt'), 'SECRET')
      const r = await run({
        cwd: fixture.root,
        tasks: ['run'],
        projects: ['a'],
        verify: { determinism: true, inputs: true, allow: new Set<string>() },
        log: capturingLogger(fixture),
      })
      expect(r.ok).toBe(false)
      expect(r.outcomes[0]!.verify?.kind).toBe('undeclared-inputs')
    },
    TIMEOUT,
  )
})
