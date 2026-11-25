// A run reads configs only from `.vx/projects.lock`: a config edited with no
// `vx lock` after it ran the locked config, green, and an agent read the
// green run as its edit working. The run names the edited file and says
// `run vx lock`; it never relocks.
import { mkdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { localWorkspaceSource } from './helpers/local-workspace.js'
import { pluginSource } from './helpers/plugin.js'
import { addProject, git, makeWorkspace } from './helpers/workspace.js'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')

const config = (word: string) => `
  export default { tasks: { say: { exec: { command: 'echo ${word}' } } } }
`

async function vx(cwd: string, args: string[]): Promise<{ code: number; out: string }> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    NO_COLOR: '1',
    VX_LOCK_REVIEW_FILES: 'false',
  }
  delete env['CI']
  delete env['GITHUB_ACTIONS']
  const proc = Bun.spawn([process.execPath, BIN, ...args], {
    cwd,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, out: out + err }
}

describe('a config edited since vx lock', () => {
  let root: string
  let file: string
  beforeEach(async () => {
    root = await makeWorkspace({ prefix: 'vx-lock-edited-' })
    file = path.join(await addProject(root, 'core', config('before')), 'vx.config.mjs')
    expect((await vx(root, ['lock'])).code).toBe(0)
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('refuses the run, naming the file and `vx lock`', async () => {
    await writeFile(file, config('after'))
    const { code, out } = await vx(root, ['run', 'say', '--all'])
    expect(code).toBe(1)
    expect(out).toContain(
      'packages/core/vx.config.mjs changed since the last `vx lock` — run `vx lock`',
    )
    expect(out).toContain('run `vx lock`')
    // Never relocked: the lock still says what it said.
    expect(await readFile(path.join(root, '.vx', 'projects.lock'), 'utf8')).toContain('before')
  })

  it('runs once `vx lock` read the edit', async () => {
    await writeFile(file, config('after'))
    expect((await vx(root, ['lock'])).code).toBe(0)
    const { code } = await vx(root, ['run', 'say', '--all'])
    expect(code).toBe(0)
  })

  // The stamp kept size and mtime alone: a same-length edit whose mtime was
  // set back (`touch -d`, a tool that keeps it) ran the locked config,
  // green. ctime and the inode move with any write; the stamp holds them.
  it('refuses a same-length edit whose mtime was set back', async () => {
    const old = new Date(Date.now() - 3_600_000)
    await utimes(file, old, old)
    expect((await vx(root, ['lock'])).code).toBe(0)
    const before = await stat(file)
    await writeFile(file, config('BEFORE'))
    await utimes(file, before.atime, before.mtime)
    const now = await stat(file)
    expect([now.size, now.mtimeMs]).toEqual([before.size, before.mtimeMs])
    const { code, out } = await vx(root, ['run', 'say', '--all'])
    expect([
      code,
      out.includes('packages/core/vx.config.mjs changed since the last `vx lock`'),
    ]).toEqual([1, true])
  })

  it('runs when the file was rewritten with the same bytes', async () => {
    await writeFile(file, config('before'))
    const { code } = await vx(root, ['run', 'say', '--all'])
    expect(code).toBe(0)
  })

  it('leaves nothing for git to commit in .vx/cache', async () => {
    // The first `vx lock` of a workspace made `.vx/cache/` bare for its
    // stamps, before any run wrote `.vx/.gitignore`: `git add -A` then
    // committed a machine-local file holding this checkout's absolute path.
    const status = Bun.spawnSync(['git', 'status', '--porcelain', '--untracked-files=all'], {
      cwd: root,
    })
    const listed = status.stdout.toString()
    expect(listed).toContain('.vx/projects.lock')
    expect(listed).not.toContain('.vx/cache')
  })

  // No stamp beside the lock (a fresh clone, a cleared cache): the run
  // evaluates the configs once, as `vx lock --check` does. One that the lock
  // holds runs and is stamped; an edit is refused, never run silently.
  it('evaluates a lock no stamp was taken beside, as a fresh clone has', async () => {
    await rm(path.join(root, '.vx', 'cache', 'config-stamps.json'), { force: true })
    expect((await vx(root, ['run', 'say', '--all'])).code).toBe(0)
    await rm(path.join(root, '.vx', 'cache', 'config-stamps.json'), { force: true })
    await writeFile(file, config('after'))
    const { code, out } = await vx(root, ['run', 'say', '--all'])
    expect(code).toBe(1)
    expect(out).toContain('changed since the last `vx lock`')
  })

  // An edit that no longer evaluates read only "changed since the last
  // `vx lock`": the error `vx lock --check` names was hidden, stamped or not.
  for (const stamped of [true, false]) {
    it(`names the error of an edit that does not evaluate ${stamped ? 'beside stamps' : 'with no stamps'}`, async () => {
      if (!stamped) await rm(path.join(root, '.vx', 'cache', 'config-stamps.json'), { force: true })
      await writeFile(file, "throw new Error('boom in the config')\n")
      const { code, out } = await vx(root, ['run', 'say', '--all'])
      expect(code).toBe(1)
      expect(out).toContain('boom in the config')
      expect(out).toContain('packages/core/vx.config.mjs')
    })
  }

  // A cache dir two checkouts share (`VX_CACHE_DIR`) holds the other's stamps.
  it("takes no answer from another workspace's stamps", async () => {
    const at = path.join(root, '.vx', 'cache', 'config-stamps.json')
    const stamps = JSON.parse(await readFile(at, 'utf8')) as Record<string, unknown>
    await writeFile(at, JSON.stringify({ ...stamps, root: '/another/checkout' }))
    await writeFile(file, config('after'))
    const { code, out } = await vx(root, ['run', 'say', '--all'])
    expect(code).toBe(1)
    expect(out).toContain('changed since the last `vx lock`')
  })

  // The stamps held one lock's: `vx lock` on a branch turned the reminder
  // off back on main, and an unlocked edit there ran the locked config, green.
  it('refuses an unlocked edit on a branch whose lock another `vx lock` left', async () => {
    git(root, 'add', '-A')
    git(root, 'commit', '-q', '-m', 'locked')
    git(root, 'checkout', '-q', '-b', 'feat')
    await writeFile(file, config('feat'))
    expect((await vx(root, ['lock'])).code).toBe(0)
    git(root, 'commit', '-q', '-am', 'feat, relocked')
    git(root, 'checkout', '-q', '-')
    expect((await vx(root, ['run', 'say', '--all'])).code).toBe(0)
    await writeFile(file, config('after'))
    const { code, out } = await vx(root, ['run', 'say', '--all'])
    expect(code).toBe(1)
    expect(out).toContain('changed since the last `vx lock`')
  })

  it('a passing `vx lock --check` takes the stamp too', async () => {
    await writeFile(file, `// a comment\n${config('before')}`)
    expect((await vx(root, ['lock', '--check'])).code).toBe(0)
    const { code } = await vx(root, ['run', 'say', '--all'])
    expect(code).toBe(0)
  })

  // The JSON audit returned before the stamp: `upToDate: true`, and the
  // next run still refused the file it had just passed.
  it('a passing `vx lock --check --format json` takes the stamp too', async () => {
    await writeFile(file, `// a comment\n${config('before')}`)
    const check = await vx(root, ['lock', '--check', '--format', 'json'])
    expect(check.code).toBe(0)
    expect(check.out).toContain('"upToDate":true')
    const { code, out } = await vx(root, ['run', 'say', '--all'])
    expect(out).not.toContain('changed since the last `vx lock`')
    expect(code).toBe(0)
  })

  // The stamp held the last `vx lock`'s bytes: a comment relocked (the lock
  // unchanged), then the config and lock restored together (`git checkout`),
  // and run and show refused what `vx lock --check` passed.
  it('runs a config restored to bytes that evaluate as the lock holds', async () => {
    const original = await readFile(file, 'utf8')
    await writeFile(file, `// a comment\n${original}`)
    expect((await vx(root, ['lock'])).code).toBe(0)
    await writeFile(file, original)
    expect((await vx(root, ['lock', '--check'])).code).toBe(0)
    await writeFile(file, `// another\n${original}`)
    for (const args of [
      ['run', 'say', '--all'],
      ['show', 'core'],
    ]) {
      const { code, out } = await vx(root, args)
      expect(out).not.toContain('changed since the last `vx lock`')
      expect(code).toBe(0)
    }
  })

  it('still refuses an edit that evaluates otherwise when the stamp mismatches', async () => {
    await writeFile(file, `// a comment\n${config('after')}`)
    const { code, out } = await vx(root, ['show', 'core'])
    expect(code).toBe(1)
    expect(out).toContain('changed since the last `vx lock`')
  })

  // A config edit committed with no `vx lock` after it ran the locked
  // config, green: its bytes were HEAD's, so it read as a pull's. Only a
  // new lock beside it (a teammate's relocked commit) stops the asking.
  describe('after HEAD moved', () => {
    const commit = (message: string) => {
      git(root, 'add', '-A')
      git(root, 'commit', '-q', '-m', message)
    }
    beforeEach(async () => {
      commit('locked')
      expect((await vx(root, ['lock'])).code).toBe(0)
    })

    it('refuses a config edit committed with no `vx lock`', async () => {
      await writeFile(file, config('after'))
      commit('an edit, not relocked')
      const { code, out } = await vx(root, ['run', 'say', '--all'])
      expect(code).toBe(1)
      expect(out).toContain(
        'packages/core/vx.config.mjs changed since the last `vx lock` — run `vx lock`',
      )
    })

    it('runs a commit that brings the config and its lock together', async () => {
      await writeFile(file, config('after'))
      expect((await vx(root, ['lock'])).code).toBe(0)
      commit('an edit, relocked')
      const pulled = git(root, 'rev-parse', 'HEAD').trim()
      git(root, 'reset', '-q', '--hard', 'HEAD~1')
      // This machine stamps the old lock; the pull brings both files.
      expect((await vx(root, ['lock'])).code).toBe(0)
      git(root, 'merge', '-q', '--ff-only', pulled)
      const { code, out } = await vx(root, ['run', 'say', '--all'])
      expect(out).not.toContain('changed since the last `vx lock`')
      expect(code).toBe(0)
    })

    it('refuses an edit HEAD does not hold', async () => {
      await writeFile(path.join(root, 'other.txt'), 'x')
      commit('another file')
      await writeFile(file, config('after'))
      const { code, out } = await vx(root, ['run', 'say', '--all'])
      expect(code).toBe(1)
      expect(out).toContain('changed since the last `vx lock`')
    })
  })
})

// A `project` plugin edits what a config says (vx-lockfile adds the
// manifest to each task's inputs), and the lock holds what the stage left.
// With no stamps beside it (a fresh clone, CI) the run compared the bare
// evaluation with that and refused every such config while `vx lock
// --check` passed. The mapping reads `mapping.txt`, as turbo() reads turbo.json.
describe('no stamps beside a lock a project plugin mapped', () => {
  const MAPPER = pluginSource(
    'org/mapper',
    `{ project(config, ctx) {
        const fs = require('node:fs')
        const p = require('node:path')
        const at = p.join(ctx.workspaceRoot, 'mapping.txt')
        ctx.read(at)
        const word = fs.readFileSync(at, 'utf8').trim()
        const edit = p.join(ctx.workspaceRoot, 'edit-during-stage.txt')
        if (ctx.name === 'core' && fs.existsSync(edit)) {
          fs.rmSync(edit)
          fs.writeFileSync(p.join(ctx.dir, 'vx.config.mjs'), fs.readFileSync(p.join(ctx.workspaceRoot, 'after.txt'), 'utf8'))
        }
        for (const [n, t] of Object.entries(config.tasks ?? {}))
          config.tasks[n] = { ...t, description: 'mapped ' + word }
        if (ctx.name === 'bare') config.tasks = { say: { exec: { command: 'echo ' + word } } }
      } }`,
  )
  let root: string
  let file: string
  const stamps = () => rm(path.join(root, '.vx', 'cache', 'config-stamps.json'), { force: true })
  beforeEach(async () => {
    root = await makeWorkspace({ prefix: 'vx-lock-mapped-' })
    file = path.join(await addProject(root, 'core', config('before')), 'vx.config.mjs')
    await addProject(root, 'bare')
    await writeFile(path.join(root, 'mapping.txt'), 'one\n')
    await writeFile(path.join(root, '.vx', 'workspace.mjs'), localWorkspaceSource([MAPPER]))
    const locked = await vx(root, ['lock'])
    expect(`${locked.code}\n${locked.out}`).toStartWith('0\n')
    await stamps()
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('runs a fresh checkout `vx lock --check` passes', async () => {
    const { code, out } = await vx(root, ['run', 'say', '--all'])
    expect(out).not.toContain('changed since the last `vx lock`')
    expect(code).toBe(0)
    await stamps()
    expect((await vx(root, ['lock', '--check'])).code).toBe(0)
    expect((await vx(root, ['run', 'say', '--all'])).code).toBe(0)
  })

  it('refuses a mapped-from file edited with no `vx lock`', async () => {
    await writeFile(path.join(root, 'mapping.txt'), 'two\n')
    const { code, out } = await vx(root, ['run', 'bare#say'])
    expect(code).toBe(1)
    expect(out).toContain('changed since the last `vx lock`')
  })

  // Beside stamps the run refused any byte change to a mapped-from file,
  // a version bump in a package.json turbo() reads, though `vx lock
  // --check` passed and `vx lock` wrote the same lock. A CI runner that
  // keeps its cache dir refused every such commit.
  it('runs a mapped-from file edited to map the same beside stamps', async () => {
    expect((await vx(root, ['run', 'bare#say'])).code).toBe(0)
    await writeFile(path.join(root, 'mapping.txt'), 'one\n\n')
    const { code, out } = await vx(root, ['run', 'bare#say'])
    expect(`${code}\n${out}`).toStartWith('0\n')
    await writeFile(path.join(root, 'mapping.txt'), 'two\n')
    const after = await vx(root, ['run', 'bare#say'])
    expect([after.code, after.out]).toEqual([
      1,
      expect.stringContaining('mapping.txt changed since the last `vx lock`'),
    ])
  })

  it('stamps every mapping, so a later edit to one is refused', async () => {
    expect((await vx(root, ['run', 'core#say'])).code).toBe(0)
    await writeFile(path.join(root, 'mapping.txt'), 'two\n')
    const { code, out } = await vx(root, ['run', 'bare#say'])
    expect(code).toBe(1)
    expect(out).toContain('mapping.txt changed since the last `vx lock`')
  })

  // The stamp was taken after the evaluation: a config edited between the
  // two was stamped as the lock holds, and the next run ran the old config.
  it('stamps a config as read before its evaluation', async () => {
    await writeFile(path.join(root, 'after.txt'), config('after'))
    await writeFile(path.join(root, 'edit-during-stage.txt'), '')
    expect((await vx(root, ['run', 'core#say'])).code).toBe(0)
    expect(await readFile(file, 'utf8')).toContain('after')
    const { code, out } = await vx(root, ['run', 'core#say'])
    expect(code).toBe(1)
    expect(out).toContain('packages/core/vx.config.mjs changed since the last `vx lock`')
  })
})

// One file every project's mapping reads, each its own part of it (as root
// turbo.json holds every package's tasks), and a project with no config
// that only its mapping makes (every turbo() and nx() project). With no
// stamps beside the lock, the file was stamped as locked by the project
// whose mapping still held, so after one refusal the edited project ran its
// locked mapping, green: no config of its own was there to stay unstamped.
describe('a mapped-from file one project reads otherwise since vx lock', () => {
  const MAPPER = pluginSource(
    'org/parts',
    `{ project(config, ctx) {
        const fs = require('node:fs')
        const at = require('node:path').join(ctx.workspaceRoot, 'parts.json')
        ctx.read(at)
        const word = JSON.parse(fs.readFileSync(at, 'utf8'))[ctx.name]
        config.tasks = { ...config.tasks, say: { exec: { command: 'echo ' + word } } }
      } }`,
  )
  let root: string
  const parts = (core: string, other: string) =>
    writeFile(path.join(root, 'parts.json'), JSON.stringify({ core, other }))
  beforeEach(async () => {
    root = await makeWorkspace({ prefix: 'vx-lock-parts-' })
    await addProject(root, 'core', config('core'))
    await addProject(root, 'other')
    await parts('one', 'one')
    await writeFile(path.join(root, '.vx', 'workspace.mjs'), localWorkspaceSource([MAPPER]))
    expect((await vx(root, ['lock'])).code).toBe(0)
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  for (const stamped of [true, false]) {
    it(`keeps refusing the project whose part moved ${stamped ? 'beside stamps' : 'with no stamps'}`, async () => {
      if (!stamped) await rm(path.join(root, '.vx', 'cache', 'config-stamps.json'), { force: true })
      await parts('one', 'two')
      const first = await vx(root, ['run', 'core#say'])
      expect([first.code, first.out]).toEqual([
        1,
        expect.stringContaining('changed since the last `vx lock`'),
      ])
      const again = await vx(root, ['run', 'other#say'])
      expect([again.code, again.out]).toEqual([
        1,
        expect.stringContaining('changed since the last `vx lock`'),
      ])
      expect((await vx(root, ['lock', '--check'])).code).toBe(1)
    })
  }
})

// A plugin's options live in `.vx/workspace.*` (turbo({ root }), nx({
// executors })): an edit there changed what the `project` stage maps, and
// the run kept the locked commands, green, until a `vx lock`. Only
// `vx lock --check` said so. An edit that maps the same (a concurrency)
// still runs.
describe('a workspace file edited since vx lock', () => {
  const mapper = (word: string) =>
    pluginSource(
      'org/opts',
      `{ project(config) {
          config.tasks = { ...config.tasks, say: { exec: { command: 'echo ${word}' } } }
        } }`,
    )
  let root: string
  const workspace = (word: string, fields?: string) =>
    writeFile(
      path.join(root, '.vx', 'workspace.mjs'),
      localWorkspaceSource([mapper(word)], '', undefined, fields),
    )
  beforeEach(async () => {
    root = await makeWorkspace({ prefix: 'vx-lock-workspace-' })
    await addProject(root, 'core')
    await workspace('one')
    expect((await vx(root, ['lock'])).code).toBe(0)
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  for (const stamped of [true, false]) {
    it(`refuses a plugin option edited with no \`vx lock\` ${stamped ? 'beside stamps' : 'with no stamps'}`, async () => {
      // Committed with its lock, as a clone has it: with no stamps, git says
      // which file moved since the lock's commit.
      git(root, 'add', '-A')
      git(root, 'commit', '-q', '-m', 'locked')
      if (!stamped) await rm(path.join(root, '.vx', 'cache', 'config-stamps.json'), { force: true })
      await workspace('two')
      const { code, out } = await vx(root, ['run', 'core#say'])
      expect([code, out]).toEqual([
        1,
        expect.stringContaining(
          '.vx/workspace.mjs changed since the last `vx lock` — run `vx lock`',
        ),
      ])
      expect(out).not.toContain('packages/core')
      expect(await readFile(path.join(root, '.vx', 'projects.lock'), 'utf8')).toContain('echo one')
    })
  }

  it('runs an edit that maps as the lock holds, and stamps it', async () => {
    await workspace('one', 'run: { concurrency: 3 }')
    const first = await vx(root, ['run', 'core#say'])
    expect([first.code, first.out]).toEqual([0, expect.stringContaining('one')])
    await workspace('two', 'run: { concurrency: 3 }')
    const { code, out } = await vx(root, ['run', 'core#say'])
    expect([code, out]).toEqual([1, expect.stringContaining('changed since the last `vx lock`')])
  })

  it('runs once `vx lock` read the edit', async () => {
    await workspace('two')
    expect((await vx(root, ['lock'])).code).toBe(0)
    const { code, out } = await vx(root, ['run', 'core#say'])
    expect([code, out]).toEqual([0, expect.stringContaining('two')])
  })
})

// The plugins are evaluated from the workspace file's bytes at the run's
// start; the stamp was taken later. An edit between the two was stamped as
// checked, and every later run kept the locked commands under the new
// options, green.
describe('a workspace file edited after the run loaded it', () => {
  const mapper = (word: string) =>
    pluginSource(
      'org/opts',
      `{ project(config) {
          config.tasks = { ...config.tasks, say: { exec: { command: 'echo ${word}' } } }
        } }`,
    )
  let root: string
  const file = () => path.join(root, '.vx', 'workspace.mjs')
  beforeEach(async () => {
    root = await makeWorkspace({ prefix: 'vx-lock-workspace-race-' })
    await addProject(root, 'core')
    await writeFile(file(), localWorkspaceSource([mapper('one')]))
    expect((await vx(root, ['lock'])).code).toBe(0)
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  const later = () => localWorkspaceSource([mapper('two')])
  // Its `config` hook runs after the load and before the stamp: the edit, once.
  const editor = () =>
    pluginSource(
      'org/editor',
      `{ async config(_workspace, ctx) {
          const marker = ctx.workspaceRoot + '/.edit-once'
          if (await Bun.file(marker).exists()) {
            await Bun.write(ctx.workspaceRoot + '/.vx/workspace.mjs', ${JSON.stringify(later())})
            await (await import('node:fs/promises')).rm(marker)
          }
        } }`,
    )

  for (const verb of [['run', 'core#say'], ['lock']]) {
    it(`is not stamped by \`vx ${verb[0]}\` as the bytes it checked`, async () => {
      await writeFile(file(), localWorkspaceSource([mapper('one'), editor()]))
      await writeFile(path.join(root, '.edit-once'), '')
      const first = await vx(root, verb)
      expect(first.code).toBe(0)
      expect(await readFile(file(), 'utf8')).toBe(later())
      const { code, out } = await vx(root, ['run', 'core#say'])
      expect([code, out]).toEqual([
        1,
        expect.stringContaining('.vx/workspace.mjs changed since the last `vx lock`'),
      ])
    })
  }
})

// A claimant's options live in `.vx/workspace.*` too: an edit that moves
// the digests `vx lock` recorded was refused by the key path as the claimed
// file having changed, which it had not.
describe('a claimant option edited since vx lock', () => {
  const claimant = (word: string) =>
    pluginSource(
      'org/claim',
      `{
        fingerprint: {
          files: ['deps.txt'],
          affected: () => undefined,
          digests: (_file, ctx) => ({
            hash: 'h',
            projects: Object.fromEntries(ctx.projects.map((p) => [p.name, '${word}'])),
          }),
        },
        key: () => ({}),
      }`,
    )
  let root: string
  const workspace = (word: string) =>
    writeFile(path.join(root, '.vx', 'workspace.mjs'), localWorkspaceSource([claimant(word)]))
  beforeEach(async () => {
    root = await makeWorkspace({ prefix: 'vx-lock-claimant-' })
    await addProject(root, 'core', config('core'))
    await writeFile(path.join(root, 'deps.txt'), 'deps\n')
    await workspace('one')
    expect((await vx(root, ['lock'])).code).toBe(0)
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('names the workspace file, not the claimed one', async () => {
    await workspace('two')
    const { code, out } = await vx(root, ['run', 'core#say'])
    expect([code, out]).toEqual([
      1,
      expect.stringContaining('.vx/workspace.mjs changed since the last `vx lock` — run `vx lock`'),
    ])
    expect(out).not.toContain('deps.txt')
  })
})

// A run with no stamps beside its lock (a clone, CI, a branch switch)
// evaluates every mapping once and stamps what holds, but not the workspace
// file: the next run found it unstamped and evaluated every mapping again.
describe('a workspace with no stamps', () => {
  let root: string
  const counted = pluginSource(
    'org/count',
    `{ async project(config, ctx) {
        const { appendFile } = await import('node:fs/promises')
        await appendFile(ctx.workspaceRoot + '/.mapped', 'x')
        config.tasks = { ...config.tasks, say: { exec: { command: 'echo mapped' } } }
      } }`,
  )
  beforeEach(async () => {
    root = await makeWorkspace({ prefix: 'vx-lock-nostamps-' })
    await addProject(root, 'core')
    await writeFile(path.join(root, '.vx', 'workspace.mjs'), localWorkspaceSource([counted]))
    expect((await vx(root, ['lock'])).code).toBe(0)
    await rm(path.join(root, '.vx', 'cache', 'config-stamps.json'))
    await rm(path.join(root, '.mapped'))
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('evaluates the mappings once, not again on the next run', async () => {
    for (let i = 0; i < 2; i++) {
      const { code, out } = await vx(root, ['run', 'core#say'])
      expect([code, out]).toEqual([0, expect.stringContaining('mapped')])
    }
    expect(await readFile(path.join(root, '.mapped'), 'utf8')).toBe('x')
  })

  // The run asked only the configs and mappings: a plugin that no longer
  // adds a project ran green here, and the next run refused it.
  it('refuses a plugin option that discovers otherwise', async () => {
    const adds = (on: boolean) =>
      pluginSource(
        'org/adds',
        `{ discover: () => ${on ? "[{ dir: 'tools/extra', name: 'extra' }]" : '[]'} }`,
      )
    const workspace = (on: boolean) =>
      writeFile(path.join(root, '.vx', 'workspace.mjs'), localWorkspaceSource([counted, adds(on)]))
    await mkdir(path.join(root, 'tools', 'extra'), { recursive: true })
    await workspace(true)
    expect((await vx(root, ['lock'])).code).toBe(0)
    await rm(path.join(root, '.vx', 'cache', 'config-stamps.json'))
    await workspace(false)
    const { code, out } = await vx(root, ['run', 'core#say'])
    expect([code, out]).toEqual([
      1,
      expect.stringContaining('.vx/workspace.mjs changed since the last `vx lock` — run `vx lock`'),
    ])
  })
})

// With no stamps (a clone, CI) a config whose bytes are the lock's commit's
// but whose evaluation differs was named "changed since the last `vx lock`":
// on CI the cause is the environment it reads or a file it imports.
describe('a config that evaluates otherwise on this machine', () => {
  let root: string
  beforeEach(async () => {
    root = await makeWorkspace({ prefix: 'vx-lock-elsewhere-' })
    await addProject(
      root,
      'core',
      `export default { tasks: { say: { exec: { command: 'echo ' + (process.env.VX_TEST_FLAVOR ?? 'plain') } } } }\n`,
    )
    expect((await vx(root, ['lock'])).code).toBe(0)
    git(root, 'add', '-A')
    git(root, 'commit', '-qm', 'lock')
    await rm(path.join(root, '.vx', 'cache', 'config-stamps.json'))
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('names the environment or an import, not an edit', async () => {
    process.env['VX_TEST_FLAVOR'] = 'hot'
    try {
      const { code, out } = await vx(root, ['run', 'core#say'])
      expect([code, out]).toEqual([
        1,
        expect.stringContaining(
          'packages/core/vx.config.mjs evaluates differently from the lock here: a file it imports, or the environment it reads, changed — run `vx lock`',
        ),
      ])
    } finally {
      delete process.env['VX_TEST_FLAVOR']
    }
  })

  it('CONTROL: an edit since the lock’s commit is named as one', async () => {
    await writeFile(path.join(root, 'packages/core/vx.config.mjs'), config('after'))
    const { code, out } = await vx(root, ['run', 'core#say'])
    expect([code, out]).toEqual([
      1,
      expect.stringContaining(
        'packages/core/vx.config.mjs changed since the last `vx lock` — run `vx lock`',
      ),
    ])
  })
})
