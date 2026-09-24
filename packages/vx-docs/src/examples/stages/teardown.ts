import { rmSync, writeFileSync } from 'node:fs'
import { definePlugin, type VxPlugin } from '@vzn/vx'

// A marker file exists while a run is in progress, for a deploy script to
// wait on. setup writes it, and teardown removes it when the run ends.
export function busyMarker(): VxPlugin {
  let marker: string | undefined
  return definePlugin(import.meta, {
    setup(ctx) {
      marker = `${ctx.workspaceRoot}/.vx-run-in-progress`
      writeFileSync(marker, String(process.pid))
    },
    teardown() {
      if (marker !== undefined) rmSync(marker, { force: true })
    },
  })
}
