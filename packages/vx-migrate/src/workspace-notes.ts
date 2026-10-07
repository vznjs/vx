// What the written configs leave to vx.workspace.ts, said once by both
// migrators: the adoption plugin `vx init` declared still reads the old
// tool's file every run, and the old tool keyed each package on its own
// lockfile entries where core keys every task on the whole lockfile.
// Without a lockfile plugin a dependency bump re-ran every task (hey-api:
// a `pnpm-lock.yaml` edit re-keyed all 42 builds, none with `pnpm()`).

import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'

/** Each lockfile and the `@vzn/vx-lockfile` plugin that claims it. */
const LOCKFILES: ReadonlyArray<readonly [file: string, plugin: string]> = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
  ['package-lock.json', 'npm'],
  ['npm-shrinkwrap.json', 'npm'],
  ['yarn.lock', 'yarn'],
]

/** The lockfile at `root` and the `@vzn/vx-lockfile` factory that claims it. */
export function lockfilePlugin(root: string): { file: string; factory: string } | undefined {
  const lock = LOCKFILES.find(([file]) => existsSync(path.join(root, file)))
  return lock === undefined ? undefined : { file: lock[0], factory: lock[1] }
}

interface AdoptedTool {
  /** The adoption plugin `vx init` declares: `turbo`, `nx`. */
  readonly plugin: string
  /** The file it reads every run: `turbo.json`, `nx.json`. */
  readonly config: string
  /** How the tool keys a package on the lockfile, as the note's opening. */
  readonly keys: (lockfile: string) => string
  /** What `vx run` replaces, in the note: `turbo`, `nx`. */
  readonly runner: string
}

export async function adoptedToolNotes(root: string, tool: AdoptedTool): Promise<string[]> {
  const notes: string[] = []
  let declared = ''
  for (const name of readdirSync(root)) {
    if (!/^vx\.workspace\.(ts|mts|js|mjs|cts|cjs)$/.test(name)) continue
    declared = await Bun.file(path.join(root, name)).text()
    if (new RegExp(`\\b${tool.plugin}\\s*\\(`).test(declared))
      notes.push(
        `${name} still declares ${tool.plugin}(), which reads ${tool.config} every run and fills any task ` +
          'a vx.config does not declare; the configs written here declare them all. Once ' +
          `\`vx run\` does what ${tool.runner} did, remove ${tool.plugin}() (and its import), then ${tool.config}`,
      )
    break
  }
  const lock = lockfilePlugin(root)
  if (lock !== undefined && !new RegExp(`\\b${lock.factory}\\s*\\(`).test(declared))
    notes.push(
      `${tool.keys(lock.file)}; vx keys every task on the whole ` +
        `file, so a dependency bump re-runs them all. Declare ${lock.factory}() from @vzn/vx-lockfile ` +
        "in vx.workspace.ts to key each task on its package's dependency closure",
    )
  return notes
}
