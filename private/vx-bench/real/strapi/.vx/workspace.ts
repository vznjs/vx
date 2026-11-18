import { defineWorkspace } from '@vzn/vx/config'
import { yarn } from '@vzn/vx-lockfile'

// strapi/strapi on native vx config (private/vx-bench/real/REPOS.md): the
// repo's own `build` script, `build:code` and `build:types` of every package.
// yarn() keys each task on its own dependency closure.
export default defineWorkspace({ plugins: [yarn()] })
