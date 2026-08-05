// `vx why` e2e — subprocess-driven like show-info.test.ts so the dispatcher
// wiring, exit codes, and UserError presentation match what a user sees.
// The fixture runs a real task twice with a changed input file so the
// persisted entry_inputs rows carry a genuine component-level diff.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { parseWhyArgs } from '../src/cli/index.js'

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
    },
  }
`

async function sh(cwd: string, cmd: string[]): Promise<void> {
  const proc = Bun.spawn(cmd, { cwd, stdout: 'ignore', stderr: 'ignore' })
  await proc.exited
}

async function makeWorkspace(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vx-why-'))
  await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'fixture-root', private: true }),
  )
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

describe('vx why (e2e)', () => {
  let root: string
  beforeAll(async () => {
    root = await makeWorkspace()
    // Two runs with a changed input in between → a real key change with
    // component-level fingerprints on both entries.
    await vx(root, ['run', 'build', '--all'])
    await writeFile(path.join(root, 'packages', 'app', 'src', 'input.txt'), 'v2\n')
    await vx(root, ['run', 'build', '--all'])
  }, TIMEOUT)
  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it(
    'names the changed input component between the last two runs',
    async () => {
      const r = await vx(root, ['why', 'app#build'])
      expect(r.code).toBe(0)
      expect(r.out).toContain('app#build — run ')
      expect(r.out).toContain('cache key changed')
      expect(r.out).toContain('what changed')
      // The exact changed component: the edited input file, kind `file`.
      expect(r.out).toMatch(/changed\s+file\s+.*input\.txt/)
    },
    TIMEOUT,
  )

  it(
    'a bare task name resolves when unique across projects',
    async () => {
      const r = await vx(root, ['why', 'build'])
      expect(r.code).toBe(0)
      expect(r.out).toContain('app#build')
    },
    TIMEOUT,
  )

  it(
    '--format json emits the machine shape (why + component diff)',
    async () => {
      const r = await vx(root, ['why', 'app#build', '--format', 'json'])
      expect(r.code).toBe(0)
      const parsed = JSON.parse(r.out) as {
        taskId: string
        why: { hashChanged: boolean }
        diff: { entries: Array<{ kind: string; name: string; change: string }> }
      }
      expect(parsed.taskId).toBe('app#build')
      expect(parsed.why.hashChanged).toBe(true)
      expect(
        parsed.diff.entries.some((e) => e.kind === 'file' && e.name.includes('input.txt')),
      ).toBe(true)
    },
    TIMEOUT,
  )

  it(
    'an unknown task errors with include-match suggestions',
    async () => {
      const r = await vx(root, ['why', 'app#buil'])
      expect(r.code).toBe(1)
      expect(r.err).toContain('no recorded runs')
      expect(r.err).toContain('did you mean app#build')
    },
    TIMEOUT,
  )

  it(
    'a stale --run id errors clearly',
    async () => {
      const r = await vx(root, ['why', 'app#build', '--run', 'nope'])
      expect(r.code).toBe(1)
      expect(r.err).toContain('has no row')
    },
    TIMEOUT,
  )
})

describe('parseWhyArgs', () => {
  it('parses target, --run and --format in both forms', () => {
    expect(parseWhyArgs(['app#build'])).toEqual({ target: 'app#build', format: 'pretty' })
    expect(parseWhyArgs(['build', '--run', 'r1'])).toEqual({
      target: 'build',
      runId: 'r1',
      format: 'pretty',
    })
    expect(parseWhyArgs(['build', '--run=r1', '--format=json'])).toEqual({
      target: 'build',
      runId: 'r1',
      format: 'json',
    })
  })

  it('rejects unknown flags, bad formats, empty --run, extra positionals', () => {
    expect(parseWhyArgs(['--nope']).error).toContain('unknown flag')
    expect(parseWhyArgs(['--format', 'xml']).error).toContain('invalid --format')
    expect(parseWhyArgs(['--run=']).error).toContain('invalid --run')
    expect(parseWhyArgs(['a', 'b']).error).toContain('unexpected argument')
  })

  it.each([
    ['--run', 'invalid --run'],
    ['--format', 'invalid --format'],
  ])('names %s when its value is omitted, instead of calling it unknown', (flag, expected) => {
    // A trailing flag used to consume a non-existent argv slot, fall through
    // to the catch-all, and be reported as `unknown flag: --run` — false, and
    // silent about the real mistake. The `=` spelling of the SAME mistake
    // already said `invalid --run: empty`, so one omitted value got two
    // different diagnoses depending on how it was typed.
    const err = parseWhyArgs(['app#build', flag]).error
    expect({ flag, err }).toEqual({ flag, err: expect.stringContaining(expected) })
    expect(err).not.toContain('unknown flag')
    // And never the literal word "undefined" — an omitted value is empty.
    expect(err).not.toContain('undefined')
  })

  it('still rejects a genuinely unknown flag that merely shares a prefix', () => {
    // Control: the fix matches on the flag NAME, so it must not swallow
    // anything that happens to start with the same letters.
    expect(parseWhyArgs(['--runner']).error).toContain('unknown flag: --runner')
    expect(parseWhyArgs(['--formatting']).error).toContain('unknown flag: --formatting')
  })
})
