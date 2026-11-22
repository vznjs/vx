#!/usr/bin/env bun
// Joins the results of a sharded run (`cli.ts --shard`, one per CI job)
// into the one file the site reads.
//
//   bun src/merge.ts out.json shard-1.json shard-2.json ...
import { CASES } from '../cases/index.ts'
import { mergeResults, scoreTable, vxFailures, type Results } from './report.ts'

const [out, ...shards] = process.argv.slice(2)
if (out === undefined || shards.length === 0) {
  console.error('usage: bun src/merge.ts out.json shard.json...')
  process.exit(2)
}
const parts = await Promise.all(shards.map((f) => Bun.file(f).json() as Promise<Results>))
const results = mergeResults(
  parts,
  CASES.map((c) => c.id),
)
for (const n of results.notes ?? []) console.error(`conformance: ${n}`)
console.log(scoreTable(results))
await Bun.write(out, JSON.stringify(results, null, 2) + '\n')
if (vxFailures(results.cases)) process.exit(1)
