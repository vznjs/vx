// A link in the project to a directory of another project (`shared ->
// ../lib/shared`), read through (`cat shared/s.json`). The punch dropped the
// link unless a grant held its whole target, so with the project and the
// file itself granted the read still failed, with no violation and no hint.
// With the file granted and the project not, the hint named the granted
// file again: applied as given, nothing changed, and it named it again.
import { realpathSync, symlinkSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { run } from './helpers/orchestrator.js'
import { sandboxAvailable } from './helpers/sandbox-gate.js'
import { addProject, makeWorkspace } from './helpers/workspace.js'

const available = await sandboxAvailable('sandbox link-out-of-project test')
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
  "a link to another project's directory, read through",
  () => {
    let root: string
    beforeEach(async () => {
      root = realpathSync(await makeWorkspace({ prefix: 'vx-link-out-' }))
    })
    afterEach(async () => {
      await rm(root, { recursive: true, force: true })
    })

    const outcome = async (read: string[]) => {
      await addProject(root, 'lib', { files: { 'shared/s.json': 'shared\n', 'other.txt': 'x\n' } })
      const dir = await addProject(root, 'app', {
        config: `export default { tasks: { t: {
        exec: {
          command: 'mkdir -p out && cat shared/s.json > out/r.txt',
          sandbox: { allow: { read: ${JSON.stringify(read)}, write: ['out/'] } },
        },
        inputs: { files: ['src/**'], workspaceFiles: ['packages/lib/shared/s.json'] },
        outputs: { files: ['out/**'] }, cache: true,
      } } }\n`,
        files: { 'src/a.txt': 'a\n' },
      })
      symlinkSync('../lib/shared', path.join(dir, 'shared'))
      said = ''
      const r = await run({ cwd: root, tasks: ['t'], log })
      const o = r.outcomes[0]!
      return {
        sandbox: JSON.stringify(o.sandbox),
        status: o.status,
        fix: o.sandbox?.fix?.read,
        out: await readFile(path.join(dir, 'out', 'r.txt'), 'utf8').catch(() => ''),
      }
    }

    it('reads through once the project and the file behind it are granted', async () => {
      const o = await outcome(['.', '../lib/shared/s.json'])
      expect([o.status, o.out], said).toEqual(['success', 'shared\n'])
    })

    it('with the file granted, the fix grants the directory holding the link', async () => {
      const o = await outcome(['src/', '../lib/shared/s.json'])
      expect([o.status, o.fix], `${said}\n${o.sandbox}`).toEqual([
        'failed',
        ['.', '../lib/shared/s.json'],
      ])
    })

    it('CONTROL: the link still grants nothing behind it beyond the grants', async () => {
      await addProject(root, 'lib', {
        files: { 'shared/s.json': 'shared\n', 'shared/t.json': 't\n' },
      })
      const dir = await addProject(root, 'app', {
        config: `export default { tasks: { t: {
        exec: {
          command: 'mkdir -p out && (cat shared/t.json 2>/dev/null || echo hidden) > out/r.txt',
          sandbox: { allow: { read: ['.', '../lib/shared/s.json'], write: ['out/'] } },
        },
      } } }\n`,
      })
      symlinkSync('../lib/shared', path.join(dir, 'shared'))
      await run({ cwd: root, tasks: ['t'], log })
      expect(await readFile(path.join(dir, 'out', 'r.txt'), 'utf8')).toBe('hidden\n')
    })
  },
)
