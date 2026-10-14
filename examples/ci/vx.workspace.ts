import { defineWorkspace } from '@vzn/vx/config'
import { github } from '@vzn/vx-ci'
import { reapi } from '@vzn/vx-reapi'

const token = process.env.VX_CACHE_TOKEN

export default defineWorkspace({
  plugins: [
    // On Actions: the job summary, the PR check, and the cache scope
    // (a push to main writes the default keys, pull request 7 writes pr-7).
    github(),
    // The shared cache. With no VX_REAPI_ENDPOINT it declines and vx
    // caches on this machine alone.
    reapi({ headers: token ? { authorization: `Bearer ${token}` } : {} }),
  ],
})
