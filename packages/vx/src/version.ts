// A leaf module, so orchestrator and cli read the version without importing
// the façade (which imports the orchestrator). package.json is the one
// source: Bun inlines the JSON under `bun build --compile`.
import pkg from '../package.json'

export const VERSION: string = pkg.version
