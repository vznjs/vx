// A bare --affected falls back from origin/HEAD to a trunk branch before
// HEAD~1 (D-93). cli-run.md and affected.md's test list still said
// origin/HEAD, then HEAD~1. Each page that states the fallback names every
// trunk affected.ts tries, read from its list.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'

const ROOT = path.resolve(import.meta.dir, '..')
const read = (rel: string): string => readFileSync(path.join(ROOT, rel), 'utf8')

const TRUNKS = JSON.parse(
  /const TRUNKS = (\[[^\]]*\])/.exec(read('src/workspace/affected.ts'))![1]!.replaceAll("'", '"'),
) as string[]

/** The paragraphs and list items that state where a bare base falls back. */
function fallbackBlocks(rel: string): string[] {
  return read(rel)
    .split(/\n\s*\n|\n(?=\s*(?:[-*]|\d+\.) )/)
    .map((b) => b.split(/\s+/).join(' '))
    .filter((b) => b.includes('origin/HEAD') && b.includes('HEAD~1'))
}

describe('every page stating the bare --affected base names the trunks', () => {
  it.each(['docs/modules/cli-run.md', 'docs/modules/affected.md', 'docs/schema.md'])(
    '%s',
    (rel) => {
      const blocks = fallbackBlocks(rel)
      expect(blocks.length).toBeGreaterThan(0)
      const missing = blocks.flatMap((b) =>
        /trunk/.test(b) ? [] : TRUNKS.filter((t) => !b.includes(`\`${t}\``)),
      )
      expect(missing).toEqual([])
    },
  )
})
