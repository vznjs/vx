// A sandboxed task that failed on a read the wall refused said only what
// its tool says for a missing file: `tsc` extending a root
// `tsconfig.base.json` read "File not found" and nothing named the
// sandbox. A failed task now names the hidden paths that exist on the
// host (2026-10-02).
import { realpathSync } from 'node:fs'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { run } from './helpers/orchestrator.js'
import { sandboxAvailable } from './helpers/sandbox-gate.js'
import { addProject, makeWorkspace } from './helpers/workspace.js'

const available = await sandboxAvailable('sandbox hidden reads test')
const quiet = { status() {}, taskStdout() {}, taskStderr() {}, taskComplete() {} }

describe.skipIf(!available || process.platform !== 'linux')('a read hidden by the wall', () => {
  let root: string
  beforeEach(async () => {
    root = realpathSync(await makeWorkspace({ prefix: 'vx-hidden-read-' }))
    await writeFile(path.join(root, 'tsconfig.base.json'), '{}\n')
  })
  afterEach(() => rm(root, { recursive: true, force: true }))

  const outcome = async (command: string) => {
    await addProject(root, 'app', {
      config: `export default { tasks: { t: { exec: {
        command: ${JSON.stringify(command)},
        sandbox: { allow: { read: ['.'] } },
      } } } }\n`,
    })
    const r = await run({ cwd: root, tasks: ['t'], log: quiet })
    return [r.outcomes[0]?.status, r.outcomes[0]?.sandboxViolationLines ?? []]
  }

  it('is named beside a failed task, with the grant', async () => {
    expect(await outcome('cat < ../../tsconfig.base.json')).toEqual([
      'failed',
      [
        `vx: the sandbox hid paths outside the project that exist on this machine, which are ` +
          `not reported as violations: ${root}/tsconfig.base.json. If the task reads one, grant ` +
          "it, e.g. `allow: { read: ['../../tsconfig.base.json'] }`.",
      ],
    ])
  })

  it('CONTROL: never beside a passing task', async () => {
    expect(await outcome('cat < ../../tsconfig.base.json || true')).toEqual(['success', []])
  })

  it('CONTROL: a path the host lacks too is the tool’s own miss', async () => {
    expect(await outcome('cat < ../../nope.json')).toEqual(['failed', []])
  })
})

// The hint named a credential store as the grant to add: `cat ~/.npmrc`
// got `allow: { read: ['../../home/dot/npmrc'] }`, its link's target, and
// an agent applies a suggested grant as given. A store, vx's own `~/.vx`
// and what else is walled outside the workspace are named, never granted.
const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')

describe.skipIf(!available || process.platform !== 'linux')('a hidden store', () => {
  let root: string
  beforeEach(async () => {
    root = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'vx-hidden-store-')))
  })
  afterEach(() => rm(root, { recursive: true, force: true }))

  it('is named beside a failed task, but no grant is suggested for it', async () => {
    const home = path.join(root, 'home')
    const ws = path.join(root, 'ws')
    await mkdir(path.join(home, '.config', 'gh'), { recursive: true })
    await mkdir(path.join(home, 'dot'), { recursive: true })
    await mkdir(path.join(home, '.vx'), { recursive: true })
    await writeFile(path.join(home, 'dot', 'npmrc'), 'tok\n')
    await symlink(path.join(home, 'dot', 'npmrc'), path.join(home, '.npmrc'))
    await writeFile(path.join(home, '.config', 'gh', 'hosts.yml'), 'h\n')
    await writeFile(path.join(home, '.vx', 'probe'), 'p\n')
    await mkdir(path.join(ws, 'app'), { recursive: true })
    await writeFile(path.join(ws, 'tsconfig.base.json'), '{}\n')
    await Bun.write(path.join(ws, '.vx/workspace.mjs'), 'export default {}\n')
    // The shell opens each store: Ubuntu 26's cat (uutils) stats first,
    // and a stat is not traced, so `cat ~/.vx/probe` left no record of
    // the wall on CI (sandbox-runtime.md names the gap).
    const task = (command: string) =>
      `{ exec: { command: ${JSON.stringify(command)}, sandbox: { allow: { read: ['.'] } } } }`
    await writeFile(
      path.join(ws, 'app', 'vx.config.mjs'),
      `export default { tasks: {
  npmrc: ${task('cat < ~/.npmrc')},
  gh: ${task('cat < ~/.config/gh/hosts.yml')},
  vx: ${task('cat < ~/.vx/probe')},
  both: ${task('cat < ~/.npmrc; cat < ../tsconfig.base.json; false')},
} }
`,
    )
    expect(Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: ws }).exitCode).toBe(0)
    const vx = (...args: string[]): string => {
      const r = Bun.spawnSync({
        cmd: [process.execPath, BIN, ...args],
        cwd: ws,
        env: { ...process.env, HOME: home },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      return r.stdout.toString() + r.stderr.toString()
    }
    vx('lock')
    // With no hint line the whole output stands in, so a failure shows why.
    const hint = (t: string): string => {
      const out = vx('run', `app#${t}`)
      return out.split('\n').find((l) => l.startsWith('vx: the sandbox hid paths')) ?? out
    }
    const said = 'vx: the sandbox hid paths outside the project that exist on this machine'
    const walled = 'They are walled on purpose, so vx suggests no grant for them.'
    const npmrc = path.join(home, 'dot', 'npmrc')
    expect([hint('npmrc'), hint('gh'), hint('vx'), hint('both')]).toEqual([
      `${said}, which are not reported as violations: ${npmrc}. ${walled}`,
      `${said}, which are not reported as violations: ${home}/.config/gh/hosts.yml. ${walled}`,
      `${said}, which are not reported as violations: ${home}/.vx/probe. ${walled}`,
      `${said}, which are not reported as violations: ${npmrc}, ${ws}/tsconfig.base.json. ` +
        "If the task reads one, grant it, e.g. `allow: { read: ['../tsconfig.base.json'] }`.",
    ])
  }, 30_000)
})
