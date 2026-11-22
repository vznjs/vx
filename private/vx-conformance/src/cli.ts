#!/usr/bin/env bun
// Runs every case against every tool and writes the results the site's
// conformance page renders.
//
//   bun src/cli.ts                       all tools, all cases → the site's data
//   bun src/cli.ts --tool vx,turbo       some tools
//   bun src/cli.ts --case inputs/,cache/ cases whose id starts with one of those
//   bun src/cli.ts --jobs 8              cases at once (default: CPU count)
//   bun src/cli.ts --out file.json       where the results go
//   bun src/cli.ts --shard 2/3           every third case, from the second (one CI job's part)
//   bun src/cli.ts --verbose             print each failed run's output
//   bun src/merge.ts out.json a.json b.json  shards' results → one
import os from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { CASES } from '../cases/index.ts'
import { ADAPTERS } from './adapters/index.ts'
import { runCase, type Outcome } from './harness.ts'
import {
  coverage,
  harnessNotes,
  ref,
  scores,
  scoreTable,
  toolVersion,
  vxFailures,
  type Results,
} from './report.ts'
import { sandboxAvailable } from './sandbox.ts'
import { fetchMoonPlugins } from './adapters/moon.ts'
import { installLatest, LATEST } from './tools.ts'

const { values } = parseArgs({
  options: {
    tool: { type: 'string' },
    case: { type: 'string' },
    jobs: { type: 'string' },
    out: { type: 'string' },
    shard: { type: 'string' },
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
const prefixes = values.case?.split(',') ?? ['']
const [part, parts] = (values.shard ?? '1/1').split('/').map(Number) as [number, number]
// Dealt in turn, so each shard gets its share of the slow kinds (watch, timeouts).
const cases = CASES.filter((c) => prefixes.some((p) => c.id.startsWith(p))).filter(
  (_, i) => i % parts === part - 1,
)
const jobs = Number(values.jobs ?? os.availableParallelism())
const out =
  values.out ?? path.join(import.meta.dir, '..', '..', 'vx-docs', 'src', 'data', 'conformance.json')

await installLatest(tools.flatMap((t) => (t.pkg && LATEST.includes(t.pkg) ? [t.pkg] : [])))
if (tools.some((t) => t.name === 'moon')) await fetchMoonPlugins()

const work = tools.flatMap((t) => cases.map((c) => ({ t, c })))
const outcomes = new Map<string, Outcome>()
let next = 0
let done = 0
/** Each tool's first failed run, its log kept: a sample, should the tool fail most cases. */
const firstFail = new Map<string, Outcome>()
await Promise.all(
  Array.from({ length: Math.min(jobs, work.length) }, async () => {
    while (next < work.length) {
      const { t, c } = work[next++]!
      const o = await runCase(c, t).catch((err: unknown): Outcome => ({
        status: 'fail',
        detail: `harness: ${String(err)}`,
      }))
      outcomes.set(`${t.name}\0${c.id}`, o)
      if (o.status === 'fail' && o.log && !firstFail.has(t.name)) firstFail.set(t.name, { ...o })
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
// A tool failing most cases is more often the harness's setup than the tool:
// the results say how one run failed, for a CI job whose output is gone.
for (const t of tools) {
  const fails = cases.filter((c) => outcomes.get(`${t.name}\0${c.id}`)?.status === 'fail')
  const sample = firstFail.get(t.name)
  if (fails.length * 2 > cases.length && sample?.log)
    harnessNotes.push(
      `${t.name} failed ${fails.length} of ${cases.length} cases; one: ${sample.detail}\n${sample.log.slice(-2000)}`,
    )
}

const outcomeOf = (tool: string, id: string) => outcomes.get(`${tool}\0${id}`)!

const rows = cases.map((c) => ({
  id: c.id,
  ref: ref(c.id),
  category: c.category,
  kind: c.kind,
  title: c.title,
  why: c.why,
  from: c.from,
  outcomes: Object.fromEntries(tools.map((t) => [t.name, outcomeOf(t.name, c.id)])),
}))
const results: Results = {
  coverage: coverage(cases),
  ...(harnessNotes.length > 0 ? { notes: harnessNotes } : {}),
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
if ((values.tool || values.case || values.shard) && !values.out) process.exit(0)
await Bun.write(out, JSON.stringify(results, null, 2) + '\n')
// The site keeps vx's committed column (vx-docs scripts/live-conformance.ts):
// a case vx fails is a vx bug to fix, and the weekly run goes red on it.
if (vxFailures(rows)) process.exit(1)
