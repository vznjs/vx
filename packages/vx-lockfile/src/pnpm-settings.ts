// What every task folds from pnpm-workspace.yaml, apart from the lockfile
// parser: a warm run reads the settings on every key, and loading pnpm.ts
// for them cost ~1.5 ms a run.
import { record, stable, type Json } from './json.js'

const PER_PROJECT = new Set(['patchedDependencies', 'overrides', 'catalog', 'catalogs'])

/**
 * pnpm-workspace.yaml as every task folds it: without `patchedDependencies`,
 * `overrides` and the catalogs, whose effect the lockfile records per
 * project (pnpm 10+ keeps them here). Undefined for a file that does not parse to a mapping,
 * folded whole.
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
  for (const [k, v] of Object.entries(map)) if (!PER_PROJECT.has(k)) rest[k] = v
  return `pnpm-workspace\0${stable(rest)}`
}

/**
 * The root package.json as every task folds it: only its `pnpm` field,
 * which pnpm reads install settings from (`onlyBuiltDependencies`,
 * `supportedArchitectures`, …) and the lockfile records none of, without
 * the patches and overrides it does record. Its dependencies are the
 * lockfile's to record. Undefined for a file that does not parse to a
 * mapping, folded whole.
 */
export function packageSettings(text: string): string | undefined {
  let doc: unknown
  try {
    doc = JSON.parse(text)
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
