import { defineWorkspace } from '@vzn/vx/config'
import { pnpm } from '@vzn/vx-lockfile'

// unocss/unocss on native vx config (private/vx-bench/real/REPOS.md): the
// 42 package builds of its own `build` script. pnpm() orders each after the
// workspace packages it declares and keys it on its own dependency closure.
export default defineWorkspace({ plugins: [pnpm()] })
