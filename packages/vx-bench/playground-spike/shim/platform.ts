// The whole platform the playground bundle sees. The build rewrites every
// `Bun` and `process` global in core to `__vxBun` / `__vxProcess`
// (build.ts, `define`), so core's source is bundled unchanged and cannot
// reach the host's Bun or process even when the host has them. This module
// is the entry's first import, so both objects exist before any core
// module's top level runs (`util/timing.ts` reads both at load).
//
// What it provides, and why each is needed:
//   hash.xxHash3  — the key fold and the workspace fingerprint (xxh3.ts);
//   Glob          — `taskGlob` for input filtering and output overlap (glob.ts);
//   file          — manifests, lockfiles, workspace globs (the VFS);
//   nanoseconds   — `util/timing.ts` takes a start mark at module load;
//   process.env   — `cache.inputs.env` values, and `VX_TIMING` at load;
//   process.platform — `listProjects` picks its readdir strategy by it;
//   process.stderr — the scheduler's and discovery's warnings.
// Every call is counted in `platformCalls`.

import { Glob } from './glob.js'
import { vfs } from './vfs.js'
import { bunXxHash3 } from './xxh3.js'

export const platformCalls = new Map<string, number>()

function count(name: string): void {
  platformCalls.set(name, (platformCalls.get(name) ?? 0) + 1)
}

function file(p: string): {
  exists(): Promise<boolean>
  text(): Promise<string>
  bytes(): Promise<Uint8Array>
} {
  count('Bun.file')
  const bytes = async (): Promise<Uint8Array> => {
    const b = vfs().read(p)
    if (b === undefined) {
      throw Object.assign(new Error(`ENOENT: no such file or directory, open '${p}'`), {
        code: 'ENOENT',
      })
    }
    return b
  }
  return {
    // `Bun.file(<dir>).exists()` is false (CLAUDE.md), and core relies on it.
    exists: async () => vfs().stat(p)?.isFile() === true,
    text: async () => new TextDecoder().decode(await bytes()),
    bytes,
  }
}

function notInPlayground(name: string): () => never {
  return () => {
    throw new Error(`playground: ${name} is not available (the plan should not reach it)`)
  }
}

const env: Record<string, string | undefined> = {}

export const bun = {
  hash: {
    xxHash3(input: string | Uint8Array, seed?: bigint | number): bigint {
      count('Bun.hash.xxHash3')
      return bunXxHash3(input, seed)
    },
  },
  Glob: class extends Glob {
    constructor(pattern: string) {
      count('Bun.Glob')
      super(pattern)
    }
  },
  file,
  nanoseconds(): number {
    count('Bun.nanoseconds')
    return Math.round(performance.now() * 1e6)
  },
  spawn: notInPlayground('Bun.spawn'),
  spawnSync: notInPlayground('Bun.spawnSync'),
  CryptoHasher: notInPlayground('Bun.CryptoHasher'),
  write: notInPlayground('Bun.write'),
  version: 'playground',
}

export const proc = {
  env,
  platform: 'linux',
  argv: [] as string[],
  cwd: (): string => '/',
  stderr: {
    write(s: string): boolean {
      count('process.stderr.write')
      console.warn(s.trimEnd())
      return true
    },
  },
  stdout: {
    write(s: string): boolean {
      console.log(s.trimEnd())
      return true
    },
  },
}

/** Replace the virtual environment `cache.inputs.env` reads. */
export function setEnv(values: Record<string, string>): void {
  for (const k of Object.keys(env)) delete env[k]
  Object.assign(env, values)
}

;(globalThis as Record<string, unknown>).__vxBun = bun
;(globalThis as Record<string, unknown>).__vxProcess = proc
