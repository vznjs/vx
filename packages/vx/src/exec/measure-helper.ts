// A user's tsc reads this file but not our tsconfig's `include`: the reference
// brings the file-import declarations along (no import can name a script .d.ts).
// oxlint-disable-next-line typescript/triple-slash-reference
/// <reference path="./helper-files.d.ts" />
// Where `vx-measure` (measure/vx-measure.c) runs from: the one process per
// vx that forks every Linux task's shell, so its peak memory is its own, not
// vx's (docs/design/peak-memory-exact-2026-11.md).

import { embeddedBinaryPath } from '../util/index.js'
import arm64 from './measure/vx-measure-arm64' with { type: 'file' }
import x64 from './measure/vx-measure-x64' with { type: 'file' }

let resolving: Promise<string | undefined> | undefined
let resolved: string | undefined

/** The helper's path, resolved once; undefined off Linux or where it cannot run. */
export function measureHelper(): Promise<string | undefined> {
  resolving ??= embeddedBinaryPath({ x64, arm64 }).then((p) => (resolved = p))
  return resolving
}

/** The path `measureHelper` resolved, without waiting: undefined until it has. */
export function measureHelperNow(): string | undefined {
  return resolved
}
