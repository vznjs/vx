// `project`: a project's tasks. Every script in the project's package.json
// becomes a task of the same name that runs it, unless the project already
// declares one. Core reads no package.json, so the plugin does. Core
// re-validates each edit as it would the user's own config.
import { definePlugin, type VxPlugin } from '@vzn/vx'

export function scriptTasks(): VxPlugin {
  return definePlugin(import.meta, {
    async project(config, ctx) {
      const pkg: unknown = await Bun.file(`${ctx.dir}/package.json`)
        .json()
        .catch(() => null)
      const scripts = (pkg as { scripts?: unknown } | null)?.scripts
      if (scripts === null || typeof scripts !== 'object') return
      config.tasks ??= {}
      for (const [name, command] of Object.entries(scripts)) {
        if (typeof command !== 'string' || config.tasks[name] !== undefined) continue
        config.tasks[name] = { exec: { command } }
      }
    },
  })
}
