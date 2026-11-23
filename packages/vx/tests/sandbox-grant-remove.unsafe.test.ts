// `rm -rf dist && tsc` under `write: ['dist/']` (X-90). On Linux the grant
// is a bind mount, which the task can empty but not remove: rm failed with
// "Read-only file system", naming neither vx nor the grant. The failure
// now carries a hint naming the grant and the removal that works.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { initSandbox, resetSandbox } from '../src/sandbox/session.js'
import { resolveSandboxConfig } from '../src/sandbox/grants.js'
import { stagedOutputs } from '../src/sandbox/binds.js'
import { runSandboxed } from '../src/sandbox/runtime.js'
import { taskTmpRoot } from '../src/sandbox/tmp.js'
import { STAGE_PUT_BACK, sweepStaging } from '../src/cache/index.js'
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

// A deny or mask inside a directory is a mount that moves with it: staged,
// the task could move the protected tree aside, rebuild it, and the restore
// would land that on the host (security review, 2026-11-23).
describe.skipIf(process.platform !== 'linux')('staging an output directory', () => {
  let dir = ''
  beforeEach(async () => {
    dir = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'vx-stage-')))
    await mkdir(path.join(dir, '.vx'))
    await mkdir(path.join(dir, 'app', 'dist'), { recursive: true })
    await writeFile(path.join(dir, 'app', 'dist', '.mcp.json'), '{}')
  })
  afterEach(() => rm(dir, { recursive: true, force: true }))
  const dist = () => path.join(dir, 'app', 'dist')
  const stage = (extra: string) =>
    stagedOutputs(`bwrap --tmpfs ${dir} --bind ${dist()} ${dist()}${extra} -- sh`, {
      cwd: path.join(dir, 'app'),
      allowRead: [],
      allowWrite: [dist()],
      granted: [dist()],
      owned: [dist()],
      tag: '0123456789abcdef',
    })

  it('stages a directory the line names only in its own write bind', () => {
    const s = stage('')
    expect(s?.wrapped).toContain(`--bind ${dir}/.vx/tmp/`)
    expect(s?.wrapped).not.toContain(`--bind ${dist()} ${dist()}`)
    s?.restore()
    expect(readdirSync(dist())).toEqual(['.mcp.json'])
  })

  // The stage made each directory afresh at the umask's mode: a restore
  // turned a 0700 `dist/bin` 0755 on the host, and the next save kept it.
  it("keeps each staged directory's mode", () => {
    mkdirSync(path.join(dist(), 'bin'))
    chmodSync(path.join(dist(), 'bin'), 0o700)
    chmodSync(dist(), 0o750)
    const s = stage('')
    expect(s).toBeDefined()
    s!.restore()
    expect(statSync(path.join(dist(), 'bin')).mode & 0o777).toBe(0o700)
    expect(statSync(dist()).mode & 0o777).toBe(0o750)
  })

  // Killed between the restore's renames, the host's directory was only
  // in the stage, and the next run's sweep removed it (2026-11-23).
  it('a restore killed midway loses no host directory once swept', async () => {
    const child = Bun.spawn(
      [process.execPath, path.join(import.meta.dir, 'helpers', 'kill-restore.ts'), dir],
      { stdout: 'ignore', stderr: 'ignore' },
    )
    await child.exited
    expect([child.signalCode, existsSync(dist())]).toEqual(['SIGKILL', false])
    sweepStaging(dir)
    expect([readdirSync(dist()), readdirSync(path.join(dir, '.vx', 'tmp'))]).toEqual([
      ['.mcp.json'],
      [],
    ])
  })

  it.each([
    [' --ro-bind DIST/.mcp.json DIST/.mcp.json'],
    [' --ro-bind DIST DIST'],
    [' --tmpfs DIST/sub'],
  ])('stages none the line names elsewhere:%s', (extra) => {
    expect(stage(extra.replaceAll('DIST', dist()))).toBeUndefined()
  })
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

    const quiet = { status() {}, taskStdout() {}, taskStderr() {}, taskComplete() {} }
    const app = (command: string, write: string, outputs = '') =>
      addProject(root, 'app', {
        config: `export default { tasks: { t: { ${outputs} exec: {
        command: '${command}',
        sandbox: { allow: { read: ['.'], write: [${write}] } },
      } } } }\n`,
      }).then(async (dir) => {
        await mkdir(path.join(dir, 'dist'), { recursive: true })
        await writeFile(path.join(dir, 'dist', 'old.js'), 'old')
        return dir
      })

    // Staged, the output directory is no mount point: `rm -rf dist && tsc`
    // works (conformance sandbox/clean-and-rebuild-output-dir-passes), and
    // what the task writes beside it is reported and never reaches the host.
    const owned = "inputs: { files: [] }, outputs: { files: ['dist/**'] }, cache: true,"
    it('lets the task remove and rebuild it, and reports a write beside it', async () => {
      const dir = await app('rm -rf dist && mkdir dist && echo new > dist/new.js', "'dist/'", owned)
      const ok = await runVx({ cwd: root, tasks: ['t'], log: quiet })
      expect(ok.outcomes[0]?.status).toBe('success')
      expect(readdirSync(path.join(dir, 'dist'))).toEqual(['new.js'])
      expect(
        readdirSync(path.join(root, '.vx', 'tmp')).filter((n) => /-[0-9a-f]{16}$/.test(n)),
      ).toEqual([])

      await app(
        'rm -rf dist && mkdir dist && echo new > dist/new.js && echo x > stray.txt',
        "'dist/'",
        owned,
      )
      const r = await runVx({ cwd: root, tasks: ['t'], log: quiet })
      expect(r.outcomes[0]?.status).toBe('failed')
      expect(r.outcomes[0]?.sandbox?.lines?.some((l) => l.includes('stray.txt'))).toBe(true)
      expect(existsSync(path.join(dir, 'stray.txt'))).toBe(false)
    }, 30_000)

    // The host's directory stays while the task runs: a concurrent task
    // still reads it, and a killed run loses nothing.
    it('keeps the host directory in place until the task ends', async () => {
      const dir = await app(
        'rm -rf dist && mkdir dist && echo new > dist/new.js && sleep 2',
        "'dist/'",
        owned,
      )
      const run = runVx({ cwd: root, tasks: ['t'], log: quiet })
      const tmp = path.join(root, '.vx', 'tmp')
      const staged = () => existsSync(tmp) && readdirSync(tmp).some((n) => /-[0-9a-f]{16}$/.test(n))
      for (let i = 0; i < 200 && !staged(); i++) await Bun.sleep(25)
      // vx cleared the stale output before the run; the task's own is not there yet.
      expect([staged(), readdirSync(path.join(dir, 'dist'))]).toEqual([true, []])
      expect((await run).outcomes[0]?.status).toBe('success')
      expect(readdirSync(path.join(dir, 'dist'))).toEqual(['new.js'])
    }, 30_000)

    it('never puts a link the task made in its place on the host', async () => {
      const dir = await app('rm -rf dist && ln -s /etc dist', "'dist/'", owned)
      // A temp root of its own: the shared one takes every other test
      // process's trace logs, and one written beside this run read as its
      // leak under load (2026-11-23).
      const own = mkdtempSync(path.join(os.tmpdir(), 'vx-grant-rm-'))
      const previous = process.env['CLAUDE_CODE_TMPDIR']
      process.env['CLAUDE_CODE_TMPDIR'] = own
      try {
        const logs = () =>
          existsSync(taskTmpRoot())
            ? readdirSync(taskTmpRoot()).filter((n) => n.startsWith('vx-strace-'))
            : []
        const r = await runVx({ cwd: root, tasks: ['t'], log: quiet })
        expect([r.outcomes[0]?.status, lstatSync(path.join(dir, 'dist')).isDirectory()]).toEqual([
          'failed',
          true,
        ])
        // The failed restore let the attempt's trace log go too (2026-11-23),
        // from the root the run used.
        expect([existsSync(taskTmpRoot()), logs()]).toEqual([true, []])
      } finally {
        if (previous === undefined) delete process.env['CLAUDE_CODE_TMPDIR']
        else process.env['CLAUDE_CODE_TMPDIR'] = previous
        rmSync(own, { recursive: true, force: true })
      }
    }, 30_000)

    // A run killed between the restore's two renames left the host's
    // directory only in the stage, and the next run's sweep removed it.
    it("a killed restore's host directory is put back by the next sweep", async () => {
      const dir = await app('true', "'dist/'", owned)
      const dead = Bun.spawn(['true'])
      await dead.exited
      const stage = path.join(root, '.vx', 'tmp', `${dead.pid.toString(36)}-0123456789abcdef`)
      mkdirSync(path.join(stage, '.host-dist'), { recursive: true })
      await writeFile(path.join(stage, '.host-dist', 'old.js'), 'old')
      await writeFile(path.join(stage, STAGE_PUT_BACK), path.join(dir, 'dist'))
      await rm(path.join(dir, 'dist'), { recursive: true })
      sweepStaging(root)
      expect([readdirSync(path.join(dir, 'dist')), existsSync(stage)]).toEqual([['old.js'], false])
    })

    // A file grant in the task's directory binds the directory itself:
    // nothing is staged, and the removal is refused with the hint.
    it('names the grant where the task directory is bound', async () => {
      await app('rm -rf dist && echo new > dist/new.js', "'dist/', 'out.txt'", owned)
      const r = await runVx({ cwd: root, tasks: ['t'], log: quiet })
      expect(r.outcomes[0]?.sandbox?.lines).toEqual([HINT])
    }, 30_000)

    // A grant no output claims whole may be another task's to read while
    // this one runs: it stays in place, and the removal gets the hint.
    it('names a grant no output claims', async () => {
      await app('rm -rf dist && echo new > dist/new.js', "'dist/'")
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
