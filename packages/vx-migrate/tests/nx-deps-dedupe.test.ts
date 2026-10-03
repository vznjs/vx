// One Nx edge spelled several ways is one vx dependency (P2-16): the
// written config listed `@acme/ui#gen` twice.

import { describe, expect, it } from 'bun:test'
import type { ProjectMeta } from '@vzn/vx'
import { mapNxDeps } from '../src/nx/nx-deps.js'

const ui: ProjectMeta = {
  name: '@acme/ui',
  dir: '/w/libs/ui',
  packageJson: { name: '@acme/ui' },
  configPath: null,
}

describe('mapNxDeps', () => {
  it('lists an edge once however Nx spells it', () => {
    const todos: string[] = []
    expect(
      mapNxDeps(
        [
          '^build',
          'ui:gen',
          { projects: ['ui'], target: 'gen' },
          { projects: 'ui', target: 'gen' },
          '^build',
        ],
        new Map([['ui', ui]]),
        () => false,
        () => null,
        () => true,
        todos,
      ),
    ).toEqual(['^build', '@acme/ui#gen'])
    expect(todos).toEqual([])
  })
})
