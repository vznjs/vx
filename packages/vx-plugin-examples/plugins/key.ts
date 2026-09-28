// `key`: extra cache-key material. The value of each named environment
// variable is folded into every cached task's key and named in `vx why`,
// so a change to it is a miss. An unset variable folds as ''.
import { definePlugin, type VxPlugin } from '@vzn/vx'

export function envKey(names: readonly string[]): VxPlugin {
  return definePlugin(import.meta, {
    key() {
      return Object.fromEntries(names.map((n) => [n, process.env[n] ?? '']))
    },
  })
}
