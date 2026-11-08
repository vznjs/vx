// A project's input glob whose fixed prefix lies inside a nested project
// keys nothing: the nested project's files are never another project's
// inputs. A `dist/**` input over a build output that holds its own project
// config was silently dropped from the key, and edits there hit. `vx lock`
// refuses it, naming the nested project and the workspaceFiles spelling.
// An output glob there saves nothing for the same reason: the run warned
// "outputs matched no files" over a file it had written, and the nested
// project's artifact could hold the outer task's bytes.
// A directory holding its own `.vx/workspace.*` is a boundary for outputs
// only: the clean before a run deleted its untracked files. An input glob
// still folds its files, as a task may read them (a git worktree checked
// out under `src/` holds one): an extra miss, never a stale hit.

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'bun:test'
import { LOCKFILE_NAME } from '../src/workspace/index.js'
import { lock, run } from './helpers/orchestrator.js'
import { silentLogger } from './helpers/orchestrator-fixture.js'
import { addProject, makeWorkspace } from './helpers/workspace.js'

const roots: string[] = []
afterEach(async () => {
  for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true })
})

async function workspace(inputs: string[], outputs: string[] = []): Promise<string> {
  const root = await makeWorkspace({ prefix: 'vx-nested-input-', workspaceFile: false })
  roots.push(root)
  await addProject(root, 'a', {
    config: `export default { tasks: { build: {
  exec: { command: 'true' },
  inputs: { files: ${JSON.stringify(inputs)} },
  outputs: { files: ${JSON.stringify(outputs)} },
  cache: true,
} } }
`,
    files: { 'src/a.ts': 'a', 'dist/d.txt': 'd', 'distx/e.txt': 'e' },
  })
  await writeFile(
    path.join(root, 'packages/a/dist/vx.config.mjs'),
    "export default { tasks: { x: { exec: { command: 'true' } } } }\n",
  )
  return root
}

async function lockError(root: string): Promise<string | null> {
  try {
    await lock(root)
    return null
  } catch (err) {
    return (err as Error).message
  }
}

describe('an input under a nested project', () => {
  it('is refused at lock, naming the project and the workspaceFiles glob', async () => {
    const msg = await lockError(await workspace(['src/**', 'dist/**']))
    expect(msg).toContain(
      'packages/a#build reads "dist/**" in inputs.files, which lies inside the project packages/a/dist',
    )
    expect(msg).toContain('inputs.workspaceFiles ("packages/a/dist/**")')
  })

  it('is refused as a literal file and as the directory itself', async () => {
    expect(await lockError(await workspace(['dist/d.txt']))).toContain(
      '"dist/d.txt" in inputs.files',
    )
    expect(await lockError(await workspace(['dist']))).toContain('"dist" in inputs.files')
  })

  it('is refused in one alternative of a brace', async () => {
    expect(await lockError(await workspace(['{src,dist}/**']))).toContain(
      '"{src,dist}/**" in inputs.files',
    )
  })

  it('is no refusal for a glob that only reaches past it, a sibling or a negation', async () => {
    expect(await lockError(await workspace(['**']))).toBeNull()
    expect(await lockError(await workspace(['distx/**', 'src/**']))).toBeNull()
    expect(await lockError(await workspace(['**', '!dist/**']))).toBeNull()
  })
})

describe('an output under a nested project', () => {
  it('is refused at lock, naming the project and the workspaceFiles glob', async () => {
    const msg = await lockError(await workspace(['src/**'], ['out/**', 'dist/o/**']))
    expect(msg).toContain(
      'packages/a#build writes "dist/o/**" in outputs.files, which lies inside the project packages/a/dist',
    )
    expect(msg).toContain('outputs.workspaceFiles ("packages/a/dist/o/**")')
  })

  it('is refused in one alternative of a brace', async () => {
    expect(await lockError(await workspace(['src/**'], ['{out,dist}/**']))).toContain(
      '"{out,dist}/**" in outputs.files',
    )
  })

  it('is no refusal for a sibling or a negation', async () => {
    expect(await lockError(await workspace(['src/**'], ['distx/**']))).toBeNull()
    expect(await lockError(await workspace(['src/**'], ['out/**', '!dist/**']))).toBeNull()
  })
})

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
const silent = silentLogger({ root: '', log: [], err: [] })

/** `packages/a` declaring `files`, holding `inner`, a workspace of its own with an uncommitted project. */
async function nestedWorkspace(inputs: string[], outputs: string[]): Promise<string> {
  const root = await makeWorkspace({ prefix: 'vx-nested-ws-', workspaceFile: false })
  roots.push(root)
  await addProject(root, 'a', {
    config: `export default { tasks: { build: {
  exec: { command: 'mkdir -p out && echo o > out/o.txt' },
  inputs: { files: ${JSON.stringify(inputs)} },
  outputs: { files: ${JSON.stringify(outputs)} },
  cache: true,
} } }
`,
    files: { 'src/a.txt': 'a' },
  })
  const inner = path.join(root, 'packages/a/inner')
  await mkdir(path.join(inner, '.vx'), { recursive: true })
  await mkdir(path.join(inner, 'p/src'), { recursive: true })
  await writeFile(path.join(inner, '.vx/workspace.mjs'), 'export default {}\n')
  await writeFile(
    path.join(inner, 'p/vx.config.mjs'),
    "export default { tasks: { t: { exec: { command: 'true' } } } }\n",
  )
  await writeFile(path.join(inner, 'p/src/work.txt'), 'precious')
  return root
}

describe('a nested workspace', () => {
  it('is out of an outer output glob: the clean before a run leaves its files', async () => {
    const root = await nestedWorkspace(['src/**'], ['**/*.txt', '!src/**'])
    const r = await run({ cwd: root, tasks: ['packages/a#build'], log: silent })
    expect(r.outcomes.map((o) => o.status)).toEqual(['success'])
    const inner = path.join(root, 'packages/a/inner')
    expect(await readFile(path.join(inner, 'p/src/work.txt'), 'utf8')).toBe('precious')
    expect(await Bun.file(path.join(inner, '.vx/workspace.mjs')).exists()).toBe(true)
  })

  it('is in an outer input glob: an edit in it re-keys the task', async () => {
    const root = await nestedWorkspace(['**'], ['out/**'])
    expect(
      (await run({ cwd: root, tasks: ['packages/a#build'], log: silent })).outcomes[0]!.status,
    ).toBe('success')
    await writeFile(path.join(root, 'packages/a/inner/p/src/work.txt'), 'edited')
    expect(
      (await run({ cwd: root, tasks: ['packages/a#build'], log: silent })).outcomes[0]!.status,
    ).toBe('success')
  })

  it('is refused at lock as an output glob rooted in it, not as an input one', async () => {
    expect(await lockError(await nestedWorkspace(['src/**'], ['inner/**']))).toContain(
      'packages/a#build writes "inner/**" in outputs.files, which lies inside the workspace packages/a/inner',
    )
    expect(await lockError(await nestedWorkspace(['inner/p/**'], ['out/**']))).toBeNull()
  })

  it('is in the lock, and a lock without it is stale', async () => {
    const root = await nestedWorkspace(['src/**'], ['out/**'])
    await lock(root)
    const file = path.join(root, LOCKFILE_NAME)
    const locked = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>
    expect(locked['nestedWorkspaces']).toEqual(['packages/a/inner'])
    delete locked['nestedWorkspaces']
    await writeFile(file, JSON.stringify(locked))
    const check = Bun.spawnSync({
      cmd: [process.execPath, BIN, 'lock', '--check'],
      cwd: root,
      env: { ...process.env, VX_LOCK_REVIEW_FILES: 'false', NO_COLOR: '1' },
    })
    expect(check.exitCode).toBe(1)
    expect(check.stderr.toString()).toContain('packages/a/inner')
  })
})
