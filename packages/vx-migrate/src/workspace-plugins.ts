// The plugins a migrated workspace declares, from what the repo shows
// (owner, 2026-10-06: "install and migrate fully … use the plugins"). Each
// is inert where it does not apply, so declaring one costs a run nothing,
// and each is built into the vx binary, so none is installed (owner: "not
// have to install any native plugins").

import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { lockfilePlugin } from './workspace-notes.js'

/** The factory names, in declaration order, all from `@vzn/vx/plugins`. */
export function workspacePlugins(root: string): string[] {
  const out: string[] = []
  const lock = lockfilePlugin(root)
  if (lock !== undefined) out.push(lock.factory)
  out.push('scheduleHistoryPlugin')
  if (existsSync(path.join(root, '.github', 'workflows'))) out.push('github')
  return out
}

/** The workspace file at `root`, in any extension the loader reads. */
export function workspaceFileAt(root: string): string | undefined {
  return readdirSync(root).find((n) => /^vx\.workspace\.(ts|mts|js|mjs|cts|cjs)$/.test(n))
}

/** `plugins` that `text` does not already call. */
export function undeclared(text: string, plugins: readonly string[]): string[] {
  return plugins.filter((p) => !new RegExp(`\\b${p}\\s*\\(`).test(text))
}

function importLine(plugins: readonly string[]): string {
  return `import { ${plugins.join(', ')} } from '@vzn/vx/plugins'`
}

function entries(plugins: readonly string[], indent: string): string[] {
  return plugins.map((p) => `${indent}${p}(),`)
}

/** `vx.workspace.<format>` declaring `plugins`. */
export function renderWorkspaceFile(plugins: readonly string[], format: 'ts' | 'mjs'): string {
  return [
    ...(format === 'ts' ? ["import type { WorkspaceConfig } from '@vzn/vx/config'"] : []),
    importLine(plugins),
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
 * the file already calls is not added twice.
 */
export function extendWorkspaceFile(text: string, plugins: readonly string[]): string | null {
  const m = /^export default \{ plugins: \[([^\]\n]*)\] \}/m.exec(text)
  if (m === null) return null
  const added = undeclared(text, plugins)
  if (added.length === 0) return text
  const head = text.slice(0, m.index).trimEnd()
  const tail = text.slice(m.index + m[0].length)
  const kept = m[1]!.trim()
  return [
    head,
    importLine(added),
    '',
    'export default {',
    '  plugins: [',
    ...(kept === '' ? [] : [`    ${kept},`]),
    ...entries(added, '    '),
    '  ],',
    `}${tail}`,
  ].join('\n')
}
