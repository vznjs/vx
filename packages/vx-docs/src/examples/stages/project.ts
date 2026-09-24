import { definePlugin, type VxPlugin } from '@vzn/vx'

// Every package with a `lint` script gets a cached `lint` task running it.
export function lintScripts(): VxPlugin {
  return definePlugin(import.meta, {
    project(config, ctx) {
      const scripts = ctx.packageJson['scripts'] as Record<string, string> | undefined
      const lint = scripts?.['lint']
      if (lint === undefined) return
      config.tasks ??= {}
      config.tasks['lint'] ??= {
        exec: { command: lint },
        cache: { inputs: { files: ['src/**', 'package.json'] }, outputs: { files: [] } },
      }
    },
  })
}
