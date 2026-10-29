// What every task folds from the root package.json under yarn(), apart
// from the lockfile parser, which a warm run need not load for it.
import { record, stable, type Json } from './json.js'

/**
 * The root package.json as every task folds it: `workspaces.nohoist`
 * (Yarn 1 lays node_modules out by it), `installConfig` and
 * `resolutions`. yarn.lock records none of them: one scoped to a parent
 * (`"is-odd/is-number"`) leaves the parent's entry on the range it
 * declares, so adding one whose range another package already keys
 * changes the install with yarn.lock byte for byte (turborepo#14499).
 * Its dependencies are the lockfile's to record. Undefined for a file that does not parse to a mapping, folded
 * whole.
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
  const kept: Json = {}
  const nohoist = record(map['workspaces'])?.['nohoist']
  if (nohoist !== undefined) kept['nohoist'] = nohoist
  if (map['installConfig'] !== undefined) kept['installConfig'] = map['installConfig']
  if (map['resolutions'] !== undefined) kept['resolutions'] = map['resolutions']
  return `yarn-package\0${stable(kept)}`
}
