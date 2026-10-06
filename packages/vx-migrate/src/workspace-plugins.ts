// The plugins a migrated workspace declares, from what the repo shows
// (owner, 2026-10-06: "install and migrate fully … use the plugins"). Each
// is inert where it does not apply, so declaring one costs a run nothing,
// and each is built into the vx binary, so none is installed (owner: "not
// have to install any native plugins").

import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { lockfilePlugin } from './workspace-notes.js'

export interface WorkspacePlugin {
  readonly pkg: string
  readonly factory: string
}

export function workspacePlugins(root: string): WorkspacePlugin[] {
  const out: WorkspacePlugin[] = []
  const lock = lockfilePlugin(root)
  if (lock !== undefined) {
    out.push({
      pkg: '@vzn/vx-lockfile',
      factory: lock.factory,
    })
  }
  out.push({
    pkg: '@vzn/vx-schedule-history',
    factory: 'scheduleHistoryPlugin',
  })
  if (existsSync(path.join(root, '.github', 'workflows'))) {
    out.push({
      pkg: '@vzn/vx-github',
      factory: 'github',
    })
  }
  return out
}

/** The workspace file at `root`, in any extension the loader reads. */
export function workspaceFileAt(root: string): string | undefined {
  return readdirSync(root).find((n) => /^vx\.workspace\.(ts|mts|js|mjs|cts|cjs)$/.test(n))
}

function importLines(plugins: readonly WorkspacePlugin[]): string[] {
  return plugins.map((p) => `import { ${p.factory} } from '${p.pkg}'`)
}

function entries(plugins: readonly WorkspacePlugin[], indent: string): string[] {
  return plugins.map((p) => `${indent}${p.factory}(),`)
}

/** `vx.workspace.<format>` declaring `plugins`. */
export function renderWorkspaceFile(
  plugins: readonly WorkspacePlugin[],
  format: 'ts' | 'mjs',
): string {
  return [
    ...(format === 'ts' ? ["import type { WorkspaceConfig } from '@vzn/vx/config'"] : []),
    ...importLines(plugins),
    '',
    'export default {',
    '  plugins: [',
    ...entries(plugins, '    '),
    '  ],',
    `}${format === 'ts' ? ' satisfies WorkspaceConfig' : ''}`,
    '',
  ].join('\n')
}

/**
 * Add `plugins` to the file `vx init` writes (`export default { plugins:
 * [turbo()] }`); null for any other shape, which is left alone. A plugin
 * already imported is not added twice.
 */
export function extendWorkspaceFile(
  text: string,
  plugins: readonly WorkspacePlugin[],
): string | null {
  const m = /^export default \{ plugins: \[([^\]\n]*)\] \}/m.exec(text)
  if (m === null) return null
  const added = plugins.filter((p) => !text.includes(`from '${p.pkg}'`))
  if (added.length === 0) return text
  const head = text.slice(0, m.index).trimEnd()
  const tail = text.slice(m.index + m[0].length)
  const kept = m[1]!.trim()
  return [
    head,
    ...importLines(added),
    '',
    'export default {',
    '  plugins: [',
    ...(kept === '' ? [] : [`    ${kept},`]),
    ...entries(added, '    '),
    '  ],',
    `}${tail}`,
  ].join('\n')
}
