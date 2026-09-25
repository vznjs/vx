// `DISPATCHED_VERBS` is what the workspace schema refuses a plugin verb for
// naming: a word the dispatcher matches first would never reach the plugin.
// The source of truth is the dispatcher itself, so the list is read against
// its `case` labels in both directions — a verb the switch matches and the
// list lacks is a plugin verb that loads and sits dead (dropping
// `completions`, `help` or `stats` from the list survived every other row).

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { expect, it } from 'bun:test'
import { DISPATCHED_VERBS } from '../src/util/index.js'

it('the verbs a plugin may not declare are exactly the words the dispatcher matches', () => {
  const src = readFileSync(path.join(import.meta.dir, '..', 'src', 'cli', 'index.ts'), 'utf8')
  const labels = [...src.matchAll(/^\s*case '([^']+)':/gm)].map((m) => m[1]!)
  const words = labels.filter((l) => !l.startsWith('-'))
  expect(words.length).toBeGreaterThan(10)
  expect([...DISPATCHED_VERBS].sort()).toEqual([...words].sort())
})
