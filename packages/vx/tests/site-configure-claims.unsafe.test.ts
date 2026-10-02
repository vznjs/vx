// The configure guide's `vx why` verdict table and its `affectedBase`
// default, held to the source that prints and decides them. The table
// lacked the --continue verdict, and the default omitted the trunk
// fallback #2122 added.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'

const SRC = path.resolve(import.meta.dir, '..', 'src')
const PAGE = readFileSync(
  path.resolve(import.meta.dir, '../../vx-docs/src/content/docs/guides/configure.md'),
  'utf8',
)

describe('the configure guide', () => {
  it('lists every "cache key unchanged" verdict vx why prints', () => {
    const metrics = readFileSync(path.join(SRC, 'orchestrator', 'metrics.ts'), 'utf8')
    const verdicts = [...metrics.matchAll(/return [`'](cache key unchanged — [^`'$]*)/g)].map(
      (m) => m[1]!,
    )
    expect(verdicts.length).toBeGreaterThanOrEqual(7)
    expect(verdicts.filter((v) => !PAGE.includes(v))).toEqual([])
  })

  it('names the trunk fallback of a bare --affected', () => {
    const affected = readFileSync(path.join(SRC, 'workspace', 'affected.ts'), 'utf8')
    const trunks = JSON.parse(
      /const TRUNKS = (\[[^\]]*\])/.exec(affected)![1]!.replaceAll("'", '"'),
    ) as string[]
    const row = PAGE.split('\n').find((l) => l.startsWith('| `affectedBase`'))!
    expect(trunks.filter((t) => !row.includes(`\`${t}\``))).toEqual([])
    expect(row).toContain('`HEAD~1`')
  })
})
