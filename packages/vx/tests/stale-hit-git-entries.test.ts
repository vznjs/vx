// Index entries whose blob says less than the file: a symlink and a regular
// file with the same bytes share one blob OID, and an unmerged path has no
// stage-0 entry at all. Each must key on what the task reads.

import { mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { writeLocalWorkspace } from './helpers/local-workspace.js'
import { git, gitInit } from './helpers/workspace.js'
import { vxSync } from './helpers/vx.js'

const TIMEOUT = 60_000
const vx = (cwd: string, ...args: string[]) => vxSync(cwd, args).text

let root: string

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vx-stale-entries-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function fixture(command: string): Promise<void> {
  await Bun.write(path.join(root, 'package.json'), '{"name":"r","private":true}')
  await writeLocalWorkspace(root)
  await Bun.write(
    path.join(root, 'a/vx.config.mjs'),
    `export default { tasks: { build: {
       exec: { command: ${JSON.stringify(command)} },
       inputs: { files: ['src/**'] }, outputs: { files: ['out.txt'] }, cache: true,
     } } }`,
  )
  await Bun.write(path.join(root, '.gitignore'), '.vx/cache/\nout.txt\n')
}

const out = () => readFile(path.join(root, 'a/out.txt'), 'utf8')

describe('index entries a blob OID alone does not describe', () => {
  it(
    'a file turned into a symlink holding the same bytes moves the key',
    async () => {
      await fixture('if [ -L src/l ]; then echo link; else echo file; fi > out.txt')
      await Bun.write(path.join(root, 'a/src/x.txt'), 'x')
      // The link's blob is its target, `x.txt`: the same bytes as this file.
      await Bun.write(path.join(root, 'a/src/l'), 'x.txt')
      gitInit(root)
      git(root, 'add', '-A')
      git(root, 'commit', '-q', '-m', 'initial')
      expect(vx(root, 'lock')).not.toMatch(/✗/)
      vx(root, 'run', 'a#build')
      expect(await out()).toBe('file\n')

      await unlink(path.join(root, 'a/src/l'))
      await symlink('x.txt', path.join(root, 'a/src/l'))
      vx(root, 'run', 'a#build')
      expect(await out()).toBe('link\n')
      git(root, 'commit', '-q', '-am', 'link')
      expect(vx(root, 'run', 'a#build')).toMatch(/a#build[^\n]*up-to-date/)
      expect(await out()).toBe('link\n')

      await unlink(path.join(root, 'a/src/l'))
      await writeFile(path.join(root, 'a/src/l'), 'x.txt')
      vx(root, 'run', 'a#build')
      expect(await out()).toBe('file\n')
    },
    TIMEOUT,
  )

  it(
    'a path left unmerged by a conflict keys on its file, markers and resolution alike',
    async () => {
      await fixture('cat src/x.txt > out.txt')
      const file = path.join(root, 'a/src/x.txt')
      await Bun.write(file, 'base\n')
      gitInit(root)
      git(root, 'add', '-A')
      git(root, 'commit', '-q', '-m', 'initial')
      git(root, 'branch', '-M', 'main')
      git(root, 'checkout', '-q', '-b', 'other')
      await writeFile(file, 'theirs\n')
      git(root, 'commit', '-q', '-am', 'theirs')
      git(root, 'checkout', '-q', 'main')
      await writeFile(file, 'ours\n')
      git(root, 'commit', '-q', '-am', 'ours')
      expect(vx(root, 'lock')).not.toMatch(/✗/)
      vx(root, 'run', 'a#build')
      expect(await out()).toBe('ours\n')

      expect(() => git(root, 'merge', '-q', 'other')).toThrow()
      expect(git(root, 'status', '--porcelain')).toMatch(/^UU a\/src\/x.txt$/m)
      vx(root, 'run', 'a#build')
      expect(await out()).toBe(await readFile(file, 'utf8'))
      expect(await out()).toContain('<<<<<<<')

      await writeFile(file, 'ours\n')
      vx(root, 'run', 'a#build')
      expect(await out()).toBe('ours\n')
      await writeFile(file, 'resolved\n')
      vx(root, 'run', 'a#build')
      expect(await out()).toBe('resolved\n')
    },
    TIMEOUT,
  )
})
