import { defineWorkspace } from '@vzn/vx/config'
import { bun } from '@vzn/vx-lockfile'
import { turbo } from '@vzn/vx-migrate'

// turbo.json and each package's scripts, run by vx: nothing rewritten.
// bun() gives the package edges `^build` follows, from bun.lock.
export default defineWorkspace({ plugins: [turbo(), bun()] })
