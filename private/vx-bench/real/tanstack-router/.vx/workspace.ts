import { defineWorkspace } from '@vzn/vx/config'
import { pnpm } from '@vzn/vx-lockfile'

// TanStack/router on native vx config (private/vx-bench/real/REPOS.md):
// `build` and `test:build` of the packages and benchmarks; the examples and
// e2e apps are not mapped. pnpm() keys each task on its own dependency closure.
export default defineWorkspace({ plugins: [pnpm()] })
