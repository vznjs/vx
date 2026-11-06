// A write grant naming a link in the project (`write: ['gen/']` over
// `gen -> real`) was bound at its real path, and bwrap mounts no link:
// with no read grant the task met "Directory nonexistent", and with
// `read: ['.']` the read-only bind of the link landed on the writable
// target, "Read-only file system". No violation, no fix, and a warning
// telling the user to move the write grant (`real`) out of `.`.
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
          o.sandboxViolations ?? 0,
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

    it('a link into a grant made by its real path is named, with the grant that writes through it', async () => {
      // The warning told the user to move the write grant out of `.`.
      const { got, warned } = await outcome({ read: ['.'], write: ['real/'] })
      const gen = path.join(root, 'packages', 'p', 'gen')
      expect(got[0], said).toBe('failed')
      expect(warned).toEqual([
        `[vx] sandbox: ${gen} is a symlink into the write grant ${path.join(root, 'packages', 'p', 'real')}, ` +
          `and the Linux sandbox mounts it read-only, so a write through it is refused. Grant ` +
          `the link itself to write through it: ${gen}/\n`,
      ])
      await rm(path.join(root, 'packages', 'p'), { recursive: true, force: true })
      const both = await outcome({ read: ['.'], write: ['real/', 'gen/'] })
      expect(both.got, said).toEqual(['success', 0, 'a\n'])
    })

    it('CONTROL: the grant by its real path lands', async () => {
      const { got } = await outcome({ read: ['.'], write: ['real/'] }, 'real')
      expect(got, said).toEqual(['success', 0, 'a\n'])
    })
  },
)
