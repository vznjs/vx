import { defineWorkspace } from '@vzn/vx/config'
import { pnpm } from '@vzn/vx-lockfile'

// refinedev/refine on native vx config (private/vx-bench/real/REPOS.md):
// the `build` of the 35 library packages under packages/. pnpm() keys each
// task on its own dependency closure.
export default defineWorkspace({ plugins: [pnpm()] })
