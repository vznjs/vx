// `project`: a project's tasks. Every package.json script becomes a task of
// the same name that runs it, unless the project already declares one.
// Core re-validates each edit as it would the user's own config.
import { definePlugin, type VxPlugin } from '@vzn/vx'

export function scriptTasks(): VxPlugin {
  return definePlugin(import.meta, {
    project(config, ctx) {
      const scripts = ctx.packageJson['scripts']
      if (scripts === null || typeof scripts !== 'object') return
      config.tasks ??= {}
      for (const [name, command] of Object.entries(scripts)) {
        if (typeof command !== 'string' || config.tasks[name] !== undefined) continue
        config.tasks[name] = { exec: { command } }
      }
    },
  })
}
