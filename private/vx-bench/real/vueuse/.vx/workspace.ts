import { defineWorkspace } from '@vzn/vx/config'
import { pnpm } from '@vzn/vx-lockfile'

// vueuse/vueuse on native vx config (private/vx-bench/real/REPOS.md): the
// eleven package builds and the metadata index they read. pnpm() keys each
// task on its own dependency closure, where Turbo keys every task on the
// whole lockfile.
export default defineWorkspace({ plugins: [pnpm()] })
