// The dealing behind tests/helpers/shard.ts, factored out so it can be
// pinned over a synthetic directory: a `// @vx-shard-cost <s>` hint beats
// file size, `// @vx-shard-isolate` marks a file for a process of its own,
// and longest-first greedy (LPT) puts every file in exactly one shard.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

export interface TestFile {
  /** `./tests/<name>` — the form `bun test` is handed. */
  rel: string
  cost: number
  isolate: boolean
}

export function describeTestFile(dir: string, file: string): TestFile {
  const head = readFileSync(path.join(dir, file), 'utf8').slice(0, 2000)
  const hint = /^\/\/ @vx-shard-cost (\d+(?:\.\d+)?)\b/m.exec(head)
  return {
    rel: `./tests/${file}`,
    cost: hint !== null ? Number(hint[1]) : statSync(path.join(dir, file)).size / 10_000,
    isolate: /^\/\/ @vx-shard-isolate\b/m.test(head),
  }
}

/** Every `*.test.ts` in `dir`, dealt longest-first into `shards` buckets. */
export function dealShards(dir: string, shards: number): TestFile[][] {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.test.ts'))
    .map((f) => describeTestFile(dir, f))
    .sort((a, b) => b.cost - a.cost || (a.rel < b.rel ? -1 : 1))
  const load: number[] = Array.from({ length: shards }, () => 0)
  const buckets: TestFile[][] = Array.from({ length: shards }, () => [])
  for (const file of files) {
    let lightest = 0
    for (let i = 1; i < shards; i++) if (load[i]! < load[lightest]!) lightest = i
    load[lightest]! += file.cost
    buckets[lightest]!.push(file)
  }
  return buckets
}

/**
 * The `bun test` invocations for one shard: one process for the shared
 * files, one per isolated file. Every group runs even after a failure so a
 * red shard reports every failing test, not the first group's.
 */
export function shardGroups(shard: readonly TestFile[]): string[][] {
  const groups: string[][] = []
  const shared = shard.filter((f) => !f.isolate).map((f) => f.rel)
  if (shared.length > 0) groups.push(shared)
  for (const f of shard) if (f.isolate) groups.push([f.rel])
  return groups
}
