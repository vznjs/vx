// A package README is read by someone choosing a plugin, not by someone who
// knows core's design: `seam`, `floor`, `fold` and `staged` are core's own
// words for its pipeline and keys, and READMEs had grown dozens of them
// ("the key folded", "core's migration seam", "the floor"). Prose only: a
// code span or a fenced block may name an API (`foldScriptHooks`).
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { expect, it } from 'bun:test'

const REPO = path.resolve(import.meta.dir, '..', '..', '..')
const INTERNAL = /\b(seams?|floors?|fold(s|ed|ing)?|staged)\b/gi

it('no package README uses core-internal words in its prose', () => {
  const readmes = readdirSync(path.join(REPO, 'packages'))
    .map((p) => path.join(REPO, 'packages', p, 'README.md'))
    .filter((f) => existsSync(f))
  expect(readmes.length).toBeGreaterThan(10)
  const found: string[] = []
  for (const file of readmes) {
    const prose = readFileSync(file, 'utf8')
      .replace(/^```[\s\S]*?^```/gm, '')
      .replace(/`[^`\n]*`/g, '')
    for (const m of prose.matchAll(INTERNAL)) {
      found.push(`${path.relative(REPO, file)}: ${m[0]}`)
    }
  }
  expect(found).toEqual([])
})
