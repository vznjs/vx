import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { ClassifiedStatus } from '../src/orchestrator/classify.js'
import type { Logger } from '../src/orchestrator/index.js'
import { run } from '../src/orchestrator/index.js'

const TIMEOUT = 30_000

interface Recorder {
  root: string
  /** Ordered event tape: 'classified' and per-task 'complete:<id>:<status>'. */
  events: string[]
  classified: Map<string, ClassifiedStatus> | null
}

/**
 * A logger that records the ORDER of cacheClassified vs taskComplete
 * so a test can assert the cache meter is fully classified before any
 * task finishes (and thus before any restore/exec lands its outcome).
 */
const recordingLogger = (rec: Recorder): Logger => ({
  status() {},
  taskStdout() {},
  taskStderr() {},
  taskComplete(node, outcome) {
    rec.events.push(`complete:${node.id}:${outcome.status}`)
  },
  cacheClassified(predicted) {
    rec.events.push('classified')
    rec.classified = new Map(predicted)
  },
})

async function makeWorkspace(): Promise<Recorder> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vx-upfront-'))
  await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'fixture-root', private: true }, null, 2),
  )
  await mkdir(path.join(root, 'packages'), { recursive: true })
  initGitRepo(root)
  return { root, events: [], classified: null }
}

function initGitRepo(cwd: string): void {
  const g = (...args: string[]): void => {
    const p = Bun.spawnSync({
      cmd: ['git', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgSign=false', ...args],
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    if (p.exitCode !== 0)
      throw new Error(`git ${args.join(' ')}: ${new TextDecoder().decode(p.stderr)}`)
  }
  g('init', '-q')
  g('config', 'user.email', 'test@vx.local')
  g('config', 'user.name', 'vx test')
}

async function addProject(
  root: string,
  name: string,
  args: { deps?: Record<string, string>; files?: Record<string, string>; config: string },
): Promise<string> {
  const safe = name.replace('@', '').replace('/', '-')
  const dir = path.join(root, 'packages', safe)
  await mkdir(dir, { recursive: true })
  const pkg: Record<string, unknown> = { name, version: '0.0.0' }
  if (args.deps && Object.keys(args.deps).length > 0) pkg.dependencies = args.deps
  await writeFile(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2))
  await writeFile(path.join(dir, 'vx.config.mjs'), args.config)
  for (const [rel, content] of Object.entries(args.files ?? {})) {
    const full = path.join(dir, rel)
    await mkdir(path.dirname(full), { recursive: true })
    await writeFile(full, content)
  }
  return dir
}

describe('upfront classification e2e', () => {
  let rec: Recorder

  beforeEach(async () => {
    rec = await makeWorkspace()
  })
  afterEach(async () => {
    await rm(rec.root, { recursive: true, force: true })
  })

  it(
    'a warm all-hits run emits the full cache breakdown BEFORE any task completes',
    async () => {
      await addProject(rec.root, 'a', {
        files: { 'src/x.txt': 'x' },
        config: `export default { tasks: { build: {
          exec: { command: "cat src/x.txt > out.txt" },
          cache: { inputs: { files: ['src/**'] }, outputs: { files: ['out.txt'] } },
        } } }`,
      })
      await addProject(rec.root, 'b', {
        deps: { a: 'workspace:*' },
        files: { 'src/y.txt': 'y' },
        config: `export default { tasks: { build: {
          exec: { command: "cat src/y.txt > out.txt" },
          dependsOn: ['^build'],
          cache: { inputs: { files: ['src/**'] }, outputs: { files: ['out.txt'] } },
        } } }`,
      })

      // Warm the cache + leave outputs current on disk.
      await run({ cwd: rec.root, tasks: ['build'], log: recordingLogger(rec) })

      // Second run: every task is a hit. Assert classification fires
      // first and already accounts for ALL tasks.
      const warm: Recorder = { root: rec.root, events: [], classified: null }
      const r = await run({ cwd: rec.root, tasks: ['build'], log: recordingLogger(warm) })
      expect(r.ok).toBe(true)

      // Ordering: 'classified' must precede the first task completion.
      const classifiedIdx = warm.events.indexOf('classified')
      const firstComplete = warm.events.findIndex((e) => e.startsWith('complete:'))
      expect(classifiedIdx).toBeGreaterThanOrEqual(0)
      expect(firstComplete).toBeGreaterThan(classifiedIdx)

      // The breakdown covers every task before the first finishes: both
      // up-to-date (outputs already current on disk from the warm run).
      expect(warm.classified).not.toBeNull()
      expect(warm.classified!.size).toBe(2)
      expect([...warm.classified!.values()].every((s) => s === 'up-to-date')).toBe(true)

      // Final outcomes are cache hits, byte-identical to today.
      expect(r.outcomes.every((o) => o.status === 'cache-hit')).toBe(true)
    },
    TIMEOUT,
  )

  it(
    'a cold run classifies every task as a miss upfront, then executes',
    async () => {
      await addProject(rec.root, 'solo', {
        files: { 'src/a.txt': 'hello' },
        config: `export default { tasks: { build: {
          exec: { command: "cat src/a.txt > out.txt" },
          cache: { inputs: { files: ['src/**'] }, outputs: { files: ['out.txt'] } },
        } } }`,
      })
      const r = await run({ cwd: rec.root, tasks: ['build'], log: recordingLogger(rec) })
      expect(r.ok).toBe(true)
      expect(rec.classified!.get('solo#build')).toBe('miss')
      // Classification preceded execution completion.
      expect(rec.events.indexOf('classified')).toBeLessThan(
        rec.events.findIndex((e) => e.startsWith('complete:')),
      )
      expect(r.outcomes[0]!.status).toBe('success')
    },
    TIMEOUT,
  )

  it(
    '--no-cache (force) skips classification entirely and runs everything',
    async () => {
      await addProject(rec.root, 'solo', {
        files: { 'src/a.txt': 'hello' },
        config: `export default { tasks: { build: {
          exec: { command: "cat src/a.txt > out.txt" },
          cache: { inputs: { files: ['src/**'] }, outputs: { files: ['out.txt'] } },
        } } }`,
      })
      // Warm first so a cache entry exists — proving --no-cache ignores it.
      await run({ cwd: rec.root, tasks: ['build'], log: recordingLogger(rec) })

      const forced: Recorder = { root: rec.root, events: [], classified: null }
      const r = await run({
        cwd: rec.root,
        tasks: ['build'],
        noCache: true,
        log: recordingLogger(forced),
      })
      expect(forced.classified).toBeNull() // hook never fired
      expect(forced.events.includes('classified')).toBe(false)
      expect(r.outcomes[0]!.status).toBe('success') // executed, not a hit
    },
    TIMEOUT,
  )

  it(
    'codegen → consumer (consumer globs the generated file) decides + restores correctly across runs',
    async () => {
      // build globs `**/*`, which matches codegen's generated.txt — its
      // upfront key is preliminary and recomputed mid-run. The final
      // cache decision + outputs must be correct regardless.
      const dir = await addProject(rec.root, 'gen', {
        files: { 'src/in.txt': 'v1' },
        config: `export default { tasks: {
          codegen: {
            exec: { command: "cat src/in.txt > generated.txt" },
            cache: { inputs: { files: ['src/**'] }, outputs: { files: ['generated.txt'] } },
          },
          build: {
            exec: { command: "cat generated.txt > out.txt" },
            dependsOn: ['codegen'],
            cache: { inputs: { files: ['**/*'] }, outputs: { files: ['out.txt'] } },
          },
        } }`,
      })

      // Cold run: both execute; out.txt reflects generated.txt (v1).
      const r1 = await run({ cwd: rec.root, tasks: ['build'], log: recordingLogger(rec) })
      expect(r1.outcomes.find((o) => o.node.id === 'gen#build')!.status).toBe('success')
      expect((await readFile(path.join(dir, 'out.txt'), 'utf8')).trim()).toBe('v1')

      // Warm re-run, unchanged: both hit, output stays v1.
      const warm: Recorder = { root: rec.root, events: [], classified: null }
      const r2 = await run({ cwd: rec.root, tasks: ['build'], log: recordingLogger(warm) })
      expect(r2.outcomes.find((o) => o.node.id === 'gen#build')!.status).toBe('cache-hit')
      expect((await readFile(path.join(dir, 'out.txt'), 'utf8')).trim()).toBe('v1')

      // Change codegen's input → codegen reruns, generated.txt changes,
      // build's recomputed mid-run key changes → build reruns; out.txt
      // becomes v2. The preliminary upfront key did NOT lock in a wrong
      // decision.
      await new Promise((res) => setTimeout(res, 5))
      await writeFile(path.join(dir, 'src/in.txt'), 'v2')
      const r3 = await run({ cwd: rec.root, tasks: ['build'], log: recordingLogger(rec) })
      expect(r3.outcomes.find((o) => o.node.id === 'gen#codegen')!.status).toBe('success')
      expect(r3.outcomes.find((o) => o.node.id === 'gen#build')!.status).toBe('success')
      expect((await readFile(path.join(dir, 'out.txt'), 'utf8')).trim()).toBe('v2')
    },
    TIMEOUT,
  )
})
