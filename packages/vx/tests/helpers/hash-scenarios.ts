// The workspace and key reads hash-scenarios*.test.ts share: one file was
// a 41 s shard of its own (2026-11-07), so it is two.

import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { dry } from './parity.js'
import { addProject, gitIn, makeWorkspace } from './workspace.js'

/** Directories a test made; each file's `afterEach` removes them. */
export const made: string[] = []

/** A cached task over `inputs`, as config source. */
export const task = (inputs: string) =>
  `{ exec: { command: 'true' }, inputs: ${inputs}, outputs: { files: [] }, cache: true }`

/** A workspace with project `lib` (tasks `t`, …) and `files` beside it, committed. */
export async function workspace(
  inputs: string,
  files: Record<string, string>,
  root: Record<string, string> = {},
  opts: { dir?: string; edges?: Record<string, string[]> } = {},
): Promise<string> {
  const ws = await makeWorkspace({ prefix: 'vx-hash-scen-', ...opts })
  made.push(ws)
  await addProject(ws, 'lib', {
    config: `export default { tasks: { t: ${task(inputs)} } }\n`,
    files,
  })
  for (const [rel, body] of Object.entries({ '.gitignore': '.vx/cache/\n', ...root })) {
    await mkdir(path.dirname(path.join(ws, rel)), { recursive: true })
    await writeFile(path.join(ws, rel), body)
  }
  const git = gitIn(ws)
  git('add', '-A')
  git('commit', '-q', '-m', 'init')
  return ws
}

export async function key(root: string, env: Record<string, string> = {}): Promise<string> {
  const t = (await dry(root, ['lib#t'], env)).find((x) => x.id === 'lib#t')
  if (t === undefined) throw new Error('lib#t not planned')
  return t.hash
}

export const at = (root: string, rel: string) => path.join(root, 'packages', 'lib', rel)
