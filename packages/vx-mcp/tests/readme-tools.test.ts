// The README's tool table is the one an agent's operator reads before
// wiring the server; `listTools()` is what the agent is told. One
// assertion holds the two sets equal in both directions, so a tool added
// or renamed cannot leave the table describing another server (the shape
// of the env pins, items 614 and 618).
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import { listTools } from '../src/tools.js'

describe('README documents every tool the server lists', () => {
  it('the table rows and listTools() name the same tools', () => {
    const readme = readFileSync(path.join(import.meta.dir, '..', 'README.md'), 'utf8')
    const start = readme.indexOf('## Tools')
    expect(start).toBeGreaterThan(-1)
    const documented: string[] = []
    for (const line of readme.slice(start).split('\n')) {
      const m = /^\| `([A-Za-z]+)`\s+\|/.exec(line)
      if (m !== null) documented.push(m[1]!)
      else if (line.startsWith('## ') && line !== '## Tools') break
    }
    expect(documented.sort()).toEqual(
      listTools()
        .map((t) => t.name)
        .sort(),
    )
  })
})
