import { defineWorkspace } from '@vzn/vx/config'
import { github } from '@vzn/vx-ci'
import { bun } from '@vzn/vx-lockfile'
import { reapi } from '@vzn/vx-reapi'

const token = process.env.VX_CACHE_TOKEN

export default defineWorkspace({
  plugins: [
    // The package edges `^build` follows, from bun.lock.
    bun(),
    // On Actions: the job summary, the PR check, and the PR's base for --affected.
    github(),
    // The shared cache, here a Bazel REAPI server; turboCache() or nxCache()
    // fit the same slot. With no VX_REAPI_ENDPOINT it declines and vx
    // caches on this machine alone.
    reapi({ headers: token ? { authorization: `Bearer ${token}` } : {} }),
  ],
})
