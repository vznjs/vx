// docs/api.md is generated from `src/index.ts`: every export, its
// declaration as the contract records it (tests/helpers/api-surface.ts) and
// the doc comment above it. The committed page must equal what the source
// says, so a changed signature or comment turns this red until the page is
// regenerated:
//   VX_UPDATE_CONTRACT=1 bun test tests/api-reference.test.ts

import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, it } from 'bun:test'
import { exportsOf } from './helpers/api-surface.js'

const ROOT = path.resolve(import.meta.dir, '..')
const PAGE = path.join(ROOT, 'docs', 'api.md')

function page(): string {
  const entries = exportsOf(path.join(ROOT, 'src', 'index.ts'), ROOT)
  const out = [
    '# API reference',
    '',
    'Every export of `@vzn/vx`, generated from `src/index.ts` by',
    '`tests/api-reference.test.ts`: the declaration (comments dropped, a',
    'function to its signature, a class to its public members) and the doc',
    'comment above it. [The public surface](modules/index.md) groups the',
    'same names by what they are for; the plugins guide shows them in use.',
    '',
  ]
  for (const e of entries) {
    out.push(`## \`${e.name}\``, '', `${e.kind} · \`${e.file}\``, '')
    if (e.doc !== '') out.push(e.doc, '')
    out.push('```ts', ...e.text, '```', '')
  }
  return out.join('\n')
}

it('docs/api.md is what src/index.ts exports, with each doc comment', () => {
  const want = page()
  if (process.env['VX_UPDATE_CONTRACT'] === '1') writeFileSync(PAGE, want)
  expect(readFileSync(PAGE, 'utf8')).toBe(want)
})
