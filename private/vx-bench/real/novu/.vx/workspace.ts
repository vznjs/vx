import { defineWorkspace } from '@vzn/vx/config'
import { pnpm } from '@vzn/vx-lockfile'

// novuhq/novu on native vx config (private/vx-bench/real/REPOS.md): every
// `build` its own `pnpm build` runs. pnpm() keys each task on its own
// dependency closure.
export default defineWorkspace({ plugins: [pnpm()] })
