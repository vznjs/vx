// A write grant naming a link in the project (`write: ['gen/']` over
// `gen -> real`) was bound at its real path, and bwrap mounts no link:
// with no read grant the task met "Directory nonexistent", and with
// `read: ['.']` the read-only bind of the link landed on the writable
// target, "Read-only file system". No violation, no fix, and a warning
// telling the user to move the write grant (`real`) out of `.`. A link a
// read grant's punch meets is laid as a link now (`punchedLinks`).
import { realpathSync, symlinkSync } from 'node:fs'
import { mkdir, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { run } from './helpers/orchestrator.js'
import { sandboxAvailable } from './helpers/sandbox-gate.js'
import { addProject, makeWorkspace } from './helpers/workspace.js'

const available = await sandboxAvailable('sandbox write-through-link test')
let said = ''
const log = {
  status() {},
  taskStdout(_n: unknown, s: string) {
    said += s
  },
  taskStderr(_n: unknown, s: string) {
    said += s
  },
  taskComplete() {},
}

describe.skipIf(!available || process.platform !== 'linux')(
  'a write grant naming a link in the project',
  () => {
    let root: string
    beforeEach(async () => {
      root = realpathSync(await makeWorkspace({ prefix: 'vx-write-link-' }))
    })
    afterEach(async () => {
      await rm(root, { recursive: true, force: true })
    })

    const outcome = async (allow: object, to = 'gen') => {
      const dir = await addProject(root, 'p', {
        config: `export default { tasks: { t: {
        exec: { command: 'echo a > ${to}/f.txt', sandbox: { allow: ${JSON.stringify(allow)} } },
        inputs: { files: [] },
      } } }\n`,
      })
      await mkdir(path.join(dir, 'real'))
      symlinkSync('real', path.join(dir, 'gen'))
      said = ''
      const warned: string[] = []
      const spy = spyOn(process.stderr, 'write').mockImplementation((s: string | Uint8Array) => {
        warned.push(String(s))
        return true
      })
      let r
      try {
        r = await run({ cwd: root, tasks: ['t'], log })
      } finally {
        spy.mockRestore()
      }
      const o = r.outcomes[0]!
      return {
        got: [
          o.status,
          o.sandbox?.violations ?? 0,
          await readFile(path.join(dir, 'real', 'f.txt'), 'utf8').catch(() => ''),
        ],
        warned: warned.filter((w) => w.includes('symlink')),
      }
    }

    it('lands with no read grant', async () => {
      const { got } = await outcome({ write: ['gen/'] })
      expect(got, said).toEqual(['success', 0, 'a\n'])
    })

    it('lands under a read grant of the project, with no warning about symlinked entries', async () => {
      const { got, warned } = await outcome({ read: ['.'], write: ['gen/'] })
      expect(got, said).toEqual(['success', 0, 'a\n'])
      expect(warned).toEqual([])
    })

    it('lands as a file grant, a directory whole and a directory under the link', async () => {
      for (const write of [['gen/f.txt'], ['gen/**']]) {
        await rm(path.join(root, 'packages', 'p'), { recursive: true, force: true })
        const { got } = await outcome({ read: ['.'], write })
        expect(got, `${write.join()}: ${said}`).toEqual(['success', 0, 'a\n'])
      }
      await rm(path.join(root, 'packages', 'p'), { recursive: true, force: true })
      const { got } = await outcome({ write: ['gen/sub/'] }, 'gen/sub')
      expect(got[0], said).toBe('success')
      expect(await readFile(path.join(root, 'packages', 'p', 'real', 'sub', 'f.txt'), 'utf8')).toBe(
        'a\n',
      )
    })

    it('a link into a grant made by its real path writes through it', async () => {
      // The link was bound read-only over the writable target, and a
      // warning told the user to move the write grant out of `.`.
      const { got, warned } = await outcome({ read: ['.'], write: ['real/'] })
      expect(got, said).toEqual(['success', 0, 'a\n'])
      expect(warned).toEqual([])
    })

    it('a write grant under node_modules keeps its linked packages links', async () => {
      // pnpm's layout: every package a link into a store beside it, and
      // `tsc -b` writes `node_modules/.tmp/*.tsbuildinfo`. The punch around
      // that grant bound each link as the directory it points at, so a
      // package resolving a sibling through `..` found none (vite: `Cannot
      // find package 'picomatch'`), and a warning said to move the grant.
      const dir = await addProject(root, 'p', {
        config: `export default { tasks: { t: {
        exec: { command: 'cat node_modules/pkg/../dep/f && echo b > node_modules/.tmp/t.info', sandbox: { allow: { read: ['.'], write: ['node_modules/.tmp/t.info'] } } },
        inputs: { files: [] },
      } } }\n`,
        files: { 'node_modules/.store/pkg/index.js': '', 'node_modules/.store/dep/f': 'a\n' },
      })
      await mkdir(path.join(dir, 'node_modules', '.tmp'))
      symlinkSync('.store/pkg', path.join(dir, 'node_modules', 'pkg'))
      said = ''
      const warned: string[] = []
      const spy = spyOn(process.stderr, 'write').mockImplementation((s: string | Uint8Array) => {
        warned.push(String(s))
        return true
      })
      let r
      try {
        r = await run({ cwd: root, tasks: ['t'], log })
      } finally {
        spy.mockRestore()
      }
      expect(r.outcomes[0]!.status, said).toBe('success')
      expect(said).toContain('a\n')
      expect(await readFile(path.join(dir, 'node_modules', '.tmp', 't.info'), 'utf8')).toBe('b\n')
      expect(warned.filter((w) => w.includes('symlink'))).toEqual([])
    })

    it('CONTROL: the grant by its real path lands', async () => {
      const { got } = await outcome({ read: ['.'], write: ['real/'] }, 'real')
      expect(got, said).toEqual(['success', 0, 'a\n'])
    })
  },
)
