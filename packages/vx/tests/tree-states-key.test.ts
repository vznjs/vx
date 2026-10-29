// The key follows the working tree through every state git can report an
// input in, under a workspace path holding a space: untracked, committed,
// modified, deleted, renamed (staged, and renamed and modified), a name
// holding a space, a quote, a tab, a newline or a non-ASCII letter, and a
// tracked file replaced by a directory. Committing a file never moves the
// key, and the same bytes key the same whatever git says about them. A
// hasher that read git's output by line, trusted a stale index entry or
// dropped a deleted path keyed one of these as another.
//
// The second scenario keys 12,000 files whose paths come to 2.5 MB, past
// what one argv may carry: a hasher passing them to git as arguments
// failed with E2BIG, one reading git's output into a fixed buffer
// truncated it.
import { mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { addProject, gitIn, makeWorkspace } from './helpers/workspace.js'
import { dry } from './helpers/parity.js'

const TIMEOUT = 60_000
const CONFIG = `export default {
  tasks: {
    build: { exec: { command: 'true' }, inputs: { files: ['src/**'] }, cache: { outputs: { files: [] } } },
  },
}
`

async function key(root: string): Promise<string> {
  const [t] = await dry(root, ['a#build'])
  return t!.hash
}

describe('the key across working-tree states', () => {
  let parent = ''
  let root = ''
  let src = ''
  beforeAll(async () => {
    parent = await mkdtemp(path.join(os.tmpdir(), 'vx tree states '))
    root = await makeWorkspace({ dir: parent, prefix: 'sp ace-', edges: {} })
    src = path.join(
      await addProject(root, 'a', { config: CONFIG, files: { 'src/x.txt': 'x\n' } }),
      'src',
    )
    const git = gitIn(root)
    git('add', '-A')
    git('commit', '-q', '-m', 'init')
  }, TIMEOUT)
  afterAll(async () => {
    await rm(parent, { recursive: true, force: true })
  })

  it(
    'each state keys apart, a commit moves nothing, and the same bytes key the same',
    async () => {
      const git = gitIn(root)
      const commit = () => git('commit', '-q', '-am', 'step', '--allow-empty')
      const seen = new Map<string, string>()
      const step = async (name: string): Promise<string> => {
        const k = await key(root)
        for (const [other, h] of seen) if (h === k) throw new Error(`${name} keys as ${other}`)
        seen.set(name, k)
        return k
      }
      await step('base')

      await writeFile(path.join(src, 'with space.txt'), 'one\n')
      const untracked = await step('untracked')
      git('add', '-A')
      commit()
      expect(await key(root)).toBe(untracked)

      await writeFile(path.join(src, 'with space.txt'), 'two\n')
      await step('modified')
      git('add', '-A')
      commit()

      git('mv', 'packages/a/src/with space.txt', 'packages/a/src/renamed sp.txt')
      await step('renamed')
      await writeFile(path.join(src, 'renamed sp.txt'), 'three\n')
      git('add', '-A')
      await step('renamed and modified')
      commit()

      await unlink(path.join(src, 'x.txt'))
      const deleted = await step('deleted')
      git('add', '-A')
      commit()
      expect(await key(root)).toBe(deleted)

      for (const name of ['qu"ote\ttab é.txt', 'new\nline.txt']) {
        await writeFile(path.join(src, name), `${name}\n`)
      }
      const unusual = await step('unusual names')
      git('add', '-A')
      commit()
      expect(await key(root)).toBe(unusual)
      await writeFile(path.join(src, 'new\nline.txt'), 'edited\n')
      await step('unusual name modified')
      git('checkout', '--', '.')
      expect(await key(root)).toBe(unusual)

      await unlink(path.join(src, 'renamed sp.txt'))
      await mkdir(path.join(src, 'renamed sp.txt'))
      await writeFile(path.join(src, 'renamed sp.txt', 'inner.txt'), 'three\n')
      await step('file replaced by a directory')

      await rm(path.join(src, 'renamed sp.txt'), { recursive: true })
      git('checkout', '--', '.')
      expect(await key(root)).toBe(unusual)
    },
    TIMEOUT,
  )
})

describe('the key over more paths than one argv holds', () => {
  let root = ''
  let src = ''
  const COUNT = 12_000
  // 200-byte names: 12,000 of them are 2.5 MB of paths, past ARG_MAX (2 MB).
  const name = (i: number) => `${String(i).padStart(6, '0')}-${'n'.repeat(190)}.txt`
  beforeAll(async () => {
    root = await makeWorkspace({ prefix: 'vx-tree-many-', edges: {} })
    src = path.join(await addProject(root, 'a', { config: CONFIG }), 'src')
    await mkdir(src, { recursive: true })
    for (let i = 0; i < COUNT; i += 1000) {
      await Promise.all(
        Array.from({ length: Math.min(1000, COUNT - i) }, (_, j) =>
          writeFile(path.join(src, name(i + j)), `${i + j}\n`),
        ),
      )
    }
  }, TIMEOUT)
  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it(
    'keys them untracked, keys the same once committed, and one edit moves the key',
    async () => {
      const untracked = await key(root)
      const git = gitIn(root)
      git('add', '-A')
      git('commit', '-q', '-m', 'many')
      expect(await key(root)).toBe(untracked)
      await writeFile(path.join(src, name(COUNT - 1)), 'edited\n')
      expect(await key(root)).not.toBe(untracked)
    },
    TIMEOUT,
  )
})
