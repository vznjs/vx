// A leaf module, so orchestrator and cli read the version without importing
// the façade (which imports the orchestrator). package.json is the one
// source, except in a release binary: `compile.bun.*` defines VX_RELEASE as
// VX_RELEASE_VERSION, so a release compiles on any worker with no stamped
// manifest. Empty (not a release) or undefined (not compiled), the manifest.
import pkg from '../package.json'

declare const VX_RELEASE: string | undefined

export const VERSION: string =
  typeof VX_RELEASE === 'string' && VX_RELEASE !== '' ? VX_RELEASE : pkg.version
