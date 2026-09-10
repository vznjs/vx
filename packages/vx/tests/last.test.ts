// `vx last` — replay a recorded run's summary from the local history.
// E2e via bin.ts subprocesses (the why.test.ts pattern), plus parser units.

import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { gitIn, makeWorkspace as makeWorkspaceRoot } from './helpers/workspace.js'
import { parseLastArgs } from '../src/cli/index.js'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
const TIMEOUT = 30_000

const APP_CONFIG = `
  export default {
    tasks: {
      build: {
        exec: { command: 'cat src/input.txt > out.txt' },
        cache: {
          inputs: { files: ['src/**'] },
          outputs: { files: ['out.txt'] },
        },
      },
      boom: {
        exec: { command: 'exit 3' },
      },
    },
  }
`

async function makeWorkspace(): Promise<string> {
  const root = await makeWorkspaceRoot({ prefix: 'vx-last-', git: false })
  const appDir = path.join(root, 'packages', 'app')
  await mkdir(path.join(appDir, 'src'), { recursive: true })
  await writeFile(path.join(appDir, 'package.json'), JSON.stringify({ name: 'app' }))
  await writeFile(path.join(appDir, 'vx.config.mjs'), APP_CONFIG)
  await writeFile(path.join(appDir, 'src', 'input.txt'), 'v1\n')
  const git = gitIn(root)
  git('init', '-q')
  git('add', '-A')
  return root
}

interface VxResult {
  code: number
  out: string
  err: string
}

async function vx(root: string, args: string[]): Promise<VxResult> {
  const proc = Bun.spawn([process.execPath, BIN, ...args], {
    cwd: root,
    env: { ...process.env },
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

describe('vx last (e2e)', () => {
  let root: string
  beforeAll(async () => {
    root = await makeWorkspace()
    await vx(root, ['run', 'build', '--all'])
    await vx(root, ['run', 'build', '--all']) // second run: a cache hit
  }, TIMEOUT)
  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it(
    'replays the latest run: header + per-task line, no re-execution',
    async () => {
      const r = await vx(root, ['last'])
      expect(r.code).toBe(0)
      expect(r.out).toContain('run ')
      expect(r.out).toContain('— ok')
      expect(r.out).toContain('$ ')
      expect(r.out).toContain('1 task · 1 hit (1 local, 0 remote)')
      expect(r.out).toMatch(/cache-hit\s+app#build/)
    },
    TIMEOUT,
  )

  it(
    '--list shows both runs, newest first, with run ids that replay',
    async () => {
      const r = await vx(root, ['last', '--list'])
      expect(r.code).toBe(0)
      const lines = r.out.trim().split('\n')
      expect(lines.length).toBe(2)
      expect(lines[0]).toContain('ok')
      // The newest line's run id replays that exact run.
      const runId = lines[0]!.trim().split(/\s+/)[2]!
      const detail = await vx(root, ['last', runId])
      expect(detail.code).toBe(0)
      expect(detail.out).toContain(`run ${runId}`)
    },
    TIMEOUT,
  )

  it(
    '--cache-dir reads the history a run with the same flag wrote, and nothing else',
    async () => {
      // A run that wrote elsewhere is invisible to a bare `vx last` and
      // visible to `vx last --cache-dir` — the same resolution as the run's.
      const other = await makeWorkspace()
      try {
        const r1 = await vx(other, ['run', 'build', '--all', '--cache-dir', 'elsewhere'])
        expect(r1.code).toBe(0)
        const there = await vx(other, ['last', '--list', '--cache-dir', 'elsewhere'])
        expect(there.code).toBe(0)
        expect(there.out.trim().split('\n').length).toBe(1)
        expect(there.out).toContain('ok')
        const here = await vx(other, ['last', '--list'])
        expect(here.out.trim()).toBe('no recorded runs')
        // The same directory, spelled with `=` and read by `vx info`.
        const info = await vx(other, ['info', '--format=json', '--cache-dir=elsewhere'])
        expect(info.code).toBe(0)
        expect(JSON.parse(info.out).cacheDir).toBe(path.join(other, 'elsewhere'))
        expect(JSON.parse(info.out).runs24h).toBe(1)
      } finally {
        await rm(other, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )

  it(
    'a failed run replays FAILED with the failure first',
    async () => {
      const r1 = await vx(root, ['run', 'boom', '--all'])
      expect(r1.code).not.toBe(0)
      const r = await vx(root, ['last'])
      expect(r.code).toBe(0)
      expect(r.out).toContain('— FAILED')
      expect(r.out).toContain('1 failed')
      expect(r.out).toMatch(/failed\s+app#boom/)
    },
    TIMEOUT,
  )

  it(
    '--format json emits the invocation + tasks',
    async () => {
      const r = await vx(root, ['last', '--format', 'json'])
      expect(r.code).toBe(0)
      const parsed = JSON.parse(r.out) as { invocation: { runId: string }; tasks: unknown[] }
      expect(parsed.invocation.runId.length).toBeGreaterThan(0)
      expect(parsed.tasks.length).toBeGreaterThan(0)
    },
    TIMEOUT,
  )

  it(
    'an unknown run id fails loud and points at --list',
    async () => {
      const r = await vx(root, ['last', 'no-such-run'])
      expect(r.code).not.toBe(0)
      expect(r.err).toContain('no recorded run no-such-run')
      expect(r.err).toContain('--list')
      // `bin.ts` owns the `vx: ` prefix, and a message that already names
      // the tool used to get it twice — `vx: vx last: …` (2026-09-04).
      expect(r.err).not.toContain('vx: vx ')
      expect(r.err.trimStart()).toStartWith('vx last: ')
    },
    TIMEOUT,
  )
})

describe('parseLastArgs', () => {
  it('parses runId, --list in both forms, --format; rejects garbage', () => {
    expect(parseLastArgs([]).format).toBe('pretty')
    expect(parseLastArgs(['abc']).runId).toBe('abc')
    expect(parseLastArgs(['--list']).list).toBe(10)
    expect(parseLastArgs(['--list=25']).list).toBe(25)
    expect(parseLastArgs(['--list=0']).error).toMatch(/1\.\.500/)
    expect(parseLastArgs(['--format', 'json']).format).toBe('json')
    expect(parseLastArgs(['--format=pretty']).format).toBe('pretty')
    expect(parseLastArgs(['--format', 'yaml']).error).toMatch(/pretty \| json/)
    expect(parseLastArgs(['--cache-dir', 'x']).cacheDir).toBe('x')
    expect(parseLastArgs(['--cache-dir=y/z', '--list']).list).toBe(10)
    expect(parseLastArgs(['--cache-dir']).error).toMatch(/requires a path/)
    expect(parseLastArgs(['--cache-dir', '--list']).error).toMatch(/got flag/)
    expect(parseLastArgs(['--nope']).error).toMatch(/unknown flag/)
    expect(parseLastArgs(['a', 'b']).error).toMatch(/unexpected argument/)
  })
})
