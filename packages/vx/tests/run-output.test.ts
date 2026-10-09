// A failed task's output and the files it names, kept in the run's history
// (`run_output`) so an agent reads why a task failed without the terminal:
// `vx last --format json` and `@vzn/vx-mcp`'s getFailures read it.

import { chmod, mkdir, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { BoundedCapture, droppedOutputLine } from '../src/exec/runner.js'
import { decodeOutputLog, failedOutputLog } from '../src/orchestrator/output-log.js'
import { fileLocations } from '../src/orchestrator/path-links.js'
import { skipAsRoot } from './helpers/nonroot-gate.js'
import { gitInitCommit, makeWorkspace } from './helpers/workspace.js'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
const TIMEOUT = 30_000

describe('BoundedCapture bounds', () => {
  it('keeps the head and tail it was given and names them in the dropped line', () => {
    const c = new BoundedCapture(4, 6)
    c.push('abcdefghijkl')
    expect(c.chunks()).toEqual([
      { text: 'abcd', err: false },
      { text: droppedOutputLine(2, 4, 6), err: false },
      { text: 'ghijkl', err: false },
    ])
    expect(droppedOutputLine(2, 8 * 1024, 56 * 1024)).toBe(
      "\n[vx] 0.0 MiB of output not kept — vx keeps the first 8 KiB and the last 56 KiB of a task's output\n",
    )
  })

  it("re-bounds an entry's capture to a failure's 8 KiB head and 56 KiB tail", () => {
    const big = new BoundedCapture()
    big.push('h'.repeat(8 * 1024))
    big.push('m'.repeat(100 * 1024), true)
    big.push('END', true)
    const text = decodeOutputLog(failedOutputLog(big, true))
    expect(text.map((c) => [c.err, c.text.length])).toEqual([
      [false, 8 * 1024 + droppedOutputLine(100 * 1024 + 3 - 56 * 1024, 8 * 1024, 56 * 1024).length],
      [true, 56 * 1024],
    ])
    expect(text[1]!.text.endsWith('mEND')).toBe(true)
    // Already a failure's size: kept as is.
    const small = new BoundedCapture(8 * 1024, 56 * 1024)
    small.push('out')
    small.push('err', true)
    expect(failedOutputLog(small, false)).toBe('out\x1eeerr')
  })
})

describe('fileLocations', () => {
  it('lists the existing files the text names with line and column, unique, in order', () => {
    const dir = '/w/app'
    const exists = new Set(['/w/app/src/a.ts', '/w/app/b.js', '/abs/c.ts'])
    const text = [
      'src/a.ts:3:7 - error',
      'b.js(4,2): error',
      'src/a.ts:3:7 again',
      'src/a.ts:9',
      'gone.ts:1:1',
      'at /abs/c.ts',
      'https://x.dev/src/a.ts:1',
    ].join('\n')
    expect(fileLocations(text, dir, (f) => exists.has(f))).toEqual([
      { file: '/w/app/src/a.ts', line: 3, col: 7 },
      { file: '/w/app/b.js', line: 4, col: 2 },
      { file: '/w/app/src/a.ts', line: 9 },
      { file: '/abs/c.ts' },
    ])
  })

  it('stops at 50', () => {
    const text = Array.from({ length: 60 }, (_, i) => `a.ts:${i + 1}`).join('\n')
    const got = fileLocations(text, '/w', () => true)
    expect(got.length).toBe(50)
    expect(got.at(-1)).toEqual({ file: '/w/a.ts', line: 50 })
  })
})

const CONFIG = `
  export default {
    tasks: {
      fail: {
        exec: { command: "printf '\\\\033[31merror\\\\033[0m src/a.ts:3:7 bad\\\\nsrc/a.ts(4,2): x\\\\nnope.ts:1\\\\n' >&2; exit 2" },
        cache: { inputs: { files: ['src/**'] }, outputs: { files: [] } },
      },
      failnc: {
        exec: { command: 'echo see src/a.ts:1; exit 3' },
      },
      ok: {
        exec: { command: 'echo fine src/a.ts:1' },
      },
      bunlike: {
        exec: { command: "printf 'package.json\\nsrc/a.ts:\\n4 | x\\n  at <anonymous> (src/a.ts:4:19)\\n'; exit 1" },
      },
      flip: {
        exec: { command: 'test -f fixed || exit 4' },
      },
    },
  }
`

async function vx(root: string, args: string[]): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn([process.execPath, BIN, ...args], {
    cwd: root,
    env: { ...process.env },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
  return { code, out }
}

interface Row {
  task: string
  status: string
  output?: string
  locations?: unknown[]
}

async function lastRows(root: string): Promise<Row[]> {
  return (JSON.parse((await vx(root, ['last', '--format', 'json'])).out) as { tasks: Row[] }).tasks
}

describe('vx last --format json (e2e)', () => {
  let root: string
  let app: string
  beforeAll(async () => {
    root = await realpath(await makeWorkspace({ prefix: 'vx-run-output-', git: false }))
    app = path.join(root, 'packages', 'app')
    await mkdir(path.join(app, 'src'), { recursive: true })
    await writeFile(path.join(app, 'package.json'), JSON.stringify({ name: 'app' }))
    await writeFile(path.join(app, 'vx.config.mjs'), CONFIG)
    await writeFile(path.join(app, 'src', 'a.ts'), 'x\n')
    gitInitCommit(root)
  }, TIMEOUT)
  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })
  const failures = (): string => path.join(root, '.vx', 'cache', 'failures')

  it(
    'a failed row carries its plain output and the files it names; a green one neither',
    async () => {
      expect((await vx(root, ['run', 'app#fail'])).code).not.toBe(0)
      expect(await lastRows(root)).toMatchObject([
        {
          task: 'fail',
          status: 'failed',
          output: 'error src/a.ts:3:7 bad\nsrc/a.ts(4,2): x\nnope.ts:1\n',
          locations: [
            { file: path.join(app, 'src', 'a.ts'), line: 3, col: 7 },
            { file: path.join(app, 'src', 'a.ts'), line: 4, col: 2 },
          ],
        },
      ])

      expect((await vx(root, ['run', 'app#failnc'])).code).not.toBe(0)
      const [nc] = await lastRows(root)
      expect([nc!.output, nc!.locations]).toEqual([
        'see src/a.ts:1\n',
        [{ file: path.join(app, 'src', 'a.ts'), line: 1 }],
      ])

      expect((await vx(root, ['run', 'app#ok'])).code).toBe(0)
      const [ok] = await lastRows(root)
      expect(ok!.status).toBe('success')
      expect(['output' in ok!, 'locations' in ok!]).toEqual([false, false])
      // Two failed runs, two files; the green run wrote none.
      expect((await readdir(failures())).length).toBe(2)
    },
    TIMEOUT,
  )

  it(
    'a failed run with no file reads empty output; the newest 50 files are kept',
    async () => {
      for (const n of await readdir(failures())) await rm(path.join(failures(), n))
      expect((await vx(root, ['run', 'app#failnc'])).code).not.toBe(0)
      const [mine] = await readdir(failures())
      await rm(path.join(failures(), mine!))
      const [row] = await lastRows(root)
      expect([row!.status, row!.output, row!.locations]).toEqual(['failed', '', []])

      // Older than any run id vx mints now (UUIDv7: names sort by time).
      const old = Array.from(
        { length: 52 },
        (_, i) => `00000000000000000000000${String(i).padStart(3, '0')}.json`,
      )
      for (const n of old) await writeFile(path.join(failures(), n), '{}')
      expect((await vx(root, ['run', 'app#failnc'])).code).not.toBe(0)
      const kept = (await readdir(failures())).sort()
      expect(kept.length).toBe(50)
      expect(kept.slice(0, 49)).toEqual(old.slice(3))
      expect(kept[49]).toBe(
        `${(JSON.parse((await vx(root, ['last', '--format', 'json'])).out) as { invocation: { runId: string } }).invocation.runId}.json`,
      )
    },
    TIMEOUT,
  )

  it.skipIf(skipAsRoot('a refused failures write'))(
    'a refused write of the output does not change the verdict',
    async () => {
      await chmod(failures(), 0o555)
      try {
        const proc = Bun.spawn([process.execPath, BIN, 'run', 'app#failnc'], {
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
        expect(code).toBe(1) // the task failing, as with the write
        expect((out + err).match(/\[vx\] failed tasks' output not kept: .*EACCES.*/)?.length).toBe(
          1,
        )
        expect(out + err).not.toContain('internal error')
      } finally {
        await chmod(failures(), 0o755)
      }
    },
    TIMEOUT,
  )

  it(
    "a file also named with a line drops its bare mention (bun test's header); a bare-only one stays",
    async () => {
      expect((await vx(root, ['run', 'app#bunlike'])).code).not.toBe(0)
      const [row] = await lastRows(root)
      expect(row!.locations).toEqual([
        { file: path.join(app, 'package.json') },
        { file: path.join(app, 'src', 'a.ts'), line: 4, col: 19 },
      ])
    },
    TIMEOUT,
  )

  it(
    'a replayed failure names the later run that passed the task; another task passing does not',
    async () => {
      type Last = { invocation: { runId: string }; tasks: (Row & { fixedIn?: string })[] }
      const failed = async (): Promise<Last> =>
        JSON.parse((await vx(root, ['last', '--failed', '--format', 'json'])).out) as Last
      expect((await vx(root, ['run', 'app#flip'])).code).not.toBe(0)
      const red = (await failed()).invocation.runId
      expect((await vx(root, ['run', 'app#ok'])).code).toBe(0)
      expect((await failed()).tasks.map((t) => [t.task, t.fixedIn])).toEqual([['flip', undefined]])
      await writeFile(path.join(app, 'fixed'), '')
      expect((await vx(root, ['run', 'app#flip'])).code).toBe(0)
      const green = (JSON.parse((await vx(root, ['last', '--format', 'json'])).out) as Last)
        .invocation.runId
      const replay = await failed()
      expect([replay.invocation.runId, replay.tasks.map((t) => [t.task, t.fixedIn])]).toEqual([
        red,
        [['flip', green]],
      ])
    },
    TIMEOUT,
  )
})
