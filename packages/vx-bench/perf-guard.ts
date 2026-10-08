// The per-PR performance guard: small synthetic runs of vx's hot paths
// (plan, up-to-date check, restore, one edit), held in numbers a shared
// CI runner cannot blur.
//
//   bun perf-guard.ts            check against perf-baseline.json
//   bun perf-guard.ts --update   rewrite this platform's baseline
//
// COUNTS (processes spawned, hashes taken, SQLite statements run) are
// deterministic: the same code does the same work on any box. A count
// that grows fails, and a PR that means it commits the new baseline,
// which puts the number in its diff; a count that shrinks passes. Counts
// are taken at two sizes, so work that grows faster than the package
// count shows in the pair. TIME is printed, never held: the min of
// interleaved reps at the larger size, divided by a calibration loop run
// between them. On CI beside the test shards it read 1.97× on a PR that
// made no phase slower, and a local gate on four cores runs it beside
// twelve shards, so no limit both holds and stays quiet.
import { Database } from 'bun:sqlite'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { planRun, run, type Logger } from '@vzn/vx'

const BASELINE = path.join(import.meta.dir, 'perf-baseline.json')
const SMALL = 25
const LARGE = 100
const REPS = 7
const ATTEMPTS = 3
/** A timed number past baseline × this is flagged in the table; it fails nothing. */
const TIME_FLAG = 1.5
// Past vx's racy-mtime windows (FILE_HASH_RACY_MS, OUTPUT_DIRS_RACY_MS,
// 50 ms): a file changed closer than that to a read is not memoised, so
// a count taken inside one depends on the box's speed.
const RACY_MS = 120
// The directory-snapshot flush runs only for directories outside that
// window when it lands, which under load moves by a dozen rows; the
// rest of SQLite's work is exact.
const RACY_STATEMENTS = [/\boutput_dirs\b/, /^SELECT 1 FROM entries WHERE hash = \?$/]

// ---------------------------------------------------------------- counters

type Counts = Record<string, number>
let counts: Counts = {}
const bump = (k: string): void => {
  counts[k] = (counts[k] ?? 0) + 1
}

type Loose = (this: unknown, ...a: unknown[]) => unknown
function wrap(obj: object, key: string, label: () => string | null): void {
  const o = obj as Record<string, Loose>
  const orig = o[key]!
  o[key] = function (this: unknown, ...args: unknown[]) {
    const l = label()
    if (l !== null) bump(l)
    return orig.apply(this, args)
  }
}

// `node:fs` cannot be counted this way: Bun binds a module's fs imports at
// link time, so a patched export is never the one vx calls (probed).
// Syscalls are `tests/syscall-repeats.unsafe.test.ts`'s, under strace.
for (const fn of ['spawn', 'spawnSync'] as const) {
  const orig = Bun[fn] as unknown as Loose
  ;(Bun as unknown as Record<string, Loose>)[fn] = function (this: unknown, ...a: unknown[]) {
    const first = a[0]
    const cmd = Array.isArray(first) ? first : (first as { cmd?: unknown[] }).cmd
    bump(`spawn ${path.basename(String(cmd?.[0]))}`)
    return orig.apply(this, a)
  }
}
wrap(Bun.hash, 'xxHash3', () => 'hash xxh3')
wrap(Bun.CryptoHasher.prototype, 'update', () => 'hash blob update')

// Each statement object is wrapped once: `db.query()` hands back a cached
// one, and re-wrapping it per call counts each call many times
// (sqlite-tally.ts).
const sqlLabel = (sql: string) => () =>
  RACY_STATEMENTS.some((r) => r.test(sql)) ? null : 'sqlite statement'
const seen = new WeakSet<object>()
for (const m of ['prepare', 'query'] as const) {
  const orig = Database.prototype[m] as unknown as Loose
  ;(Database.prototype as unknown as Record<string, Loose>)[m] = function (this: unknown, ...a) {
    const stmt = orig.apply(this, a) as Record<string, unknown>
    if (seen.has(stmt)) return stmt
    seen.add(stmt)
    const sql = String(a[0]).replace(/\s+/g, ' ').trim()
    for (const k of ['run', 'get', 'all', 'values', 'iterate']) {
      if (typeof stmt[k] === 'function') wrap(stmt, k, sqlLabel(sql))
    }
    return stmt
  }
}
for (const m of ['run', 'exec']) wrap(Database.prototype, m, () => 'sqlite statement')

// ---------------------------------------------------------------- fixture

const silent: Logger = { status() {}, taskStdout() {}, taskStderr() {}, taskComplete() {} }
const pkg = (i: number) => `pkg-${String(i).padStart(3, '0')}`

function sh(cwd: string, ...cmd: string[]): void {
  const p = Bun.spawnSync({ cmd, cwd, stdout: 'pipe', stderr: 'pipe' })
  if (p.exitCode !== 0) throw new Error(`${cmd.join(' ')}: ${p.stderr.toString()}`)
}

/**
 * `n` packages of five sources each, each depending on up to three of
 * the nine before it (generate.ts's band); `build` writes `dist`, `test`
 * follows it. A `settled` build sleeps past the racy window so the
 * outputs it leaves are memoised the same way on every box.
 */
async function workspace(n: number, settled: boolean): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), `vx-perf-${n}-`))
  await writeFile(path.join(root, 'package.json'), '{"name":"perf-root","private":true}\n')
  await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
  await writeFile(path.join(root, '.gitignore'), 'dist\n.vx\n')
  await writeFile(path.join(root, 'vx.workspace.mjs'), 'export default { plugins: [] }\n')
  const config = `export default {
  tasks: {
    build: {
      dependsOn: ['^build'],
      exec: { command: 'mkdir -p dist && cat src/*.js > dist/out.js${settled ? ` && sleep ${RACY_MS / 1000}` : ''}' },
      cache: { inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] } },
    },
    test: {
      dependsOn: ['build'],
      exec: { command: 'true' },
      cache: { inputs: { files: ['src/**'] }, outputs: { files: [] } },
    },
  },
}
`
  for (let i = 0; i < n; i++) {
    const dependencies: Record<string, string> = {}
    for (let k = 1; k <= 3 && i - k * 3 >= 0; k++) dependencies[pkg(i - k * 3)] = 'workspace:*'
    const dir = path.join(root, 'packages', pkg(i))
    await mkdir(path.join(dir, 'src'), { recursive: true })
    await writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: pkg(i), version: '0.0.0', dependencies }),
    )
    await writeFile(path.join(dir, 'vx.config.mjs'), config)
    for (let f = 0; f < 5; f++) {
      await writeFile(path.join(dir, 'src', `m${f}.js`), `export const v = ${i * 10 + f}\n`)
    }
  }
  const id = ['-c', 'user.email=perf@vx', '-c', 'user.name=perf', '-c', 'commit.gpgsign=false']
  sh(root, 'git', 'init', '-q')
  sh(root, 'git', 'add', '-A')
  sh(root, 'git', ...id, 'commit', '-qm', 'fixture')
  return root
}

const options = (cwd: string) => ({
  cwd,
  tasks: ['test'],
  cacheDir: path.join(cwd, '.vx', 'cache'),
  log: silent,
  concurrency: 4,
  handleSignals: false,
})

async function vxRun(cwd: string): Promise<void> {
  if (!(await run(options(cwd))).ok) throw new Error(`perf-guard: the run failed in ${cwd}`)
}

// ---------------------------------------------------------------- phases

interface Phase {
  name: string
  /** Puts the workspace in the phase's starting state; not measured. */
  setup?: (cwd: string, n: number) => Promise<void>
  body: (cwd: string) => Promise<void>
  /** Its wall time is held. A phase that spawns a shell per task is not. */
  timed: boolean
}

/** In order, each from the state the one before it left. */
const PHASES: readonly Phase[] = [
  { name: 'cold run', body: vxRun, timed: false },
  { name: 'up-to-date run', body: vxRun, timed: true },
  {
    name: 'restore run',
    setup: async (cwd, n) => {
      for (let i = 0; i < n; i++) {
        await rm(path.join(cwd, 'packages', pkg(i), 'dist'), { recursive: true, force: true })
      }
    },
    body: vxRun,
    timed: true,
  },
  {
    name: 'plan',
    body: async (cwd) => {
      await planRun(options(cwd))
    },
    timed: true,
  },
  {
    name: 'one-edit run',
    setup: async (cwd) => {
      const f = path.join(cwd, 'packages', pkg(0), 'src', 'm0.js')
      await writeFile(f, (await readFile(f, 'utf8')) + '// edit\n')
    },
    body: vxRun,
    timed: false,
  },
]

const byKey = <T>(o: Record<string, T>): Record<string, T> =>
  Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)))

/** Every phase's counts, at `n` packages. */
async function countPhases(n: number): Promise<Record<string, Counts>> {
  const cwd = await workspace(n, true)
  const out: Record<string, Counts> = {}
  try {
    for (const p of PHASES) {
      await p.setup?.(cwd, n)
      await Bun.sleep(RACY_MS)
      counts = {}
      await p.body(cwd)
      out[`${p.name} @${n}`] = byKey(counts)
    }
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
  return out
}

// A fixed CPU workload shaped like the warm path (hashing, maps, string
// building, JSON), so a slower box slows it in about the same proportion.
function calibrate(): number {
  const t = Bun.nanoseconds()
  const m = new Map<string, bigint>()
  let seed = 0n
  for (let i = 0; i < 40_000; i++) {
    const k = `packages/pkg-${i % 997}/src/m${i % 7}.js\0${i}`
    seed = Bun.hash.xxHash3(k, seed & 0xffffffffn)
    m.set(k, seed)
    if (m.size > 5000) m.clear()
  }
  JSON.parse(JSON.stringify([...m.keys()].slice(0, 2000).map((k) => ({ k, n: k.length }))))
  return (Bun.nanoseconds() - t) / 1e6
}

/**
 * Each timed phase's min wall over REPS at `n` packages, interleaved with
 * the calibration, in units of the calibration's min: this box's speed.
 */
async function timePhases(n: number): Promise<Record<string, number>> {
  const cwd = await workspace(n, false)
  const walls = new Map<string, number[]>()
  const cal: number[] = []
  try {
    for (const p of PHASES) {
      await p.setup?.(cwd, n)
      await p.body(cwd)
    }
    await vxRun(cwd)
    for (let r = 0; r < REPS; r++) {
      for (const p of PHASES.filter((q) => q.timed)) {
        await p.setup?.(cwd, n)
        cal.push(calibrate())
        const t = Bun.nanoseconds()
        await p.body(cwd)
        walls.set(p.name, [...(walls.get(p.name) ?? []), (Bun.nanoseconds() - t) / 1e6])
      }
    }
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
  const unit = Math.min(...cal)
  return Object.fromEntries([...walls].map(([k, v]) => [`${k} @${n}`, Math.min(...v) / unit]))
}

// Each measure runs in a child with a hermetic environment: vx hashes
// what it is run under (BUN_OPTIONS, a bunfig in HOME, a parent run's
// VX_ variables), so the same code counted under `vx run` and in a
// terminal differed by a hash.
async function measure<T>(what: 'counts' | 'time'): Promise<T> {
  const home = await mkdtemp(path.join(os.tmpdir(), 'vx-perf-home-'))
  try {
    const p = Bun.spawn({
      cmd: [process.execPath, import.meta.path, `--measure=${what}`],
      cwd: home,
      env: { PATH: process.env['PATH'] ?? '', HOME: home, TMPDIR: os.tmpdir(), LANG: 'C' },
      stdout: 'pipe',
      stderr: 'inherit',
    })
    const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited])
    if (code !== 0) throw new Error(`perf-guard: the ${what} measure exited ${code}`)
    return JSON.parse(out) as T
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}

/** Normalized times at LARGE. */
const timeAll = () => measure<Record<string, number>>('time')

/** Each number's best of `attempts` measures. */
async function best(attempts: number) {
  let time = await timeAll()
  for (let a = 1; a < attempts; a++) {
    const next = await timeAll()
    time = Object.fromEntries(Object.entries(time).map(([k, v]) => [k, Math.min(v, next[k]!)]))
  }
  return byKey(time)
}

// ---------------------------------------------------------------- verdict

interface Baseline {
  counts: Record<string, Counts>
  time: Record<string, number>
}

async function main(): Promise<void> {
  const counted = await measure<Record<string, Counts>>('counts')
  const platform = `${process.platform}-${process.arch}`
  const all = (await Bun.file(BASELINE)
    .json()
    .catch(() => ({}))) as Record<string, Baseline>

  if (process.argv.includes('--update')) {
    // The best of ATTEMPTS: a baseline taken on a busy moment lets a later
    // regression of that size through.
    const time = await best(ATTEMPTS)
    const rounded = Object.fromEntries(Object.entries(time).map(([k, v]) => [k, +v.toFixed(3)]))
    all[platform] = { counts: counted, time: rounded }
    await writeFile(BASELINE, JSON.stringify(byKey(all), null, 2) + '\n')
    process.stdout.write(`perf-guard: wrote ${platform} to perf-baseline.json\n`)
    return
  }

  const base = all[platform]
  if (base === undefined) {
    process.stdout.write(
      `perf-guard: no ${platform} baseline; counted only. Record one with \`vx run perf.update\`.\n${JSON.stringify(counted, null, 2)}\n`,
    )
    return
  }

  const grew: string[] = []
  const shrank: string[] = []
  const rows: string[] = []
  for (const phase of new Set([...Object.keys(base.counts), ...Object.keys(counted)])) {
    const was = base.counts[phase] ?? {}
    const now = counted[phase] ?? {}
    for (const k of new Set([...Object.keys(was), ...Object.keys(now)])) {
      const [b, n] = [was[k] ?? 0, now[k] ?? 0]
      rows.push(
        `  ${`${phase}: ${k}`.padEnd(46)} ${String(b).padStart(7)} ${String(n).padStart(7)}`,
      )
      if (n > b) grew.push(`${phase}: ${k} ${b} → ${n}`)
      if (n < b) shrank.push(`${phase}: ${k} ${b} → ${n}`)
    }
  }

  const time = await timeAll()
  for (const k of Object.keys(base.time)) {
    const ratio = time[k]! / base.time[k]!
    rows.push(
      `  ${k.padEnd(46)} ${base.time[k]!.toFixed(2).padStart(7)} ${time[k]!.toFixed(2).padStart(7)}  ${ratio.toFixed(2)}×${ratio > TIME_FLAG ? '  slower? (noisy; not held)' : ''}`,
    )
  }

  process.stdout.write(
    `perf-guard (${platform})${' '.repeat(26)} baseline     now\n${rows.join('\n')}\n`,
  )
  if (shrank.length > 0) {
    process.stdout.write(
      `\nperf-guard: ${shrank.length} fewer (passes; \`vx run @vzn/vx-bench#perf.update\` records them):\n${shrank.map((f) => `  ${f}`).join('\n')}\n`,
    )
  }
  if (grew.length > 0) {
    process.stdout.write(
      `\nperf-guard: ${grew.length} grew:\n${grew.map((f) => `  ${f}`).join('\n')}\n` +
        `The change does more work. If it is meant, run \`vx run @vzn/vx-bench#perf.update\` and commit perf-baseline.json; on a conflict there, take main's file and run it again.\n`,
    )
    process.exitCode = 1
  }
}

const mode = process.argv.find((a) => a.startsWith('--measure='))?.slice('--measure='.length)
if (mode === 'counts') {
  process.stdout.write(
    JSON.stringify({ ...(await countPhases(SMALL)), ...(await countPhases(LARGE)) }),
  )
} else if (mode === 'time') {
  process.stdout.write(JSON.stringify(await timePhases(LARGE)))
} else await main()
