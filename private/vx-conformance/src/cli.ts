#!/usr/bin/env bun
// Runs every case against every tool and writes the results the site's
// conformance page renders.
//
//   bun src/cli.ts                       all tools, all cases → the site's data
//   bun src/cli.ts --tool vx,turbo       some tools
//   bun src/cli.ts --case inputs/        cases whose id starts with that
//   bun src/cli.ts --jobs 8              cases at once (default: CPU count)
//   bun src/cli.ts --out file.json       where the results go
//   bun src/cli.ts --verbose             print each failed run's output
import os from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { CASES } from '../cases/index.ts'
import { ADAPTERS } from './adapters/index.ts'
import { runCase, type Outcome } from './harness.ts'
import { coverage, scores, scoreTable, toolVersion, type Results } from './report.ts'
import { sandboxAvailable } from './sandbox.ts'

const { values } = parseArgs({
  options: {
    tool: { type: 'string' },
    case: { type: 'string' },
    jobs: { type: 'string' },
    out: { type: 'string' },
    verbose: { type: 'boolean' },
  },
})

if (!sandboxAvailable()) {
  console.error('conformance: bwrap (bubblewrap) is required; every tool runs sandboxed')
  process.exit(2)
}

const tools = values.tool
  ? ADAPTERS.filter((a) => values.tool!.split(',').includes(a.name))
  : ADAPTERS
const cases = CASES.filter((c) => !values.case || c.id.startsWith(values.case))
const jobs = Number(values.jobs ?? os.availableParallelism())
const out =
  values.out ?? path.join(import.meta.dir, '..', '..', 'vx-docs', 'src', 'data', 'conformance.json')

const work = tools.flatMap((t) => cases.map((c) => ({ t, c })))
const outcomes = new Map<string, Outcome>()
let next = 0
let done = 0
await Promise.all(
  Array.from({ length: Math.min(jobs, work.length) }, async () => {
    while (next < work.length) {
      const { t, c } = work[next++]!
      const o = await runCase(c, t).catch((err: unknown): Outcome => ({
        status: 'fail',
        detail: `harness: ${String(err)}`,
      }))
      outcomes.set(`${t.name}\0${c.id}`, o)
      done++
      if (o.status === 'fail')
        console.error(
          `✗ ${t.name} ${c.id}: ${o.detail}${values.verbose && o.log ? `\n${o.log}` : ''}`,
        )
      delete o.log
      process.stderr.write(`\r${done}/${work.length}`)
    }
  }),
)
process.stderr.write('\n')

const outcomeOf = (tool: string, id: string) => outcomes.get(`${tool}\0${id}`)!

const rows = cases.map((c) => ({
  id: c.id,
  category: c.category,
  kind: c.kind,
  title: c.title,
  why: c.why,
  from: c.from,
  outcomes: Object.fromEntries(tools.map((t) => [t.name, outcomeOf(t.name, c.id)])),
}))
const results: Results = {
  coverage: coverage(cases),
  tools: Object.fromEntries(
    await Promise.all(tools.map(async (t) => [t.name, await toolVersion(t)] as const)),
  ),
  scores: scores(
    tools.map((t) => t.name),
    rows,
  ),
  cases: rows,
}
console.log(scoreTable(results))
// A partial run never replaces the site's results.
if ((values.tool || values.case) && !values.out) process.exit(0)
await Bun.write(out, JSON.stringify(results, null, 2) + '\n')
