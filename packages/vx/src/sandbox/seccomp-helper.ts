// A user's tsc reads this file but not our tsconfig's `include`: the reference
// brings the file-import declarations along (no import can name a script .d.ts).
// oxlint-disable-next-line typescript/triple-slash-reference
/// <reference path="./vendor-files.d.ts" />
// SRT's Linux seccomp helper (`apply-seccomp`), where a task can exec it.
// SRT finds it beside its own files, then under `npm root -g`. A compiled
// vx bundles SRT's JS but not its `vendor/`, so the published binary found
// none: every sandboxed run asked `npm root -g`, then ran with no write
// observer (a refused write named nothing, and one the task swallowed
// passed) and no AF_UNIX block. Bun embeds a `type: 'file'` import in the
// binary; from there it is copied out once per user, since nothing execs
// a bunfs path.

import arm64 from '@anthropic-ai/sandbox-runtime/vendor/seccomp/arm64/apply-seccomp' with { type: 'file' }
import x64 from '@anthropic-ai/sandbox-runtime/vendor/seccomp/x64/apply-seccomp' with { type: 'file' }
import { type EmbeddedBinary, embeddedBinaryPath } from '../util/index.js'
import observeArm64 from './observe/vx-observe-arm64' with { type: 'file' }
import observeX64 from './observe/vx-observe-x64' with { type: 'file' }

const EMBEDDED: EmbeddedBinary = { x64, arm64 }
/** vx's own observer (`observe/vx-observe.c`), built by `scripts/build-observe.ts`. */
const OBSERVE: EmbeddedBinary = { x64: observeX64, arm64: observeArm64 }

let resolved: { path: string | undefined } | undefined
let observe: Promise<string | undefined> | undefined

/**
 * The helper's path for this machine, or undefined where SRT's own lookup
 * must do (another platform or architecture, no home to copy into).
 */
export async function applySeccompPath(): Promise<string | undefined> {
  resolved ??= { path: await embeddedBinaryPath(EMBEDDED) }
  return resolved.path
}

/** The observer's path for this machine, or undefined where there is none to run. */
export function observePath(): Promise<string | undefined> {
  observe ??= embeddedBinaryPath(OBSERVE)
  return observe
}
