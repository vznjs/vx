import { defineWorkspace } from '@vzn/vx/config'
import { turbo } from '@vzn/vx-migrate'

// turbo.json and each package's scripts, run by vx: nothing rewritten.
export default defineWorkspace({ plugins: [turbo()] })
