// Marks the workspace root. No plugin: vx finds each crate by its
// vx.config.ts, and a crate's Cargo.lock is one of its inputs.
import { defineWorkspace } from '@vzn/vx/config'

export default defineWorkspace({})
