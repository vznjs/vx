// `vx last` — replay a recorded run's summary from the local history.
// E2e via bin.ts subprocesses (the why.test.ts pattern), plus parser units.

import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { gitIn, makeWorkspace as makeWorkspaceRoot } from './helpers/workspace.js'
import { parseLastArgs } from '../src/cli/index.js'
import { formatTaskRows } from '../src/cli/last.js'
import type { RunSummaryRow } from '../src/orchestrator/index.js'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
const TIMEOUT = 30_000

const APP_CONFIG = `
  export default {
    tasks: {
      build: {
        // Holds 150 MB so its peak rises above vx's own footprint — the
        // runner reports a peak only above that (see ownRssHighWater).
        exec: {
          command:
            'bun -e "const fs = require(\\'fs\\'); const b = Buffer.alloc(150 * 1024 * 1024, 1); fs.writeFileSync(\\'out.txt\\', fs.readFileSync(\\'src/input.txt\\')); console.log(b.length)"',
        },
        cache: {
          inputs: { files: ['src/**'] },
          outputs: { files: ['out.txt'] },
        },
      },
      boom: {
        exec: { command: 'exit 3' },
      },
      killed: {
        exec: { command: 'kill -9 $$' },
      },
      slow: {
        exec: { command: 'sleep 5', timeout: 300 },
      },
      dev: {
        exec: { command: 'echo nope; exit 2', persistent: { readyWhen: 'Listening' } },
      },
      after: {
        dependsOn: ['boom'],
        exec: { command: 'echo never' },
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
    'an executed task shows what it used; a hit shows nothing (it spent nothing)',
    async () => {
      const list = await vx(root, ['last', '--list', '--format', 'json'])
      const runs = JSON.parse(list.out) as { runId: string }[]
      const [hitRun, missRun] = [runs[0]!.runId, runs[1]!.runId]
      const miss = await vx(root, ['last', missRun])
      expect(miss.code).toBe(0)
      // The unit is proven by the bound, not the label: a task holding
      // 150 MB peaks between that and a few times it — kilobytes read as
      // a process that used nothing, bytes×1024 as one that used
      // gigabytes (the Linux defect of 2026-09-12).
      expect(miss.out).toMatch(/success\s+app#build\s+\S+\s+\S+  \d+(\.\d)? MB · \d+\.\d× cpu$/m)
      const missJson = JSON.parse((await vx(root, ['last', missRun, '--format', 'json'])).out) as {
        tasks: { peakRssBytes: number | null; cpuMs: number | null }[]
      }
      expect(missJson.tasks[0]!.peakRssBytes).toBeGreaterThan(150 * 1024 * 1024)
      expect(missJson.tasks[0]!.peakRssBytes).toBeLessThan(1024 * 1024 * 1024)
      expect(missJson.tasks[0]!.cpuMs).toBeGreaterThan(0)
      const hit = await vx(root, ['last', hitRun])
      expect(hit.out).toMatch(/cache-hit\s+app#build\s+\S+\s+\S+$/m)
      expect(hit.out).not.toContain('× cpu')
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
        // macOS realpaths /var → /private/var inside the child; pin the
        // unique tail, not the absolute prefix.
        expect(
          JSON.parse(info.out).cacheDir.endsWith(path.join(path.basename(other), 'elsewhere')),
        ).toBe(true)
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
      // The row reads as the frame did: the exit code, and no signal part
      // for a plain exit (item 260).
      expect(r.out).toMatch(/failed \(exit 3\)\s+app#boom/)
      expect(r.out).not.toContain('128 +')
    },
    TIMEOUT,
  )

  it(
    'a task killed by a signal replays with the exit code and the signal it stands for',
    async () => {
      const r1 = await vx(root, ['run', 'killed', '--all'])
      expect(r1.code).not.toBe(0)
      const r = await vx(root, ['last'])
      expect(r.code).toBe(0)
      expect(r.out).toMatch(
        /failed \(exit 137\)\s+app#killed\s+\S+ms\s+\S+\s+no-cache.*128 \+ SIGKILL$/m,
      )
    },
    TIMEOUT,
  )

  it(
    'the reasons the footer gave ride the rows: a timeout, a never-ready server, a skip',
    async () => {
      const r1 = await vx(root, ['run', 'slow', 'dev', 'after', '--all'])
      expect(r1.code).not.toBe(0)
      const r = await vx(root, ['last'])
      expect(r.code).toBe(0)
      // A timeout reads as the reason, not as the SIGTERM its 143 is.
      expect(r.out).toMatch(/failed \(exit 143\)\s+app#slow.*  timed out$/m)
      expect(r.out).not.toContain('128 + SIGTERM')
      // A never-ready server keeps the child's own exit and names why.
      expect(r.out).toMatch(/failed \(exit 2\)\s+app#dev.*  never ready: exited$/m)
      // A skip names the failure that blocked it.
      expect(r.out).toMatch(/skipped\s+app#after.*  after app#boom failed$/m)
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

  it('--list N takes its count in the space form, and a run id beside --list is refused (item 899)', () => {
    // `--list 1` read the 1 as a run id that --list then dropped, and ten
    // runs came back.
    const pick = (args: string[]) => {
      const p = parseLastArgs(args)
      return { list: p.list, runId: p.runId, error: p.error }
    }
    expect([
      pick(['--list', '1']),
      pick(['--list', '1', '--format', 'json']),
      pick(['--list', '--format', 'json']),
      pick(['--list', '0']),
    ]).toEqual([
      { list: 1, runId: undefined, error: undefined },
      { list: 1, runId: undefined, error: undefined },
      { list: 10, runId: undefined, error: undefined },
      { list: undefined, runId: undefined, error: 'invalid --list: 0 (expected 1..500)' },
    ])
    expect(pick(['01a0dee9-run', '--list']).error).toBe(
      'a run id and --list do not combine: replay 01a0dee9-run, or list runs',
    )
    expect(pick(['--list=3', 'r1']).error).toBe(
      'a run id and --list do not combine: replay r1, or list runs',
    )
  })
})

// A thousand-task warm run replayed as a thousand rows put the one failure
// a screen's height above the prompt (item 280): hits fold past sixteen.
describe('formatTaskRows', () => {
  const row = (task: string, over: Partial<RunSummaryRow> = {}): RunSummaryRow =>
    ({
      id: 0,
      runId: 'r',
      project: 'p',
      task,
      status: 'success',
      exitCode: 0,
      durationMs: 5,
      startedAt: 0,
      endedAt: 5,
      cacheHit: false,
      cached: true,
      hash: 'h',
      cpuMs: null,
      peakRssBytes: null,
      wallclockStartNs: null,
      wallclockEndNs: null,
      blockedBy: null,
      timedOut: null,
      sandboxViolations: null,
      notReady: null,
      ...over,
    }) as RunSummaryRow
  const hit = (n: number, ms: number) =>
    row(`hit${n}`, { status: 'cache-hit', cacheHit: true, durationMs: ms })

  // Item 510, by the age rule: this file's newest dated comment was
  // 2026-08-23. `vx last` exists to REPORT a run accurately, so its
  // formatting boundaries are its contract, and five of them were
  // unasserted — `<` → `<=` at both duration cuts, the divide-by-zero
  // guard, the violation count's `> 0`, and its plural. All five passed
  // the whole suite together.
  it.each([
    [999, '999ms'],
    [1000, '1.00s'], // AT the cut, not around it (item 503)
    [59_999, '60.00s'],
    [60_000, '1m 0s'],
  ])('formats %dms as %s', (ms, want) => {
    expect(formatTaskRows([row('t', { durationMs: ms })])[1]).toContain(want)
  })

  it('a zero-duration task reports no cpu ratio rather than NaN', () => {
    // cpuMs / durationMs with both zero is NaN, and the guard that stops
    // it fails nothing else in the suite. A replay showing `NaN× cpu` is
    // a report that lies about what the run did.
    const line = formatTaskRows([row('t', { durationMs: 0, cpuMs: 0 })])[1]!
    expect(line).not.toContain('NaN')
    expect(line).not.toContain('Infinity')
    expect(line).not.toContain('cpu')
  })

  it.each([
    [0, ''],
    [1, '1 sandbox violation'],
    [2, '2 sandbox violations'],
  ])('reports %d sandbox violations as "%s"', (n, want) => {
    const line = formatTaskRows([
      row('t', { status: 'failed', exitCode: 1, sandboxViolations: n }),
    ])[1]!
    // The SUFFIX, exactly — not `toContain`. `'1 sandbox violations'`
    // contains `'1 sandbox violation'`, so a containment assertion passes
    // on the wrong plural and the mutation survived this row the first
    // time it was written (item 510). Zero says nothing at all: a failed
    // task that violated nothing must not read as though the sandbox were
    // involved.
    expect(line.slice(line.indexOf('h') + 1).trim()).toBe(want)
    // CONTROL: the row is otherwise intact, so none of the above can pass
    // on a formatter that dropped the line.
    expect(line).toContain('failed (exit 1)')
  })

  it('orders failed, then executed and skipped, then hits, and folds the hits past sixteen', () => {
    const hits = Array.from({ length: 30 }, (_, i) => hit(i, 100 - i))
    const lines = formatTaskRows([
      ...hits.slice(0, 10),
      row('ran'),
      row('boom', { status: 'failed', exitCode: 3 }),
      ...hits.slice(10),
      row('after', { status: 'skipped', blockedBy: 'p#boom' }),
    ])
    const words = lines.slice(1).map((l) => l.trim().split(/\s+/)[0])
    expect(words.slice(0, 3)).toEqual(['failed', 'success', 'skipped'])
    expect(words.slice(3, 19).every((w) => w === 'cache-hit')).toBe(true)
    expect(lines.length).toBe(1 + 3 + 16 + 1)
    // The sixteen shown are the slowest restores, in that order.
    const shown = lines.slice(4, 20).map((l) => /hit(\d+)/.exec(l)![1])
    expect(shown).toEqual(Array.from({ length: 16 }, (_, i) => String(i)))
    expect(lines.at(-1)).toBe(
      '  … +14 more cache hits (the 16 slowest restores shown) — vx last --format json lists every row',
    )
  })

  it('sixteen hits list in full, no fold (control)', () => {
    const lines = formatTaskRows(Array.from({ length: 16 }, (_, i) => hit(i, i)))
    expect(lines.length).toBe(17)
    expect(lines.some((l) => l.includes('more cache hits'))).toBe(false)
  })

  it('a run with nothing recorded renders no rows', () => {
    expect(formatTaskRows([])).toEqual([])
  })
})
