// A bare --affected compares with the merge base with `origin/<baseBranch>`
// and has no default on that branch (owner, 2026-10-17). The pages that
// state the default name it, and the fallback branches affected.ts tries,
// read from its list; none still falls back to HEAD~1.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'

const ROOT = path.resolve(import.meta.dir, '..')
const read = (rel: string): string => readFileSync(path.join(ROOT, rel), 'utf8')

const FALLBACKS = JSON.parse(
  /configured === undefined \? (\[[^\]]*\])/
    .exec(read('src/workspace/affected.ts'))![1]!
    .replaceAll("'", '"'),
) as string[]

const flat = (rel: string): string => read(rel).split(/\s+/).join(' ')

describe('every page stating the bare --affected base names the base branch', () => {
  it.each(['docs/modules/cli-run.md', 'docs/modules/affected.md', 'docs/schema.md'])(
    '%s',
    (rel) => {
      const text = flat(rel)
      expect({
        branch: text.includes('origin/<baseBranch>'),
        guess: /(then|else|falls back to) `?HEAD~1/.test(text),
      }).toEqual({ branch: true, guess: false })
    },
  )

  it.each(['docs/modules/affected.md', 'docs/schema.md'])('%s names the fallbacks', (rel) => {
    const text = flat(rel)
    expect(FALLBACKS.filter((b) => !text.includes(`\`${b}\``))).toEqual([])
  })
})
