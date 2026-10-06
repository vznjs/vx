// `@vzn/vx/plugins` re-exports exactly the packages scripts/baked-plugins.ts
// lists: the list decides what the published @vzn/vx depends on and what
// the compile tasks read, the re-exports what the binary carries.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { expect, it } from 'bun:test'
import { BAKED_PLUGINS } from '../scripts/baked-plugins.ts'

it('plugins/index.ts re-exports exactly the baked plugin packages', () => {
  const source = readFileSync(path.join(import.meta.dir, '..', 'plugins', 'index.ts'), 'utf8')
  const lines = source.split('\n').filter((l) => !l.startsWith('//') && l.trim() !== '')
  expect(lines).toEqual(BAKED_PLUGINS.map((d) => `export * from '@vzn/${d}'`))
})
