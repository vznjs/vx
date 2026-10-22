// Marks the workspace root. bun() gives the package edges `^build`
// follows, from the bun.lock `bun install` writes. vx runs and
// caches on this machine.
import { defineWorkspace } from '@vzn/vx/config'
import { bun } from '@vzn/vx-lockfile'

export default defineWorkspace({ plugins: [bun()] })
