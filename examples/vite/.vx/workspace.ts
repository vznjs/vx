// Marks the workspace root. bun() reads bun.lock: `^build` builds `ui`
// before `web`, and each task keys on the packages it installs.
import { defineWorkspace } from '@vzn/vx/config'
import { bun } from '@vzn/vx-lockfile'

export default defineWorkspace({ plugins: [bun()] })
