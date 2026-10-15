// `npx skills add vznjs/vx` installs the vx skill alone (owner, 2026-10-15).
// The skills CLI looks in the root, `skills/` and each `<dir>/skills/` at the
// root (`.claude/skills/` among them), three levels deep, and offers every
// SKILL.md it finds there unless its frontmatter sets `metadata.internal`.
// The repo's own skills (.claude/skills) are internal; the vx skill sits at
// `skills/vx`, so the short command offers it and nothing else.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { expect, it } from 'bun:test'

const ROOT = path.resolve(import.meta.dir, '..', '..', '..')

function skillFiles(dir: string, depth: number): string[] {
  if (!existsSync(dir)) return []
  const own = path.join(dir, 'SKILL.md')
  if (existsSync(own)) return [own]
  if (depth === 0) return []
  return readdirSync(dir)
    .map((n) => path.join(dir, n))
    .filter((p) => statSync(p).isDirectory())
    .flatMap((p) => skillFiles(p, depth - 1))
}

it('npx skills add vznjs/vx offers only the vx skill', () => {
  const containers = [
    path.join(ROOT, 'skills'),
    ...readdirSync(ROOT)
      .filter((n) => n !== 'node_modules' && n !== 'skills')
      .map((n) => path.join(ROOT, n, 'skills')),
  ]
  expect(existsSync(path.join(ROOT, 'SKILL.md'))).toBe(false)
  const offered = containers
    .flatMap((c) => skillFiles(c, 3))
    .filter((f) => {
      const front = /^---\n([\s\S]*?)\n---\n/.exec(readFileSync(f, 'utf8'))?.[1] ?? ''
      return !/^metadata:\n(?: {2}.*\n)*? {2}internal: true$/m.test(front)
    })
    .map((f) => path.relative(ROOT, f))
  expect(offered).toEqual(['skills/vx/SKILL.md'])
})
