import { defineWorkspace } from '@vzn/vx/config'
import { pnpm } from '@vzn/vx-lockfile'

// solidjs/solid on native vx config (private/vx-bench/real/REPOS.md).
// pnpm() keys each task on its own dependency closure, where Turbo keys
// every task on the whole lockfile.
export default defineWorkspace({ plugins: [pnpm()] })
