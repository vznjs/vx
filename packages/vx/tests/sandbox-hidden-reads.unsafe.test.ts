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

  // The grant alone, applied as given, read the file unkeyed: an edit to
  // it replayed the old bytes. A cached task is told to key it too.
  it('beside a cached task names the key entry too, and the two applied re-run on an edit', async () => {
    const cached = (read: string[], workspaceFiles: string[]) =>
      `export default { tasks: { t: {
        exec: { command: 'cat < ../../tsconfig.base.json > out.txt',
          sandbox: { allow: { read: ${JSON.stringify(read)}, write: ['out.txt'] } } },
        cache: true,
        inputs: { files: ['src/**'], workspaceFiles: ${JSON.stringify(workspaceFiles)} },
        outputs: { files: ['out.txt'] },
      } } }\n`
    const app = await addProject(root, 'app', { config: cached(['.'], []) })
    const t = async () => (await run({ cwd: root, tasks: ['t'], log: quiet })).outcomes[0]
    expect((await t())?.sandboxViolationLines).toEqual([
      `vx: the sandbox hid paths outside the project that exist on this machine, which are ` +
        `not reported as violations: ${root}/tsconfig.base.json. If the task reads one, grant ` +
        "it, e.g. `allow: { read: ['../../tsconfig.base.json'] }`, and, if the output depends " +
        "on it, key it: `inputs: { workspaceFiles: ['tsconfig.base.json'] }`.",
    ])
    await writeFile(
      path.join(app, 'vx.config.mjs'),
      cached(['.', '../../tsconfig.base.json'], ['tsconfig.base.json']),
    )
    expect((await t())?.status).toBe('success')
    await writeFile(path.join(root, 'tsconfig.base.json'), '{ "v": 2 }\n')
    expect((await t())?.status).toBe('success')
    expect(await Bun.file(path.join(app, 'out.txt')).text()).toBe('{ "v": 2 }\n')
  })

  // The key entry named `!cfg` raw: applied as given it was a negation that
  // keyed nothing, so an edit replayed the old bytes.
  it('names a file that starts with ! by an escaped key entry, which re-runs on an edit', async () => {
    await writeFile(path.join(root, '!cfg'), 'v1\n')
    const cached = (read: string[], workspaceFiles: string[]) =>
      `export default { tasks: { t: {
        exec: { command: 'cat < "../../!cfg" > out.txt',
          sandbox: { allow: { read: ${JSON.stringify(read)}, write: ['out.txt'] } } },
        cache: true,
        inputs: { files: ['src/**'], workspaceFiles: ${JSON.stringify(workspaceFiles)} },
        outputs: { files: ['out.txt'] },
      } } }\n`
    const app = await addProject(root, 'app', { config: cached(['.'], []) })
    const t = async () => (await run({ cwd: root, tasks: ['t'], log: quiet })).outcomes[0]
    const [line] = (await t())?.sandboxViolationLines ?? []
    expect(line).toEndWith("key it: `inputs: { workspaceFiles: ['\\\\!cfg'] }`.")
    await writeFile(path.join(app, 'vx.config.mjs'), cached(['.', '../../!cfg'], ['\\!cfg']))
    expect((await t())?.status).toBe('success')
    await writeFile(path.join(root, '!cfg'), 'v2\n')
    expect((await t())?.status).toBe('success')
    expect(await Bun.file(path.join(app, 'out.txt')).text()).toBe('v2\n')
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

// A build that falls back when its root `tsconfig.base.json` is hidden
// (`bun build` compiled JSX for React, not the configured runtime)
// passed, and the wrong output was saved under a key that holds the file.
// So did oxlint with its root `.oxlintrc.json` hidden: it stats the file
// before it opens it, and no trace records a stat. Judged from the grants
// before the run, on every platform.
describe.skipIf(!available)('a file the key holds that no grant reaches', () => {
  let root: string
  beforeEach(async () => {
    root = realpathSync(await makeWorkspace({ prefix: 'vx-keyed-hidden-' }))
    await writeFile(path.join(root, 'tsconfig.base.json'), '{}\n')
  })
  afterEach(() => rm(root, { recursive: true, force: true }))

  const cached = (command: string, read: string[], workspaceFiles: string[]) =>
    `export default { tasks: { t: {
      exec: { command: ${JSON.stringify(command)},
        sandbox: { allow: { read: ${JSON.stringify(read)}, write: ['out.txt'] } } },
      cache: true,
      inputs: { files: ['src/**'], workspaceFiles: ${JSON.stringify(workspaceFiles)} },
      outputs: { files: ['out.txt'] },
    } } }\n`
  const t = async () => (await run({ cwd: root, tasks: ['t'], log: quiet })).outcomes[0]

  it('fails a task that stats the file before it reads it, unrun, and the fix applied re-runs', async () => {
    const stat =
      '{ [ -e ../../tsconfig.base.json ] && cat ../../tsconfig.base.json || echo fallback; } > out.txt'
    const app = await addProject(root, 'app', {
      config: cached(stat, ['.'], ['tsconfig.base.json']),
    })
    const o = await t()
    expect([o?.status, o?.saved, o?.sandboxViolations, o?.sandboxFix?.read]).toEqual([
      'failed',
      undefined,
      1,
      ['../../tsconfig.base.json'],
    ])
    expect(o?.sandboxViolationLines?.at(-1)).toBe(
      `vx: the sandbox hides a file this task's key holds, so it was not run: ` +
        `${root}/tsconfig.base.json. Grant it, e.g. ` +
        "`allow: { read: ['../../tsconfig.base.json'] }`.",
    )
    expect(await Bun.file(path.join(app, 'out.txt')).exists()).toBe(false)
    await writeFile(
      path.join(app, 'vx.config.mjs'),
      cached(stat, ['.', ...o!.sandboxFix!.read!], ['tsconfig.base.json']),
    )
    expect((await t())?.status).toBe('success')
    expect(await Bun.file(path.join(app, 'out.txt')).text()).toBe('{}\n')
  })

  it('fails one whose open of the file falls back', async () => {
    await addProject(root, 'app', {
      config: cached(
        '(cat < ../../tsconfig.base.json || echo fallback) > out.txt',
        ['.'],
        ['tsconfig.base.json'],
      ),
    })
    const o = await t()
    expect([o?.status, o?.sandboxFix?.read]).toEqual(['failed', ['../../tsconfig.base.json']])
  })

  // An agent applies a suggested grant as given: a keyed `.env` is
  // failed on the same way, but no grant to it is named.
  it('fails one whose key holds a walled credential file without suggesting its grant', async () => {
    await writeFile(path.join(root, '.env'), 'K=v\n')
    await addProject(root, 'app', {
      config: cached('(cat < ../../.env || echo fallback) > out.txt', ['.'], ['.env']),
    })
    const o = await t()
    expect([o?.status, o?.sandboxFix?.read, o?.sandboxViolationLines?.at(-1)]).toEqual([
      'failed',
      undefined,
      `vx: the sandbox hides a file this task's key holds, so it was not run: ` +
        `${root}/.env. It is walled on purpose, so vx suggests no grant for it.`,
    ])
  })

  it('CONTROL: a task whose key holds no hidden file passes and is saved', async () => {
    await addProject(root, 'app', {
      config: cached('(cat < ../../tsconfig.base.json || echo fallback) > out.txt', ['.'], []),
    })
    const o = await t()
    expect([o?.status, o?.saved, o?.sandboxViolationLines]).toEqual(['success', true, undefined])
  })

  it('CONTROL: a granted keyed file passes', async () => {
    await addProject(root, 'app', {
      config: cached(
        'cat < ../../tsconfig.base.json > out.txt',
        ['.', '../../tsconfig.base.json'],
        ['tsconfig.base.json'],
      ),
    })
    expect((await t())?.status).toBe('success')
  })
})

// `tsc -p tsconfig.json` with the file not granted stats it first, which
// no trace records: it failed "TS5058: The specified path does not exist"
// with no violation and no word of the sandbox. A failed task whose
// stderr calls missing a path the sandbox hides and the host has names it.
describe.skipIf(!available || process.platform !== 'linux')('a stat refused by the wall', () => {
  let root: string
  beforeEach(async () => {
    root = realpathSync(await makeWorkspace({ prefix: 'vx-stat-hidden-' }))
  })
  afterEach(() => rm(root, { recursive: true, force: true }))

  const outcome = async (command: string) => {
    await addProject(root, 'app', {
      config: `export default { tasks: { t: { exec: {
        command: ${JSON.stringify(command)},
        sandbox: { allow: { read: ['src/'] } },
      } } } }\n`,
      files: { 'tsconfig.json': '{}\n', 'src/a.ts': '' },
    })
    const r = await run({ cwd: root, tasks: ['t'], log: quiet })
    return [r.outcomes[0]?.status, r.outcomes[0]?.sandboxViolationLines ?? []]
  }
  // tsc prints its diagnostics on stdout; most tools, on stderr.
  const tsc = (file: string, to = '') =>
    `[ -e ${file} ] || { echo "error TS5058: The specified path does not exist: '${file}'." ${to}; exit 1; }`

  it('is named beside the failure, with the grant', async () => {
    const named = await outcome(tsc('tsconfig.json'))
    await rm(path.join(root, 'packages', 'app'), { recursive: true, force: true })
    expect(await outcome(tsc('tsconfig.json', '>&2'))).toEqual(named)
    expect(named).toEqual([
      'failed',
      [
        `vx: the task failed naming paths the sandbox hides that exist on this machine: ` +
          `${root}/packages/app/tsconfig.json. A stat is not traced on Linux, so no violation ` +
          "names them. If the task reads one, grant it, e.g. `allow: { read: ['tsconfig.json'] }`.",
      ],
    ])
  })

  it('CONTROL: a path the host lacks too is not named', async () => {
    expect(await outcome(tsc('tsconfig.other.json'))).toEqual(['failed', []])
  })
})
