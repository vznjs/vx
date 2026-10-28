// An empty directory a task leaves under its outputs comes back with a
// hit, as Turbo and Nx restore it (Growth's parity run, 2026-10-16): the
// artifact held regular files only, so `dist/empty/` was gone after a hit
// and the tree a hit left differed from the one a miss left.

import { existsSync, mkdirSync, mkdtempSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'bun:test'
import { extractArtifactStream } from '../src/cache/archive.js'
import { tarPack } from '../src/cache/tar-stream.js'
import { withSum } from './helpers/artifact-sum.js'
import { vx } from './helpers/parity.js'
import { streamOf } from './helpers/stream.js'
import { addProject, gitIn, makeWorkspace } from './helpers/workspace.js'

const TIMEOUT = 60_000
const made: string[] = []
afterEach(async () => {
  for (const d of made.splice(0)) await rm(d, { recursive: true, force: true })
})

async function workspace(outputs: string[]): Promise<{ root: string; dir: string }> {
  const root = await makeWorkspace({ prefix: 'vx-empty-dir-' })
  made.push(root)
  const dir = await addProject(root, 'app', {
    config: `
      export default {
        tasks: {
          build: {
            exec: { command: 'rm -rf dist && mkdir -p dist/empty dist/a/b && echo real > dist/real.txt' },
            inputs: { files: ['src/**'] }, cache: { outputs: { files: ${JSON.stringify(outputs)} } },
          },
        },
      }
    `,
    files: { 'src/in.txt': 'v1\n' },
  })
  const git = gitIn(root)
  git('add', '-A')
  git('commit', '-q', '-m', 'init')
  return { root, dir }
}

async function build(root: string): Promise<string> {
  const r = await vx(root, ['run', 'build', '--all', '--cache-dir', path.join(root, '.cache')])
  expect(`${r.code}\n${r.err}`).toStartWith('0\n')
  return r.out
}

it(
  'a hit restores the empty directories under the outputs',
  async () => {
    const { root, dir } = await workspace(['dist/**'])
    await build(root)
    await rm(path.join(dir, 'dist'), { recursive: true })
    expect(await build(root)).toContain('1↓')
    expect(statSync(path.join(dir, 'dist/empty')).isDirectory()).toBe(true)
    expect(statSync(path.join(dir, 'dist/a/b')).isDirectory()).toBe(true)
    expect(existsSync(path.join(dir, 'dist/real.txt'))).toBe(true)
  },
  TIMEOUT,
)

it(
  'a hit brings back an empty output directory removed on its own',
  async () => {
    const { root, dir } = await workspace(['dist/**'])
    await build(root)
    await build(root)
    await rm(path.join(dir, 'dist/empty'), { recursive: true })
    await build(root)
    expect(statSync(path.join(dir, 'dist/empty')).isDirectory()).toBe(true)
  },
  TIMEOUT,
)

it(
  'an empty directory no output glob reaches stays out of the artifact',
  async () => {
    const { root, dir } = await workspace(['dist/*.txt'])
    await build(root)
    await rm(path.join(dir, 'dist'), { recursive: true })
    await build(root)
    expect(existsSync(path.join(dir, 'dist/real.txt'))).toBe(true)
    expect(existsSync(path.join(dir, 'dist/empty'))).toBe(false)
  },
  TIMEOUT,
)

it(
  'a stale file in an output directory the entry holds empty goes, and the directory stays',
  async () => {
    const { root, dir } = await workspace(['dist/**'])
    await build(root)
    writeFileSync(path.join(dir, 'dist/empty/stale.txt'), 'x\n')
    await build(root)
    expect(existsSync(path.join(dir, 'dist/empty/stale.txt'))).toBe(false)
    expect(statSync(path.join(dir, 'dist/empty')).isDirectory()).toBe(true)
  },
  TIMEOUT,
)

/** An artifact whose sidecar lists `dirs`, beside one regular output. */
async function withDirs(dirs: unknown): Promise<Uint8Array> {
  const meta = JSON.stringify({ version: 1, files: {}, dirs })
  const parts: Uint8Array[] = []
  for await (const c of tarPack([
    { name: 'stdout', size: 0, body: '' },
    { name: 'outputs/dist/a.txt', size: 2, body: 'a\n' },
    { name: '.vx-meta.json', size: Buffer.byteLength(meta), body: meta },
  ]))
    parts.push(c)
  return withSum(new Uint8Array(await new Blob(parts).arrayBuffer()))
}

function tmp(): string {
  const d = mkdtempSync(path.join(os.tmpdir(), 'vx-empty-dir-x-'))
  made.push(d)
  return d
}

it('a sidecar directory that leaves the destination restores nothing', async () => {
  for (const bad of ['outputs/../../escape', '/abs', 'other/dir', 'outputs/a//b']) {
    const dest = path.join(tmp(), 'app')
    const err = await extractArtifactStream(streamOf(await withDirs([bad])), dest, undefined).then(
      () => null,
      (e: unknown) => e,
    )
    expect(String(err)).toContain('archive')
    expect(existsSync(path.join(dest, 'dist/a.txt'))).toBe(false)
  }
})

it('a sidecar directory under a link out of the destination is refused', async () => {
  const outside = tmp()
  const dest = path.join(tmp(), 'app')
  mkdirSync(dest)
  symlinkSync(outside, path.join(dest, 'gen'))
  const err = await extractArtifactStream(
    streamOf(await withDirs(['outputs/gen/made'])),
    dest,
    undefined,
  ).then(
    () => null,
    (e: unknown) => e,
  )
  expect(err).not.toBeNull()
  expect(existsSync(path.join(outside, 'made'))).toBe(false)
  expect(existsSync(path.join(dest, 'dist/a.txt'))).toBe(false)
})

it(
  'a hit restores the empty directories under a workspaceFiles output, as under files',
  async () => {
    // The save kept empty directories for project outputs only, though the
    // restore and the index already read `workspace-outputs/` ones.
    const root = await makeWorkspace({ prefix: 'vx-ws-empty-dir-' })
    made.push(root)
    await addProject(root, 'app', {
      config: `
        export default { tasks: { build: {
          exec: { command: 'cd ../.. && rm -rf gen && mkdir -p gen/empty && echo real > gen/real.txt' },
          inputs: { files: ['src/**'] }, cache: { outputs: { files: [], workspaceFiles: ['gen/**'] } },
        } } }`,
      files: { 'src/in.txt': 'v1\n' },
    })
    const git = gitIn(root)
    git('add', '-A')
    git('commit', '-q', '-m', 'init')
    const build = async (): Promise<string> => {
      const r = await vx(root, ['run', 'build', '--all', '--cache-dir', path.join(root, '.cache')])
      expect(`${r.code}\n${r.err}`).toStartWith('0\n')
      return r.out
    }
    await build()
    expect(statSync(path.join(root, 'gen/empty')).isDirectory()).toBe(true)
    await rm(path.join(root, 'gen'), { recursive: true })
    expect(await build()).toContain('1↓')
    expect(existsSync(path.join(root, 'gen/real.txt'))).toBe(true)
    expect(statSync(path.join(root, 'gen/empty')).isDirectory()).toBe(true)
    expect(await build()).toContain('1✓')
  },
  TIMEOUT,
)

it(
  'a stale file in a workspace output directory the entry holds empty goes, and the directory stays',
  async () => {
    const root = await makeWorkspace({ prefix: 'vx-ws-empty-stale-' })
    made.push(root)
    await addProject(root, 'app', {
      config: `
        export default { tasks: { build: {
          exec: { command: 'cd ../.. && rm -rf gen && mkdir -p gen/empty && echo real > gen/real.txt' },
          inputs: { files: ['src/**'] }, cache: { outputs: { files: [], workspaceFiles: ['gen/**'] } },
        } } }`,
      files: { 'src/in.txt': 'v1\n' },
    })
    const git = gitIn(root)
    git('add', '-A')
    git('commit', '-q', '-m', 'init')
    const build = async (): Promise<string> => {
      const r = await vx(root, ['run', 'build', '--all', '--cache-dir', path.join(root, '.cache')])
      expect(`${r.code}\n${r.err}`).toStartWith('0\n')
      return r.out
    }
    await build()
    writeFileSync(path.join(root, 'gen/empty/stale.txt'), 'stale\n')
    expect(await build()).toContain('1↓')
    expect(existsSync(path.join(root, 'gen/empty/stale.txt'))).toBe(false)
    expect(statSync(path.join(root, 'gen/empty')).isDirectory()).toBe(true)
    expect(existsSync(path.join(root, 'gen/real.txt'))).toBe(true)
  },
  TIMEOUT,
)

it(
  'a miss clears the empty directories an older build left, so its save does not keep them',
  async () => {
    // The clean took files and the directories it emptied; a directory
    // already empty stayed, and the save stored it, so every hit made it.
    const root = await makeWorkspace({ prefix: 'vx-empty-leftover-' })
    made.push(root)
    const dir = await addProject(root, 'app', {
      config: `
        export default { tasks: { build: {
          exec: { command: 'mkdir -p dist && cp src/in.txt dist/real.txt' },
          inputs: { files: ['src/**'] }, cache: { outputs: { files: ['dist/**'] } },
        } } }`,
      files: { 'src/in.txt': 'v1\n' },
    })
    const git = gitIn(root)
    git('add', '-A')
    git('commit', '-q', '-m', 'init')
    mkdirSync(path.join(dir, 'dist/old/inner'), { recursive: true })
    mkdirSync(path.join(dir, 'dist/gone'), { recursive: true })
    await build(root)
    expect(existsSync(path.join(dir, 'dist/old'))).toBe(false)
    expect(existsSync(path.join(dir, 'dist/gone'))).toBe(false)
    await rm(path.join(dir, 'dist'), { recursive: true })
    expect(await build(root)).toContain('1↓')
    expect(existsSync(path.join(dir, 'dist/real.txt'))).toBe(true)
    expect(existsSync(path.join(dir, 'dist/old'))).toBe(false)
    expect(existsSync(path.join(dir, 'dist/gone'))).toBe(false)
  },
  TIMEOUT,
)

it(
  'a miss clears the empty directories an older build left under a workspaceFiles output',
  async () => {
    const root = await makeWorkspace({ prefix: 'vx-ws-empty-leftover-' })
    made.push(root)
    await addProject(root, 'app', {
      config: `
        export default { tasks: { build: {
          exec: { command: 'cd ../.. && mkdir -p gen && echo real > gen/real.txt' },
          inputs: { files: ['src/**'] }, cache: { outputs: { files: [], workspaceFiles: ['gen/**'] } },
        } } }`,
      files: { 'src/in.txt': 'v1\n' },
    })
    const git = gitIn(root)
    git('add', '-A')
    git('commit', '-q', '-m', 'init')
    mkdirSync(path.join(root, 'gen/old/inner'), { recursive: true })
    await build(root)
    expect(existsSync(path.join(root, 'gen/old'))).toBe(false)
    await rm(path.join(root, 'gen'), { recursive: true })
    expect(await build(root)).toContain('1↓')
    expect(existsSync(path.join(root, 'gen/real.txt'))).toBe(true)
    expect(existsSync(path.join(root, 'gen/old'))).toBe(false)
  },
  TIMEOUT,
)

it(
  'a hit takes an empty directory the entry does not hold, as a miss does',
  async () => {
    // The hit's tree check compared files only, so a stray empty directory
    // left the tree "current" and stayed through every hit.
    const { root, dir } = await workspace(['dist/**'])
    await build(root)
    await build(root)
    mkdirSync(path.join(dir, 'dist/stray/inner'), { recursive: true })
    expect(await build(root)).toContain('1↓')
    expect(existsSync(path.join(dir, 'dist/stray'))).toBe(false)
    expect(statSync(path.join(dir, 'dist/empty')).isDirectory()).toBe(true)
    expect(statSync(path.join(dir, 'dist/a/b')).isDirectory()).toBe(true)
    expect(await build(root)).toContain('1✓')
  },
  TIMEOUT,
)

it(
  'a hit replaces an empty directory standing where the entry holds a file',
  async () => {
    // The directory matches the output globs, yet the restore failed the
    // task "blocked by what is on disk".
    const { root, dir } = await workspace(['dist/**'])
    await build(root)
    await rm(path.join(dir, 'dist/real.txt'))
    mkdirSync(path.join(dir, 'dist/real.txt'))
    expect(await build(root)).toContain('1↓')
    expect(statSync(path.join(dir, 'dist/real.txt')).isFile()).toBe(true)
  },
  TIMEOUT,
)

it(
  'a hit takes a stray empty directory under a workspaceFiles output',
  async () => {
    const root = await makeWorkspace({ prefix: 'vx-ws-empty-stray-' })
    made.push(root)
    await addProject(root, 'app', {
      config: `
        export default { tasks: { build: {
          exec: { command: 'cd ../.. && mkdir -p gen && echo real > gen/real.txt' },
          inputs: { files: ['src/**'] }, cache: { outputs: { files: [], workspaceFiles: ['gen/**'] } },
        } } }`,
      files: { 'src/in.txt': 'v1\n' },
    })
    const git = gitIn(root)
    git('add', '-A')
    git('commit', '-q', '-m', 'init')
    await build(root)
    mkdirSync(path.join(root, 'gen/stray'))
    expect(await build(root)).toContain('1↓')
    expect(existsSync(path.join(root, 'gen/stray'))).toBe(false)
    expect(existsSync(path.join(root, 'gen/real.txt'))).toBe(true)
  },
  TIMEOUT,
)
