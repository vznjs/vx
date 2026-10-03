// The workspace config's guard runs on every warm run, and reading every
// descriptor of `Bun` built its lazy members there (`postgres` loads
// `bun:sql`). It reads only the members vx itself reads, and keeps the
// keys and their order of the rest. These rows hold that list to the
// source, and the guard to its refusals.
import { readdirSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'bun:test'
import { loadWorkspaceConfig } from '../src/workspace/project-loader.js'

const SRC = path.join(import.meta.dir, '..', 'src')

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? sourceFiles(path.join(dir, e.name))
      : e.name.endsWith('.ts')
        ? [path.join(dir, e.name)]
        : [],
  )
}

it('the members the guard reads are every `Bun.<name>` src/ reads, no more', () => {
  const read = new Set<string>()
  for (const file of sourceFiles(SRC)) {
    for (const m of readFileSync(file, 'utf8').matchAll(/\bBun\.([A-Za-z_$][\w$]*)/g)) {
      read.add(m[1]!)
    }
  }
  const loader = readFileSync(path.join(SRC, 'workspace', 'project-loader.ts'), 'utf8')
  const list = /BUN_MEMBERS_VX_READS: readonly PropertyKey\[\] = \[([^\]]*)\]/.exec(loader)![1]!
  const listed = [...list.matchAll(/'([^']+)'/g)].map((m) => m[1]!)
  expect(listed).toEqual([...new Set(listed)])
  expect([...listed].sort()).toEqual([...read].sort())
})

async function load(source: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vx-ws-bun-'))
  try {
    await Bun.write(path.join(root, 'vx.workspace.mjs'), source)
    return await loadWorkspaceConfig(root).then(
      () => 'loaded',
      (err: Error) => err.message.replace(/^.*? changed (.*?) while it was evaluated.*$/s, '$1'),
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

it('a workspace config that replaces a member vx reads, or adds one, is put back and refused', async () => {
  const spawn = Bun.spawn
  expect(await load('Bun.spawn = () => null\nexport default {}\n')).toBe('Bun.spawn')
  expect(Bun.spawn).toBe(spawn)
  expect(await load('Bun.__vxWsProbe = 1\nexport default {}\n')).toBe('Bun.__vxWsProbe')
  expect('__vxWsProbe' in Bun).toBe(false)
})

it('CONTROL: a workspace config that changes nothing loads', async () => {
  expect(await load('export default { plugins: [] }\n')).toBe('loaded')
})
