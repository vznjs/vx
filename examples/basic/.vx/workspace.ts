// Marks the workspace root. npm() gives the package edges `^build`
// follows, from the package-lock.json `npm install` writes. vx runs and
// caches on this machine.
import { defineWorkspace } from '@vzn/vx/config'
import { npm } from '@vzn/vx-lockfile'

export default defineWorkspace({ plugins: [npm()] })
