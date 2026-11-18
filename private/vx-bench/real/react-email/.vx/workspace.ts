import { defineWorkspace } from '@vzn/vx/config'
import { pnpm } from '@vzn/vx-lockfile'

// resend/react-email on native vx config (private/vx-bench/real/REPOS.md):
// the four packages under packages/ that build. pnpm() keys each task on
// its own dependency closure, where turbo.json's globalDependencies key
// every task on the whole lockfile.
export default defineWorkspace({ plugins: [pnpm()] })
