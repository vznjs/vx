import { defineWorkspace } from '@vzn/vx/config'
import { npm } from '@vzn/vx-lockfile'
import { turbo } from '@vzn/vx-migrate'

// turbo.json and each package's scripts, run by vx: nothing rewritten.
// npm() gives the package edges `^build` follows, from package-lock.json.
export default defineWorkspace({ plugins: [turbo(), npm()] })
