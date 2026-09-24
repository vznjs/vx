import { definePlugin, UserError, type VxPlugin } from '@vzn/vx'

// Refuse to start a run without the token a deploy task needs, before any
// task has run, rather than failing half way through.
export function requireEnv(name: string): VxPlugin {
  return definePlugin(import.meta, {
    setup() {
      if (process.env[name] === undefined) {
        throw new UserError(
          `${name} is not set: export it, or remove requireEnv() from vx.workspace.ts`,
        )
      }
    },
  })
}
