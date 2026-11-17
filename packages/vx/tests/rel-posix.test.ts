// `relPosix` answers a plainly spelled file under `from` without
// `path.relative`; every other spelling takes the resolving path. Both must
// agree: the answer names an input in the key's facts.

import { expect, it } from 'bun:test'
import path from 'node:path'
import { relPosix } from '../src/util/index.js'

it('agrees with path.relative on every spelling', () => {
  const froms = ['/ws', '/ws/pkg', '/', '/ws/', '/ws/./pkg', '/ws/x/..']
  const tos = [
    '/ws/pkg/src/a.ts',
    '/ws/pkg/.eslintrc',
    '/ws/pkg/..hidden/a',
    '/ws/pkg/a..b',
    '/ws/pkg/src/',
    '/ws/pkg//src/a.ts',
    '/ws/pkg/./src/a.ts',
    '/ws/pkg/src/../a.ts',
    '/ws/pkg/src/.',
    '/ws/pkg/src/..',
    '/ws/pkg',
    '/ws/pkgs/a.ts',
    '/ws',
    '/other/a.ts',
    '/ws/./pkg/a.ts',
    '/ws/x/../pkg/a.ts',
    '/ws/pkg/\uD800',
    '/ws/pkg/日本語/a.ts',
    '/ws/pkg/\u{1F389}/a.ts',
  ]
  for (const from of froms) {
    for (const to of tos)
      expect([from, to, relPosix(from, to)]).toEqual([from, to, path.relative(from, to)])
  }
})
