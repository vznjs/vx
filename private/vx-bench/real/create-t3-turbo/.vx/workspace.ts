import { defineWorkspace } from '@vzn/vx/config'
import { pnpm } from '@vzn/vx-lockfile'

// t3-oss/create-t3-turbo on native vx config (private/vx-bench/real/REPOS.md):
// packages/* and tooling/*; the three apps are not mapped. pnpm() keys
// each task on its own dependency closure, where Turbo keys every task on
// the whole lockfile.
export default defineWorkspace({ plugins: [pnpm()] })
