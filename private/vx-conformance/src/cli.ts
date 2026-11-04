#!/usr/bin/env bun
// Runs every case against every tool and writes the report.
//
//   bun src/cli.ts                       all tools, all cases → report/
//   bun src/cli.ts --tool vx,turbo       some tools
//   bun src/cli.ts --case inputs/        cases whose id starts with that
//   bun src/cli.ts --jobs 8              cases at once (default: CPU count)
//   bun src/cli.ts --out dir             where results.json and REPORT.md go
//   bun src/cli.ts --verbose             print each failed run's output
//   bun src/cli.ts --check vx            run one tool, compare with the committed
//                                        report, write nothing; exit 1 on any change
import os from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { CASES } from '../cases/index.ts'
import { ADAPTERS } from './adapters/index.ts'
import { runCase, type Outcome } from './harness.ts'
import { coverage, renderReport, toolVersion, type Results } from './report.ts'
import { sandboxAvailable } from './sandbox.ts'

const { values } = parseArgs({
  options: {
    tool: { type: 'string' },
    case: { type: 'string' },
    jobs: { type: 'string' },
    out: { type: 'string' },
    check: { type: 'string' },
    verbose: { type: 'boolean' },
  },
})

if (!sandboxAvailable()) {
  console.error('conformance: bwrap (bubblewrap) is required; every tool runs sandboxed')
  process.exit(2)
}

const only = values.check ?? values.tool
const tools = only ? ADAPTERS.filter((a) => only.split(',').includes(a.name)) : ADAPTERS
const cases = CASES.filter((c) => !values.case || c.id.startsWith(values.case))
const jobs = Number(values.jobs ?? os.availableParallelism())
const outDir = values.out ?? path.join(import.meta.dir, '..', 'report')

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

if (values.check !== undefined) {
  // A tool's outcomes are pinned by the committed report: a case that
  // passed and now fails is a regression, and one that now passes moves
  // the score, so the report is refreshed in the same change.
  const committed: Results = await Bun.file(path.join(outDir, 'results.json')).json()
  const changed = tools.flatMap((t) =>
    cases.flatMap((c) => {
      const was = committed.cases.find((r) => r.id === c.id)?.outcomes[t.name]?.status ?? 'absent'
      const now = outcomeOf(t.name, c.id)
      return was === now.status
        ? []
        : [`${t.name} ${c.id}: ${was} → ${now.status}${now.detail ? ` (${now.detail})` : ''}`]
    }),
  )
  if (changed.length > 0) {
    console.error(
      `conformance: ${changed.length} outcome(s) differ from report/results.json:\n${changed.join('\n')}`,
    )
    console.error(
      'A regression is fixed in the tool; a new pass or case is recorded with `bun src/cli.ts`.',
    )
    process.exit(1)
  }
  console.log(
    `conformance: ${cases.length} cases, every ${tools.map((t) => t.name).join(', ')} outcome as recorded`,
  )
  process.exit(0)
}

const results: Results = {
  coverage: coverage(cases),
  tools: Object.fromEntries(
    await Promise.all(tools.map(async (t) => [t.name, await toolVersion(t)] as const)),
  ),
  cases: cases.map((c) => ({
    id: c.id,
    category: c.category,
    kind: c.kind,
    title: c.title,
    ...(c.why ? { why: c.why } : {}),
    from: c.from,
    outcomes: Object.fromEntries(tools.map((t) => [t.name, outcomeOf(t.name, c.id)])),
  })),
}
// A partial run never replaces the committed report.
if ((values.tool || values.case) && !values.out) {
  console.log(renderReport(results).split('\n## ')[0])
  process.exit(0)
}
await Bun.write(path.join(outDir, 'results.json'), JSON.stringify(results, null, 2) + '\n')
await Bun.write(path.join(outDir, 'REPORT.md'), renderReport(results))
console.log(renderReport(results).split('\n## ')[0])
