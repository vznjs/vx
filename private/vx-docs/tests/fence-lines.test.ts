// A closing fence with prose after it is no closing fence: the block runs
// on into the paragraph, and a mermaid block hands that prose to the parser.
// The v0.0.652 post's retry diagram showed mermaid's parse error that way
// (2026-11-22). Every fence line on every page is the marker alone, or an
// opening marker with its language and options.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { expect, it } from 'bun:test'

const CONTENT = path.resolve(import.meta.dir, '../src/content/docs')

const pages = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const abs = path.join(dir, f)
    return statSync(abs).isDirectory() ? pages(abs) : /\.mdx?$/.test(f) ? [abs] : []
  })

/** Each fence line that closes a block but carries more than its marker. */
function strayFences(text: string): number[] {
  const out: number[] = []
  let open: string | undefined
  text.split('\n').forEach((line, i) => {
    const m = /^\s*(`{3,}|~{3,})(.*)$/.exec(line)
    if (m === null) return
    if (open === undefined) open = m[1]
    else if (m[1]!.startsWith(open)) {
      if (m[2]!.trim() !== '') out.push(i + 1)
      open = undefined
    }
  })
  return out
}

it('no closing fence carries prose', () => {
  const bad = pages(CONTENT).flatMap((p) =>
    strayFences(readFileSync(p, 'utf8')).map((n) => `${path.relative(CONTENT, p)}:${n}`),
  )
  expect(bad).toEqual([])
})

// CONTROL: the check sees the v0.0.652 shape.
it('catches what it is for', () => {
  expect(strayFences('```mermaid\nflowchart LR\n``` `retries` on a task\n')).toEqual([3])
  expect(strayFences('```ts\nx\n```\n')).toEqual([])
})
