// The site's benchmark data (2026-10-29: no figure on the site is typed by
// hand). Gathers the head-to-head rows each `@vzn/vx-bench#bench.<runner>`
// task wrote into measured/bench.json. Its committed copy,
// src/data/bench.json, is the one file every page reads (src/bench/data.ts).
// A runner missing, or measured on another shape, fails the task.
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { RUNNERS, type BenchData, type RunnerResult } from '../src/bench/format.ts'

const SITE = path.resolve(import.meta.dir, '../../vx-bench/site')
const OUT = path.resolve(import.meta.dir, '../measured/bench.json')

type RunFile = Omit<RunnerResult, 'row'> & {
  shape: string
  packages: number
  tasks: number
  levels: number
  buildMs: number
  concurrency: number
  rows: RunnerResult['row'][]
}

const files: Record<string, RunFile> = {}
for (const runner of RUNNERS) {
  const file = path.join(SITE, `${runner}.json`)
  const text = await readFile(file, 'utf8').catch(() => {
    throw new Error(`${file} is missing: run @vzn/vx-bench#bench.${runner}`)
  })
  files[runner] = JSON.parse(text) as RunFile
}
const first = files[RUNNERS[0]]!
for (const runner of RUNNERS) {
  const f = files[runner]!
  for (const k of ['shape', 'tasks', 'concurrency', 'buildMs'] as const)
    if (f[k] !== first[k]) throw new Error(`${runner}.json: ${k} ${f[k]}, vx.json ${first[k]}`)
  if (f.rows.length !== 1 || f.rows[0]!.runner !== runner)
    throw new Error(`${runner}.json: expected the one row of ${runner}`)
}
const data: BenchData = {
  shape: first.shape,
  packages: first.packages,
  tasks: first.tasks,
  levels: first.levels,
  buildMs: first.buildMs,
  concurrency: first.concurrency,
  runners: Object.fromEntries(
    RUNNERS.map((runner) => {
      const { date, machine, reps, coldReps, baseline, rows } = files[runner]!
      return [runner, { date, machine, reps, coldReps, baseline, row: rows[0]! }]
    }),
  ) as BenchData['runners'],
}
await mkdir(path.dirname(OUT), { recursive: true })
await writeFile(OUT, JSON.stringify(data, null, 2) + '\n')
console.log(`bench data → ${path.relative(process.cwd(), OUT)}`)
