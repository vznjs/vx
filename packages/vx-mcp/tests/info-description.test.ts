// getWorkspaceInfo's description is what an agent reads before calling it;
// its answer is `vx info --format json`, recorded key by key in
// tests/contract/tools.json. The description listed the facts in prose and
// had lost two the answer carries (configErrors, sandbox). It names each
// top-level key now, and this holds the two sets equal both ways.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { expect, it } from 'bun:test'
import { listTools } from '../src/tools.js'

const RECORD = JSON.parse(
  readFileSync(path.join(import.meta.dir, 'contract', 'tools.json'), 'utf8'),
) as Record<string, { answer: string[] }>

it("getWorkspaceInfo's description names exactly its answer's top-level keys", () => {
  const keys = [...new Set(RECORD['getWorkspaceInfo']!.answer.map((k) => k.split('.')[0]!))].sort()
  expect(keys.length).toBeGreaterThan(20)
  const description = listTools().find((t) => t.name === 'getWorkspaceInfo')!.description
  const words = new Set(description.match(/\b[A-Za-z][A-Za-z0-9]*\b/g) ?? [])
  expect(keys.filter((k) => !words.has(k))).toEqual([])
  // A camelCase or digit-bearing word is a key name, so it must be one.
  const named = [...words].filter((w) => /[A-Z0-9]/.test(w.slice(1)))
  expect(named.filter((w) => !keys.includes(w))).toEqual([])
})
