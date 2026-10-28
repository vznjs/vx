// The plugins a migrated workspace declares, from what the repo shows
// (2026-10-06: "install and migrate fully … use the plugins"). Each
// is inert where it does not apply, so declaring one costs a run nothing,
// and each is installed beside vx at vx-migrate's own version (plugins
// pin their core peer to the release they shipped with).

import { existsSync } from 'node:fs'
import path from 'node:path'
import { REMOTE_CACHE, remoteCacheSignal } from './remote-cache.js'
import { lockfilePlugin } from './workspace-notes.js'

export { workspaceFileAt } from './workspace-notes.js'

export interface WorkspacePlugin {
  readonly pkg: string
  readonly factory: string
}

/** `runner`: the Turbo or Nx repo's own remote cache, where the repo shows one. */
export function workspacePlugins(root: string, runner?: 'turbo' | 'nx'): WorkspacePlugin[] {
  const out: WorkspacePlugin[] = []
  if (runner !== undefined && remoteCacheSignal(root, runner) !== undefined)
    out.push({ pkg: '@vzn/vx-migrate', factory: REMOTE_CACHE[runner] })
  const lock = lockfilePlugin(root)
  if (lock !== undefined) out.push({ pkg: '@vzn/vx-lockfile', factory: lock.factory })
  out.push({ pkg: '@vzn/vx-history', factory: 'vxHistory' })
  if (existsSync(path.join(root, '.github', 'workflows')))
    out.push({ pkg: '@vzn/vx-ci', factory: 'github' })
  // A remote cache on CI reads the refs only these name (2026-10-25).
  if (existsSync(path.join(root, '.gitlab-ci.yml')))
    out.push({ pkg: '@vzn/vx-ci', factory: 'gitlab' })
  return out
}

/** `plugins` that `text` does not already call. */
export function undeclared(text: string, plugins: readonly WorkspacePlugin[]): WorkspacePlugin[] {
  return plugins.filter((p) => !new RegExp(`\\b${p.factory}\\s*\\(`).test(text))
}

function importLines(plugins: readonly WorkspacePlugin[]): string[] {
  return plugins.map((p) => `import { ${p.factory} } from '${p.pkg}'`)
}

function entries(plugins: readonly WorkspacePlugin[], indent: string): string[] {
  return plugins.map((p) => `${indent}${p.factory}(),`)
}

/** `baseBranch: 'main',` as its own line; `run.concurrency` and its group's other fields as one `run: { … }` line. */
function groupLines(
  fields: readonly { readonly field: string; readonly source: string }[],
): string[] {
  const top: string[] = []
  const groups = new Map<string, string[]>()
  for (const f of fields) {
    const [group, key] = f.field.split('.') as [string, string | undefined]
    if (key === undefined) top.push(`  ${group}: ${f.source},`)
    else groups.set(group, [...(groups.get(group) ?? []), `${key}: ${f.source}`])
  }
  return [
    ...top,
    ...[...groups].map(([group, entries]) => `  ${group}: { ${entries.join(', ')} },`),
  ]
}

/** `.vx/workspace.<format>` declaring `plugins`. */
export function renderWorkspaceFile(
  plugins: readonly WorkspacePlugin[],
  format: 'ts' | 'mjs',
  fields: readonly { readonly field: string; readonly source: string }[] = [],
): string {
  return [
    ...(format === 'ts' ? ["import type { WorkspaceConfig } from '@vzn/vx/config'"] : []),
    ...importLines(plugins),
    '',
    'export default {',
    '  plugins: [',
    ...entries(plugins, '    '),
    '  ],',
    ...groupLines(fields),
    `}${format === 'ts' ? ' satisfies WorkspaceConfig' : ''}`,
    '',
  ].join('\n')
}

/**
 * Add `plugins` to a one-line workspace file (`export default { plugins:
 * [turbo()] }`); null for any other shape, which is left alone. A plugin
 * the file already calls is not added twice.
 */
export function extendWorkspaceFile(
  text: string,
  plugins: readonly WorkspacePlugin[],
): string | null {
  const m = /^export default \{ plugins: \[([^\]\n]*)\] \}/m.exec(text)
  if (m === null) return null
  const added = undeclared(text, plugins)
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
    ...topLevel(kept).map((k) => `    ${k},`),
    ...entries(added, '    '),
    '  ],',
    `}${tail}`,
  ].join('\n')
}

/** `a(), b({ x, y })` → `['a()', 'b({ x, y })']`: the commas outside any bracket. */
function topLevel(list: string): string[] {
  const out: string[] = []
  let depth = 0
  let from = 0
  for (let i = 0; i < list.length; i++) {
    const c = list[i]!
    if ('([{'.includes(c)) depth++
    else if (')]}'.includes(c)) depth--
    else if (c === ',' && depth === 0) {
      out.push(list.slice(from, i))
      from = i + 1
    }
  }
  return [...out, list.slice(from)].map((e) => e.trim()).filter((e) => e !== '')
}

/**
 * The plugins of a workspace file vx wrote (`vx init`, `--keep`, a native
 * migration): `@vzn` imports and argument-less calls, nothing else. Null
 * for any other file, which is the user's and left alone.
 */
export function generatedPlugins(text: string): WorkspacePlugin[] | null {
  const pkgOf = new Map<string, string>()
  const body: string[] = []
  for (const line of text.split('\n')) {
    const m = /^import \{ ([\w, ]+) \} from '(@vzn\/[\w./-]+)'$/.exec(line)
    if (m !== null) for (const name of m[1]!.split(',')) pkgOf.set(name.trim(), m[2]!)
    else if (line !== "import type { WorkspaceConfig } from '@vzn/vx/config'") body.push(line)
  }
  const m =
    /^export default \{\s*plugins:\s*\[((?:\s*\w+\(\)\s*,?)*)\s*\],?\s*\}(?: satisfies WorkspaceConfig)?$/.exec(
      body.join('\n').trim(),
    )
  if (m === null) return null
  const factories = [...m[1]!.matchAll(/(\w+)\(\)/g)].map((c) => c[1]!)
  // No plugin at all is a file vx never wrote.
  if (
    factories.length === 0 ||
    factories.length !== pkgOf.size ||
    factories.some((f) => !pkgOf.has(f))
  )
    return null
  return factories.map((factory) => ({ pkg: pkgOf.get(factory)!, factory }))
}
