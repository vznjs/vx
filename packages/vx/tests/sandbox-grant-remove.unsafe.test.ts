// `rm -rf dist && tsc` under `write: ['dist/']` (X-90). On Linux the grant
// is a bind mount, which the task can empty but not remove: rm failed with
// "Read-only file system", naming neither vx nor the grant. The failure
// now carries a hint naming the grant and the removal that works.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { existsSync, readdirSync, realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  initSandbox,
  resetSandbox,
  resolveSandboxConfig,
  runSandboxed,
} from '../src/sandbox/runtime.js'
import { run as runVx } from './helpers/orchestrator.js'
import { sandboxAvailable } from './helpers/sandbox-gate.js'
import { addProject, makeWorkspace } from './helpers/workspace.js'

const available = await sandboxAvailable('sandbox grant removal test')
const HINT =
  `vx: the write grant 'dist/' is mounted in place on Linux: the task may empty it ` +
  `but not remove or rename it ("Read-only file system"). Remove its contents ` +
  'instead, e.g. `rm -rf dist/*`, and give a tool that removes its own output ' +
  'directory one inside it (Playwright: `--output dist/run`).'

describe.skipIf(!available || process.platform !== 'linux')('removing a write grant', () => {
  let dir = ''
  beforeEach(async () => {
    dir = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'vx-grant-rm-')))
    await mkdir(path.join(dir, 'dist'))
    await writeFile(path.join(dir, 'dist', 'old.js'), 'old')
    await initSandbox()
  })
  afterEach(async () => {
    await resetSandbox()
    await rm(dir, { recursive: true, force: true })
  })

  const run = (command: string) =>
    runSandboxed({
      command,
      cwd: dir,
      env: process.env,
      baseAllowRead: [dir],
      baseDenyRead: [],
      reportWithin: dir,
      reportLinked: [],
      config: resolveSandboxConfig({ allow: { read: ['.'], write: ['dist/'] } }, dir),
    })
  const hints = (r: Awaited<ReturnType<typeof run>>) =>
    r.violations.filter((v) => v.hint === true).map((v) => v.line)

  it.each([
    ['rm -rf dist && echo new > dist/new.js'],
    [`node -e "require('fs').rmSync('dist', { recursive: true, force: true })"`],
    [`node -e "require('fs').rmSync(require('path').resolve('dist'), { recursive: true })"`],
    // Playwright removes its outputDir itself and says so on stdout.
    [
      `node -e "try { require('fs').rmSync(require('path').resolve('dist'), { recursive: true, force: true }) } catch (e) { console.log('Error: ' + e.message); process.exit(1) }" 2>/dev/null`,
    ],
  ])(
    'a failed removal of the grant names it: %s',
    async (command) => {
      const r = await run(command)
      expect([r.exitCode, hints(r)]).toEqual([1, [HINT]])
    },
    30_000,
  )

  it('the hinted removal works and the recreate lands in the grant', async () => {
    const r = await run('rm -rf dist/* && echo new > dist/new.js')
    expect([r.exitCode, hints(r), readdirSync(path.join(dir, 'dist'))]).toEqual([0, [], ['new.js']])
  }, 30_000)

  it('a read-only failure that names no grant gets no hint', async () => {
    const r = await run(
      `echo "rm: cannot remove 'distant': Read-only file system" >&2; ` +
        `echo "rm: cannot remove 'out/dist': Read-only file system" >&2; exit 1`,
    )
    expect([r.exitCode, hints(r), existsSync(path.join(dir, 'dist'))]).toEqual([1, [], true])
  }, 30_000)
})

// The orchestrator streams a task's output and captures none, so the hint
// read from captured output never reached a `vx run` (2026-11-11).
describe.skipIf(!available || process.platform !== 'linux')(
  'removing a write grant in a run',
  () => {
    let root = ''
    beforeEach(async () => {
      root = realpathSync(await makeWorkspace({ prefix: 'vx-grant-rm-run-' }))
    })
    afterEach(() => rm(root, { recursive: true, force: true }))

    it('names the grant', async () => {
      await addProject(root, 'app', {
        config: `export default { tasks: { t: { exec: {
        command: 'rm -rf dist && echo new > dist/new.js',
        sandbox: { allow: { read: ['.'], write: ['dist/'] } },
      } } } }\n`,
      })
      await mkdir(path.join(root, 'packages', 'app', 'dist'))
      await writeFile(path.join(root, 'packages', 'app', 'dist', 'old.js'), 'old')
      const quiet = { status() {}, taskStdout() {}, taskStderr() {}, taskComplete() {} }
      const r = await runVx({ cwd: root, tasks: ['t'], log: quiet })
      expect(r.outcomes[0]?.sandbox?.lines).toEqual([HINT])
    }, 30_000)
  },
)

// A credential store inside a write grant stays hidden behind a mount, so
// Expo's rename onto `~/.expo/state.json` under `write: ['~/.expo/']`
// failed every run after the first with "resource busy" and no word from
// vx (2026-11-12). Here the store is a denied file under a grant outside
// home: the test writes nothing to the machine's home.
describe.skipIf(!available || process.platform !== 'linux')(
  'a hidden file inside a write grant',
  () => {
    let dir = ''
    beforeEach(async () => {
      dir = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'vx-grant-store-')))
      await mkdir(path.join(dir, 'p'))
      await mkdir(path.join(dir, 'store'))
      await writeFile(path.join(dir, 'store', 'state.json'), '{}')
      await initSandbox()
    })
    afterEach(async () => {
      await resetSandbox()
      await rm(dir, { recursive: true, force: true })
    })

    const run = (command: string) =>
      runSandboxed({
        command,
        cwd: path.join(dir, 'p'),
        env: process.env,
        baseAllowRead: [path.join(dir, 'p')],
        baseDenyRead: [path.join(dir, 'store', 'state.json')],
        reportWithin: path.join(dir, 'p'),
        reportLinked: [],
        config: resolveSandboxConfig(
          { allow: { read: ['.'], write: [`${dir}/store/`] } },
          path.join(dir, 'p'),
        ),
      })
    const hints = (r: Awaited<ReturnType<typeof run>>) =>
      r.violations.filter((v) => v.hint === true).map((v) => v.line)

    it('is named with the grant that opens it', async () => {
      const store = path.join(dir, 'store')
      const r = await run(`echo {} > ${store}/s.tmp && mv ${store}/s.tmp ${store}/state.json`)
      expect([r.exitCode, hints(r)]).toEqual([
        1,
        [
          `vx: '${store}/state.json' lies inside a write grant, but the sandbox hides it (a credential store), ` +
            'so the task can neither read nor replace it ("resource busy"). If the task must, grant it by name: ' +
            `\`allow: { write: ['${store}/state.json'] }\`.`,
        ],
      ])
    }, 30_000)

    it('a failure that names no hidden file gets no hint', async () => {
      const r = await run(`echo "mv: cannot move: Device or resource busy" >&2; exit 1`)
      expect([r.exitCode, hints(r)]).toEqual([1, []])
    }, 30_000)
  },
)
