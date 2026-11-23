// Marks the workspace root. bun() reads bun.lock: `site` depends on
// `format`, so an edit to format re-runs site's build.
import { defineWorkspace } from '@vzn/vx/config'
import { bun } from '@vzn/vx-lockfile'

export default defineWorkspace({ plugins: [bun()] })
