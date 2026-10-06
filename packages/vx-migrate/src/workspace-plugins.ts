// The plugins a migrated workspace declares, from what the repo shows
// (owner, 2026-10-06: "install and migrate fully … use the plugins"). Each
// is inert where it does not apply, so declaring one costs a run nothing.

import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { lockfilePlugin } from './workspace-notes.js'

export interface WorkspacePlugin {
  readonly pkg: string
  readonly factory: string
  /** The comment above its entry. */
  readonly why: string
}

export function workspacePlugins(root: string): WorkspacePlugin[] {
  const out: WorkspacePlugin[] = []
  const lock = lockfilePlugin(root)
  if (lock !== undefined) {
    out.push({
      pkg: '@vzn/vx-lockfile',
      factory: lock.factory,
      why: `keys each package's tasks on its own dependency closure in ${lock.file}`,
    })
  }
  out.push({
    pkg: '@vzn/vx-schedule-history',
    factory: 'scheduleHistoryPlugin',
    why: 'starts the longest path first, learned from past runs',
  })
  if (existsSync(path.join(root, '.github', 'workflows'))) {
    out.push({
      pkg: '@vzn/vx-github',
      factory: 'github',
      why: 'a job summary per run on GitHub Actions; inert elsewhere',
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
  return plugins.flatMap((p) => [`${indent}// ${p.why}`, `${indent}${p.factory}(),`])
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
    '// Running here and caching in .vx/cache are the floor under every plugin.',
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
