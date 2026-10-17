// A symlink under a task's outputs is cached and restored as a link, as
// Turbo and Nx keep it (M's call, 2026-10-16): a link to a file came back
// as a copy of its target, and a link to a directory failed every save
// ("vx stores regular files only"), so a Next.js standalone or pnpm layout
// never hit. A link whose target leaves the workspace, or is absolute, is
// refused on save and on restore.

import {
  existsSync,
  lstatSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs'
import { mkdtempSync, mkdirSync } from 'node:fs'
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
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true })
})

async function workspace(command: string): Promise<{ root: string; dir: string }> {
  const root = await makeWorkspace({ prefix: 'vx-links-' })
  made.push(root)
  const dir = await addProject(root, 'app', {
    config: `export default { tasks: { build: {
      exec: { command: ${JSON.stringify(command)} },
      inputs: { files: ['src/**'] }, cache: { outputs: { files: ['dist/**'] } },
    } } }`,
    files: { 'src/in.txt': 'v1\n', '.gitignore': 'dist/\n' },
  })
  const git = gitIn(root)
  git('add', '-A')
  git('commit', '-q', '-m', 'init')
  return { root, dir }
}

const build = (root: string) =>
  vx(root, ['run', 'build', '--all', '--cache-dir', path.join(root, '.cache')])

async function ok(root: string): Promise<string> {
  const r = await build(root)
  expect(`${r.code}\n${r.err}`).toStartWith('0\n')
  return r.out + r.err
}

it.skipIf(process.platform === 'win32')(
  'a link to a file and a link to a directory come back as links',
  async () => {
    const { root, dir } = await workspace(
      'rm -rf dist && mkdir -p dist/sub && echo real > dist/real.txt && echo s > dist/sub/s.txt && ln -s real.txt dist/link.txt && ln -s sub dist/linkdir',
    )
    expect(await ok(root)).toContain('local 1↑')
    rmSync(path.join(dir, 'dist'), { recursive: true })
    expect(await ok(root)).toContain('1↓')
    expect(readlinkSync(path.join(dir, 'dist/link.txt'))).toBe('real.txt')
    expect(readlinkSync(path.join(dir, 'dist/linkdir'))).toBe('sub')
    expect(lstatSync(path.join(dir, 'dist/real.txt')).isFile()).toBe(true)
    // The tree a hit leaves is current: the next run restores nothing.
    expect(await ok(root)).toContain('local 1✓')
  },
  TIMEOUT,
)

it.skipIf(process.platform === 'win32')(
  'a link pointed elsewhere since the hit is put back, even at the same length',
  async () => {
    const { root, dir } = await workspace(
      'rm -rf dist && mkdir -p dist && echo a > dist/a.txt && echo b > dist/b.txt && ln -s a.txt dist/link.txt',
    )
    await ok(root)
    await ok(root)
    const link = path.join(dir, 'dist/link.txt')
    unlinkSync(link)
    symlinkSync('b.txt', link)
    await ok(root)
    expect(readlinkSync(link)).toBe('a.txt')
  },
  TIMEOUT,
)

it.skipIf(process.platform === 'win32')(
  'a link out of the workspace, or an absolute one, fails the save and names the link',
  async () => {
    const out = await workspace(
      'rm -rf dist && mkdir -p dist && ln -s ../../../../../etc/hosts dist/x',
    )
    const r = await build(out.root)
    expect(r.out + r.err).toMatch(
      /output dist\/x is a symlink to \.\.\/\.\.\/\.\.\/\.\.\/\.\.\/etc\/hosts, outside the workspace/,
    )
    const abs = await workspace(
      'rm -rf dist && mkdir -p dist && echo a > dist/a.txt && ln -s "$PWD/dist/a.txt" dist/x',
    )
    const r2 = await build(abs.root)
    expect(r2.out + r2.err).toMatch(/output dist\/x is a symlink to an absolute path/)
  },
  TIMEOUT,
)

async function artifact(meta: object): Promise<Uint8Array> {
  const body = JSON.stringify({ version: 1, files: {}, ...meta })
  const parts: Uint8Array[] = []
  for await (const c of tarPack([
    { name: 'stdout', size: 0, body: '' },
    { name: '.vx-meta.json', size: Buffer.byteLength(body), body },
  ])) {
    parts.push(c)
  }
  return withSum(new Uint8Array(await new Blob(parts).arrayBuffer()))
}

it.skipIf(process.platform === 'win32')(
  'an artifact whose link leaves the workspace restores nothing',
  async () => {
    const ws = mkdtempSync(path.join(os.tmpdir(), 'vx-links-x-'))
    made.push(ws)
    const dest = path.join(ws, 'app')
    mkdirSync(dest)
    for (const target of ['../../../outside', '/etc/hosts']) {
      const err = await extractArtifactStream(
        streamOf(await artifact({ links: { 'outputs/dist/ok': 'x', 'outputs/dist/bad': target } })),
        dest,
        ws,
        undefined,
        undefined,
        ws,
      ).then(
        () => null,
        (e: unknown) => e,
      )
      expect(String(err)).toContain('ArchiveSecurityError')
      expect(lstatSync(path.join(dest, 'dist/ok'), { throwIfNoEntry: false })).toBeUndefined()
    }
  },
)

// A tmpfs beside the disk: the only second filesystem a test reaches
// without a mount.
const otherFs =
  process.platform === 'linux' &&
  existsSync('/dev/shm') &&
  statSync('/dev/shm').dev !== statSync(os.tmpdir()).dev

it.skipIf(!otherFs)('a link restored across filesystems stays a link', async () => {
  // `.vx/tmp/` on the tmpfs, the outputs on the disk.
  const ws = mkdtempSync(path.join(os.tmpdir(), 'vx-links-fs-'))
  const staging = mkdtempSync(path.join('/dev/shm', 'vx-links-fs-'))
  made.push(ws, staging)
  mkdirSync(path.join(ws, '.vx'))
  symlinkSync(staging, path.join(ws, '.vx', 'tmp'))
  const dest = path.join(ws, 'app')
  await extractArtifactStream(
    streamOf(await artifact({ links: { 'outputs/dist/l': 'target.txt' } })),
    dest,
    ws,
    undefined,
    undefined,
    ws,
  )
  expect(readlinkSync(path.join(dest, 'dist/l'))).toBe('target.txt')
})
