// Chapter 8, guide/many-machines: a shared cache, who may write to it, and
// remote workers. Its pictures are drawn by Sketch.astro, which every Guide
// picture shares, so the row that holds Sketch to the theme's tokens lives
// here; its "In vx" config is type-checked against the real plugin.
//
// It reads `dist/`, which the `build` task writes; the `test` task depends
// on `build` for that reason.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import * as P from '../src/components/guide/many-machines/pictures.js'
import {
  SITE,
  chapterShape,
  codeBlocks,
  content,
  only,
  page,
  sections,
  typeCheck,
} from './guide-page-late.js'

const SLUG = 'many-machines'
const SKETCH = path.join(SITE, 'src/components/guide/Sketch.astro')

/** The theme's tokens, the only colours a Guide picture may use. */
const TOKENS = [
  '--vx-accent',
  '--vx-link',
  '--vx-fg',
  '--vx-muted',
  '--vx-surface',
  '--vx-surface-2',
  '--vx-border',
  '--vx-danger',
  '--vx-ok',
  '--vx-warn',
  '--vx-mono',
]

// Expressive Code turns the block's `// vx.workspace.ts` line into its title.
const IN_VX = `import { defineWorkspace } from '@vzn/vx'
import { reapi } from '@vzn/vx-reapi'

export default defineWorkspace({
  plugins: [reapi({ endpoint: 'grpcs://cache.example.com:443', execute: true })],
})`

chapterShape({
  slug: SLUG,
  titles: [
    'Same inputs give the same key on every machine',
    'Only CI writes to the shared cache',
    'A worker gets only what the task declares',
    'Both cost something',
  ],
  pictures: [P.threeBuilds, P.sameKey, P.whoWrites, P.worker],
  rows: {
    'packages/vx/tests/task-hash-derive.test.ts': [
      'is a pure function of its inputs: same inputs, same key',
    ],
    'packages/vx/tests/layered-cache.test.ts': [
      'get() suppresses remote errors and returns null',
      'get() degrades a corrupt remote artifact to a miss instead of throwing',
      'save() with remote writes off uploads nothing: local entry, no remote PUT',
    ],
    'packages/vx-reapi/tests/executor.test.ts': ['takes only cacheable, unpinned tasks'],
  },
  inVxNames: ['Turborepo', 'Nx'],
})

describe('the pictures on guide/many-machines', () => {
  it('draws the laptop only reading and CI writing', () => {
    const arrows = P.whoWrites.arrows!.map((a) => `${a.from}→${a.to} ${a.tone} ${a.label}`)
    expect(arrows).toEqual([
      'ci→cache accent writes',
      'cache→laptop link reads',
      'laptop→cache danger never writes',
    ])
  })

  it('sends the worker only the declared input', () => {
    expect(P.worker.arrows!.filter((a) => a.to === 'worker').map((a) => a.from)).toEqual(['src'])
  })

  it("colours every Guide picture only with the theme's tokens, and ships no script", () => {
    const source = readFileSync(SKETCH, 'utf8')
    const style = only(source, /<style>([\s\S]*?)<\/style>/g)
    expect(style.match(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/gi) ?? []).toEqual([])
    const used = [...new Set([...style.matchAll(/var\((--[\w-]+)\)/g)].map((m) => m[1]!))]
    // Positive first: the reader found the tokens.
    expect(used).toContain('--vx-accent')
    expect(used.filter((v) => !TOKENS.includes(v) && !v.startsWith('--sl-text-'))).toEqual([])
    expect(source).not.toMatch(/<script\b/)
  })
})

describe('"In vx" on guide/many-machines', () => {
  const inVx = sections(content(page(`guide/${SLUG}`))).find((s) => s.id === 'in-vx')!.html

  it('names the read-only spec the CLI documents for a laptop', () => {
    const cli = readFileSync(path.join(SITE, 'src/content/docs/cli.md'), 'utf8')
    expect(inVx).toContain('--cache=local:rw,remote:r')
    expect(cli).toMatch(/^\| `--cache=local:rw,remote:r` \| remote read-only \(won't upload\)/m)
  })

  it('shows a workspace that type-checks against the real plugin', async () => {
    expect(codeBlocks(inVx, 'ts')).toEqual([IN_VX])
    expect(only(inVx, /<span class="title">([^<]*)<\/span>/g)).toBe('vx.workspace.ts')
    await typeCheck({ 'vx.workspace.ts': IN_VX })
  }, 120_000)
})
