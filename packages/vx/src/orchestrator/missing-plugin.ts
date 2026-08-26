/** Shown by every "no <capability> plugin declared" error. */
export const MISSING_PLUGIN_HINT = `vx runs nothing it was not told to. Declare the plugins in vx.workspace.ts:

  import { defineWorkspace } from '@vzn/vx'
  import { localExecutorPlugin } from '@vzn/vx/plugins/local-executor'
  import { localCachePlugin } from '@vzn/vx/plugins/local-cache'
  export default defineWorkspace({ plugins: [localExecutorPlugin(), localCachePlugin()] })

Put a remote executor or cache plugin BEFORE the local one to prefer it.`
