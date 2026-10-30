// No benchmark figure on the site is typed by hand (2026-10-29): the
// head-to-head's numbers are measured by @vzn/vx-bench's `bench.*` tasks,
// gathered into private/vx-docs/src/data/bench.json, and every page names
// them with a `%bench.…%` token the build fills. A hand-typed figure goes
// stale on the next change to vx, as the 2026-09 tables on the benchmarks
// page did for a month.
//
// It reads the content collection, the imported benchmarks page included,
// and the built site, so the `test` task's `import` and `build` come first.
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import { RUNNERS, TOKEN, figures, type BenchData, type RunnerResult } from '../src/bench/format.ts'
import { FIGURES } from '../src/bench/data.ts'
import docs from '../vx.config.ts'

const site = path.resolve(import.meta.dir, '..')
const content = path.join(site, 'src', 'content', 'docs')

/** Every page the site renders, the ones imported from packages/vx/docs included. */
function pages(): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (/\.mdx?$/.test(e.name)) out.push(p)
    }
  }
  walk(content)
  return out
}

// A duration as the pages print one: `799 ms`, `24.15 s`, `3 min 6 s`, `1m 4s`.
const FIGURE = /\d[\d,.]*\s?(?:ms|s|min)\b/
const ROW_LABELS = new Set([
  'Nothing changed',
  'Nothing changed, outputs restored',
  'Cold build',
  'Cold build: CPU the runner burns',
])
const TOOLS = new Set(['vx', 'Turborepo', 'Nx', 'Vite Task'])
const cellsOf = (line: string): string[] =>
  line
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((c) => c.trim().replace(/\*\*/g, ''))

describe('no benchmark figure on the site is typed by hand', () => {
  it('every head-to-head table cell is a token', () => {
    const typed: string[] = []
    let rows = 0
    for (const file of pages()) {
      const lines = readFileSync(file, 'utf8').split('\n')
      // A head-to-head table is headed by the ideal run, by the task count,
      // or by nothing, with its four rows; or, transposed, it has a column
      // per row. A real repo's run (`| Run | vx | Nx |`) is its own
      // measurement, dated where it is printed.
      let header: string[] | undefined
      for (const line of lines) {
        if (!line.startsWith('|')) {
          header = undefined
          continue
        }
        const cells = cellsOf(line)
        if (header === undefined) {
          header = cells
          continue
        }
        const first = header[0]!
        const headed = first === '' || /ideal run|%bench.tasks%/.test(first)
        const transposed = header.some((c) => ROW_LABELS.has(c) || c === 'Cold build overhead')
        const isRow = (headed && ROW_LABELS.has(cells[0]!)) || (transposed && TOOLS.has(cells[0]!))
        if (!isRow || /^\|\s*-/.test(line)) continue
        rows += 1
        for (const cell of cells.slice(1))
          if (FIGURE.test(cell.replace(TOKEN, '')))
            typed.push(`${path.relative(site, file)}: ${cells[0]} | ${cell}`)
      }
    }
    // The benchmarks page, the two compare pages and four posts carry one.
    expect(rows).toBeGreaterThanOrEqual(25)
    expect(typed).toEqual([])
  })

  it('no sentence says what a tool adds with a figure typed by hand', () => {
    const typed: string[] = []
    for (const file of pages()) {
      const text = readFileSync(file, 'utf8')
      for (const para of text.split(/\n\s*\n/)) {
        const flat = para.replace(/\s+/g, ' ').replace(TOKEN, 'TOKEN')
        for (const m of flat.matchAll(
          /\b(?:vx|Turborepo|Nx|Vite Task)(?:'s)? (?:adds|finishes in|takes) (\d[\d,.]*\s?(?:ms|s|min)\b)/g,
        ))
          typed.push(`${path.relative(site, file)}: ${m[0]}`)
      }
    }
    expect(typed).toEqual([])
  })

  it('the landing chart and the feature pages read the measured data', () => {
    const landing = readFileSync(path.join(site, 'src', 'pages', 'index.astro'), 'utf8')
    expect(landing).toContain("from '../bench/data.ts'")
    const block = landing.slice(
      landing.indexOf('const benchTable'),
      landing.indexOf('const benchBars'),
    )
    expect(block.length).toBeGreaterThan(0)
    expect(block.match(/['`]\d[\d,.]*\s?(?:ms|s|min)\b/g)).toBeNull()
    const features = readFileSync(path.join(site, 'src', 'features', 'features.ts'), 'utf8')
    const claims = features.split('\n').filter((l) => /over the ideal run/.test(l))
    expect(claims.length).toBeGreaterThan(0)
    expect(claims.filter((l) => FIGURE.test(l.replace(TOKEN, '')))).toEqual([])
  })

  it('every token a page names is one the data fills', () => {
    const run = (runner: string): RunnerResult => ({
      date: '2026-10-29T00:00:00.000Z',
      machine: { os: 'linux x64', cores: 4, cpu: 'cpu', memoryGb: 16 },
      reps: 3,
      coldReps: 1,
      row: {
        runner,
        version: '1.0.0',
        fresh: 2,
        warmNoRestore: 1,
        warmRestore: 1,
        freshCpu: 2,
        warmNoRestoreCpu: 1,
        warmRestoreCpu: 1,
      },
      baseline: {
        fresh: 1,
        warmNoRestore: 0,
        warmRestore: 0,
        freshCpu: 1,
        criticalPathMs: 1,
        workBoundMs: 1,
      },
    })
    const data: BenchData = {
      shape: 'levels-2026-10',
      packages: 1,
      tasks: 1,
      levels: 1,
      buildMs: 300,
      concurrency: 10,
      runners: Object.fromEntries(RUNNERS.map((r) => [r, run(r)])) as BenchData['runners'],
    }
    const known = figures(data)
    const sources = [
      ...pages(),
      path.join(site, 'src', 'pages', 'index.astro'),
      path.join(site, 'src', 'features', 'features.ts'),
    ]
    const used = new Set<string>()
    const unknown: string[] = []
    for (const file of sources)
      for (const m of readFileSync(file, 'utf8').matchAll(TOKEN)) {
        used.add(m[1]!)
        if (!known.has(m[1]!)) unknown.push(`${path.relative(site, file)}: ${m[0]}`)
      }
    expect(unknown).toEqual([])
    expect(used.size).toBeGreaterThan(20)
  })

  it('the built site fills every token', () => {
    const dist = path.join(site, 'dist')
    const left: string[] = []
    let pages = 0
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name)
        if (e.isDirectory()) walk(p)
        else if (/\.(?:html|md|txt|xml)$/.test(e.name)) {
          pages += 1
          for (const m of readFileSync(p, 'utf8').matchAll(TOKEN))
            left.push(`${path.relative(dist, p)}: ${m[0]}`)
        }
      }
    }
    walk(dist)
    expect(pages).toBeGreaterThan(100)
    expect(left).toEqual([])
    const page = readFileSync(path.join(dist, 'benchmarks', 'index.html'), 'utf8')
    expect(page).toContain(`<span class="vx-bar-value">${FIGURES.get('vx.warm')}</span>`)
  })

  it('a site with no bench.json fails to build', () => {
    // The data is a static import: with the file absent the module, and so
    // every page and the Markdown plugin that load it, does not resolve.
    const dir = mkdtempSync(path.join(os.tmpdir(), 'vx-bench-data-'))
    try {
      cpSync(path.join(site, 'src', 'bench'), path.join(dir, 'bench'), { recursive: true })
      const r = Bun.spawnSync([process.execPath, path.join(dir, 'bench', 'data.ts')], {
        stdout: 'pipe',
        stderr: 'pipe',
      })
      expect(r.exitCode).not.toBe(0)
      expect(r.stderr.toString()).toContain('bench.json')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
    const config = readFileSync(path.join(site, 'astro.config.mjs'), 'utf8')
    expect(config).toContain('mdastPlugins: [bench, mermaid, dataCharts]')
    const tasks = readFileSync(path.join(site, 'vx.config.ts'), 'utf8')
    expect(tasks).toContain("dependsOn: ['install', '@vzn/vx-bench#site.numbers'],")
  })

  // A benchmark times its machine, so it runs only in CI's Bench job, one
  // runner at a time on a machine of its own. A build that depended on
  // the rows ran all four on a fresh clone's `vx run build --all`
  // (check.build-cold, main 7813301) and on DTE workers.
  it('no task but bench.data depends on the benchmarks', () => {
    const tasks = docs.tasks as Record<string, { dependsOn?: readonly string[] }>
    const pulling = Object.entries(tasks)
      .filter(([name]) => name !== 'bench.data')
      .filter(([, t]) =>
        (t.dependsOn ?? []).some((d) => d === 'bench.data' || d.startsWith('@vzn/vx-bench#')),
      )
      .map(([name]) => name)
    expect(pulling).toEqual([])
  })
})
