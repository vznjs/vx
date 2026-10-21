// Every property a config can set (each `*Options` and `AgentSize` the
// package exports) says what it is in its own JSDoc: an editor shows it as
// the user types.

import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { expect, it } from 'bun:test'

const SRC = path.join(import.meta.dir, '..', 'src')
const PUBLIC = readFileSync(path.join(SRC, 'index.ts'), 'utf8')
const config = (name: string): boolean => new RegExp(`\\btype ${name}\\b`).test(PUBLIC)

/** `Interface.prop` for each property of a config interface with no `/** … *\/` right above it. */
function undocumented(file: string): string[] {
  const text = readFileSync(path.join(SRC, file), 'utf8')
  const out: string[] = []
  for (const m of text.matchAll(
    /export interface (\w+(?:Options)|AgentSize) \{\n([\s\S]*?)\n\}/g,
  )) {
    if (!config(m[1]!)) continue
    const lines = m[2]!.split('\n')
    lines.forEach((line, i) => {
      const prop = /^ {2}readonly (\w+)\??:/.exec(line)?.[1]
      if (prop !== undefined && !/\*\/\s*$/.test(lines[i - 1] ?? '')) out.push(`${m[1]}.${prop}`)
    })
  }
  return out
}

it('documents every config property', () => {
  const files = readdirSync(SRC).filter((f) => f.endsWith('.ts'))
  const seen = files.flatMap((f) =>
    [
      ...readFileSync(path.join(SRC, f), 'utf8').matchAll(
        /export interface (\w+Options|AgentSize) \{/g,
      ),
    ]
      .map((m) => m[1]!)
      .filter(config),
  )
  expect(seen.toSorted()).toEqual([
    'AgentSize',
    'DockerOptions',
    'DteOptions',
    'GithubOptions',
    'GitlabOptions',
    'LocalOptions',
  ])
  expect(files.flatMap(undocumented)).toEqual([])
})
