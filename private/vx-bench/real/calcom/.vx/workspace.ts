import { defineWorkspace } from '@vzn/vx/config'
import { yarn } from '@vzn/vx-lockfile'

// calcom/cal.com on native vx config (private/vx-bench/real/REPOS.md): the
// 13 tasks of the repo's own `build` script (`@calcom/web...`). yarn() keys
// each task on its own dependency closure, where Turbo keys every task on
// the whole lockfile.
export default defineWorkspace({ plugins: [yarn()] })
