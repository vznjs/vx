import { defineWorkspace } from '@vzn/vx/config'
import { pnpm } from '@vzn/vx-lockfile'

// payloadcms/payload on native vx config (private/vx-bench/real/REPOS.md):
// the 45 builds of the repo's own `build:all`. pnpm() keys each task on its
// own dependency closure, where Turbo keys every task on the whole lockfile.
export default defineWorkspace({ plugins: [pnpm()] })
