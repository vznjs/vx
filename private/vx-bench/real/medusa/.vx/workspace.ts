import { defineWorkspace } from '@vzn/vx/config'
import { yarn } from '@vzn/vx-lockfile'

// medusajs/medusa on native vx config (private/vx-bench/real/REPOS.md): the
// 83 tasks of the repo's own `build` script (`build` and `build:plugin`).
// yarn() keys each task on its own dependency closure, where Turbo keys every
// task on the whole lockfile.
export default defineWorkspace({ plugins: [yarn()] })
