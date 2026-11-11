// What every task folds from pnpm-workspace.yaml, apart from the lockfile
// parser: a warm run reads the settings on every key, and loading pnpm.ts
// for them cost ~1.5 ms a run.
import { record, stable, type Json } from './json.js'

/** What pnpm-lock.yaml records per project: its effect keys through the snapshots a project reaches. */
const RECORDED = new Set(['patchedDependencies', 'overrides', 'catalog', 'catalogs'])

/**
 * pnpm-workspace.yaml as every task folds it: without `patchedDependencies`,
 * `overrides` and the catalogs, whose effect the lockfile records per
 * project (pnpm 10+ keeps them here). Undefined for a file that does not
 * parse to a mapping, folded whole.
 */
export function workspaceSettings(text: string): string | undefined {
  let doc: unknown
  try {
    doc = Bun.YAML.parse(text)
  } catch {
    return undefined
  }
  const map = record(doc)
  if (map === undefined) return undefined
  const rest: Json = {}
  for (const [k, v] of Object.entries(map)) {
    if (!RECORDED.has(k)) rest[k] = v
  }
  return `pnpm-workspace\0${stable(rest)}`
}

/**
 * pnpm's `shared-workspace-lockfile`, true unless set: pnpm-workspace.yaml's
 * `sharedWorkspaceLockfile` when a boolean (pnpm 10.8+ reads it first; a
 * quoted "false" installs shared), else `.npmrc`'s.
 */
export function sharedWorkspaceLockfile(
  workspaceYaml: string | null,
  npmrc: string | null,
): boolean {
  if (workspaceYaml !== null) {
    try {
      const set = record(Bun.YAML.parse(workspaceYaml))?.['sharedWorkspaceLockfile']
      if (typeof set === 'boolean') return set
    } catch {}
  }
  return npmrc?.match(/^[ \t]*shared-workspace-lockfile[ \t]*=[ \t]*(\S*)/m)?.[1] !== 'false'
}

/**
 * The root manifest (`file`: package.json, package.json5 or package.yaml)
 * as every task folds it: only its `pnpm` field,
 * which pnpm reads install settings from (`onlyBuiltDependencies`,
 * `supportedArchitectures`, …) and the lockfile records none of, without
 * the patches and overrides it does record. Its dependencies are the
 * lockfile's to record. Undefined for a file that does not parse to a
 * mapping, folded whole.
 */
export function packageSettings(text: string, file: string): string | undefined {
  let doc: unknown
  try {
    doc = file.endsWith('.yaml')
      ? Bun.YAML.parse(text)
      : file.endsWith('.json5')
        ? Bun.JSON5.parse(text)
        : JSON.parse(text)
  } catch {
    return undefined
  }
  const map = record(doc)
  if (map === undefined) return undefined
  const rest: Json = {}
  for (const [k, v] of Object.entries(record(map['pnpm']) ?? {})) {
    if (k !== 'patchedDependencies' && k !== 'overrides') rest[k] = v
  }
  return `pnpm-package\0${stable(rest)}`
}

/**
 * Whether pnpm lays node_modules out hoisted: `nodeLinker` in
 * pnpm-workspace.yaml or `node-linker` in `.npmrc` says `hoisted`. That
 * install keeps one copy per `name@version` and ignores the lockfile's
 * peer variants; `isolated` (the default) and `pnp` keep each variant.
 */
export function hoistedLinker(
  workspaceYaml: string | undefined,
  npmrc: string | undefined,
): boolean {
  if (workspaceYaml !== undefined) {
    try {
      if (record(Bun.YAML.parse(workspaceYaml))?.['nodeLinker'] === 'hoisted') return true
    } catch {}
  }
  return npmrc !== undefined && /^[ \t]*node-linker[ \t]*=[ \t]*["']?hoisted\b/m.test(npmrc)
}
