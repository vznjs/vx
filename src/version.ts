// Leaf module so orchestrator/cli can read the version without
// importing the public façade (index.ts imports the orchestrator —
// that edge must stay one-directional).
//
// Single source of truth is package.json — Bun resolves the JSON
// import natively (and inlines it under `bun build --compile`), so
// a release bump can never drift from what the banner prints.
import pkg from '../package.json'

export const VERSION: string = pkg.version
