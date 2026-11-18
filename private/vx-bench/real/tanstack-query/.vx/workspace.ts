import { defineWorkspace } from '@vzn/vx/config'
import { pnpm } from '@vzn/vx-lockfile'

// TanStack/query on native vx config (private/vx-bench/real/REPOS.md): the
// `build` of the 25 packages under packages/ that have one. pnpm() keys
// each task on its own dependency closure.
export default defineWorkspace({ plugins: [pnpm()] })
