// prisma's `biome check` failed on the workspace file init wrote: its
// organizeImports wants one import per package, sorted by package.
import { describe, expect, it } from 'bun:test'
import { renderWorkspaceFile } from '../src/workspace-plugins.js'

describe('the workspace file vx-migrate writes', () => {
  it('imports each package once, packages and names sorted, and keeps the plugin order', () => {
    const text = renderWorkspaceFile(
      [
        { factory: 'pnpm', pkg: '@vzn/vx-lockfile' },
        { factory: 'turboCache', pkg: '@vzn/vx-migrate' },
        { factory: 'vxHistory', pkg: '@vzn/vx-history' },
        { factory: 'turbo', pkg: '@vzn/vx-migrate' },
      ],
      'ts',
    )
    expect(text).toStartWith(
      [
        "import type { WorkspaceConfig } from '@vzn/vx/config'",
        "import { vxHistory } from '@vzn/vx-history'",
        "import { pnpm } from '@vzn/vx-lockfile'",
        "import { turbo, turboCache } from '@vzn/vx-migrate'",
        '',
        'export default {',
        '  plugins: [',
        '    pnpm(),',
        '    turboCache(),',
        '    vxHistory(),',
        '    turbo(),',
      ].join('\n'),
    )
  })
})
