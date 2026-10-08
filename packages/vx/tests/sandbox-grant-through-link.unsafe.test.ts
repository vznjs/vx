// A grant is mounted at its real path, and bwrap mounts no link: a grant
// spelled through a link in the project (`read: ['config.json']` over
// `config.json -> conf/real.json`) bound the target while the link the
// task opens was not there inside the sandbox. The trace judged the
// task's ENOENT by its real path, which the grant covers, so it was
// dropped: a tool that falls back on a missing file went green on the
// fallback and cached it.
import { realpathSync, symlinkSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { run } from '../src/orchestrator/index.js'
import { sandboxAvailable } from './helpers/sandbox-gate.js'
import { addProject, makeWorkspace } from './helpers/workspace.js'

const available = await sandboxAvailable('sandbox grant-through-link test')
const quiet = { status() {}, taskStdout() {}, taskStderr() {}, taskComplete() {} }

describe.skipIf(!available || process.platform !== 'linux')(
  'a grant spelled through a link in the project',
  () => {
    let root: string
    beforeEach(async () => {
      root = realpathSync(await makeWorkspace({ prefix: 'vx-grant-link-' }))
    })
    afterEach(async () => {
      await rm(`${root}-ln`, { force: true })
      await rm(root, { recursive: true, force: true })
    })

    const outcome = async (read: string[], file: string, write = ['out/'], after = '') => {
      const dir = await addProject(root, 'app', {
        config: `export default { tasks: { t: {
        exec: {
          command: '(cat ${file} 2>/dev/null || echo default) > out/r.txt${after}',
          sandbox: { allow: { read: ${JSON.stringify(read)}, write: ${JSON.stringify(write)} } },
        },
        cache: { inputs: { files: ['conf/**'] }, outputs: { files: ['out/**'] } },
      } } }\n`,
      })
      await mkdir(path.join(dir, 'conf'))
      await writeFile(path.join(dir, 'conf', 'real.json'), 'real\n')
      symlinkSync('conf/real.json', path.join(dir, 'config.json'))
      symlinkSync('conf', path.join(dir, 'lib'))
      const r = await run({ cwd: root, tasks: ['t'], log: quiet })
      const o = r.outcomes[0]!
      return [
        o.status,
        (o.sandboxViolations ?? 0) > 0,
        await readFile(path.join(dir, 'out', 'r.txt'), 'utf8').catch(() => ''),
      ]
    }

    it('a read the link hid is a violation, not a fallback cached green', async () => {
      expect(await outcome(['config.json'], 'config.json')).toEqual(['failed', true, 'default\n'])
    })

    it('CONTROL: the link inside a mounted directory reads through', async () => {
      expect(await outcome(['.'], 'config.json')).toEqual(['success', false, 'real\n'])
    })

    it('CONTROL: a file missing behind a hidden link is no violation', async () => {
      expect(await outcome(['lib'], 'lib/missing.json')).toEqual(['success', false, 'default\n'])
    })

    it('CONTROL: a file made after a missed read through a mounted link is no violation', async () => {
      expect(
        await outcome(['.'], 'lib/new.json', ['out/', 'conf/'], '; echo n > conf/new.json'),
      ).toEqual(['success', false, 'default\n'])
    })

    it('CONTROL: a link in the directory a file grant widened to is mounted', async () => {
      expect(
        await outcome(
          ['conf'],
          'lib/new.json',
          ['out/', 'conf/', 'x.txt'],
          '; echo n > conf/new.json',
        ),
      ).toEqual(['success', false, 'default\n'])
    })

    it('CONTROL: a link outside the workspace is mounted with the host', async () => {
      symlinkSync(path.join(root, 'packages', 'app', 'conf'), `${root}-ln`)
      expect(
        await outcome(
          ['conf'],
          `${root}-ln/new.json`,
          ['out/', 'conf/'],
          '; echo n > conf/new.json',
        ),
      ).toEqual(['success', false, 'default\n'])
    })
  },
)
