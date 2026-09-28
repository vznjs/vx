// `schemas/history.json` names each object's keys; these rows hold them to
// the source types, so a field added to `HistoryRow` fails here until the
// schema says it. Core's `tests/plugin-json-schemas.unsafe.test.ts` holds
// the printed output to the schema.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { expect, it } from 'bun:test'
import type { HistoryRow } from '../src/history-view.js'
import type { Budgets, ResourceEstimate } from '../src/index.js'

const schema = JSON.parse(
  readFileSync(path.resolve(import.meta.dir, '..', 'schemas', 'history.json'), 'utf8'),
) as Record<string, unknown>

/** The keys of T, all of them and no others: the compiler holds the literal. */
function keys<T>(k: Record<keyof T, true>): string[] {
  return Object.keys(k).sort()
}

function props(...route: string[]): string[] {
  let node = schema
  for (const step of route) node = node[step] as Record<string, unknown>
  return Object.keys(node['properties'] as object).sort()
}

it('each object in schemas/history.json is its source type', () => {
  expect(props('properties', 'budgets')).toEqual(keys<Budgets>({ cpus: true, memory: true }))
  expect(props('properties', 'tasks', 'items')).toEqual(
    keys<HistoryRow>({
      id: true,
      runs: true,
      p50DurationMs: true,
      maxPeakRssBytes: true,
      maxCpuParallelism: true,
      reservation: true,
      declared: true,
    }),
  )
  expect(props('properties', 'tasks', 'items', 'properties', 'reservation')).toEqual(
    keys<ResourceEstimate>({ cpus: true, memory: true }),
  )
})
