// A run reads configs only from `.vx/projects.lock`: a config edited with no
// `vx lock` after it ran the locked config, green, and an agent read the
// green run as its edit working. The run names the edited file and says
// `run vx lock`; it never relocks.
import { readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
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
