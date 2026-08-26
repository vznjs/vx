// `vx last` — replay a recorded run's summary from the local history.
// E2e via bin.ts subprocesses (the why.test.ts pattern), plus parser units.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { writeLocalWorkspace } from './helpers/local-workspace.js'
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

async function sh(cwd: string, cmd: string[]): Promise<void> {
  const proc = Bun.spawn(cmd, { cwd, stdout: 'ignore', stderr: 'ignore' })
  await proc.exited
}

async function makeWorkspace(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vx-last-'))
  await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'fixture-root', private: true }),
  )
  await writeLocalWorkspace(root)
  const appDir = path.join(root, 'packages', 'app')
  await mkdir(path.join(appDir, 'src'), { recursive: true })
  await writeFile(path.join(appDir, 'package.json'), JSON.stringify({ name: 'app' }))
  await writeFile(path.join(appDir, 'vx.config.mjs'), APP_CONFIG)
  await writeFile(path.join(appDir, 'src', 'input.txt'), 'v1\n')
  await sh(root, ['git', 'init', '-q'])
  await sh(root, ['git', 'add', '-A'])
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
    expect(parseLastArgs(['--nope']).error).toMatch(/unknown flag/)
    expect(parseLastArgs(['a', 'b']).error).toMatch(/unexpected argument/)
  })
})
