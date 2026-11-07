// `c#build` where c's vx.config came after the lock ran c's default
// `build`: 0 tasks, exit 0, while a renamed task gets "run `vx lock`"
// (Growth, lock drift L2). It is that config's task: refused, with the fix.
import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { expect, it } from 'bun:test'
import { addProject, makeWorkspace } from './helpers/workspace.js'
import { PARITY_TIMEOUT as TIMEOUT } from './helpers/parity.js'

// The bare CLI: the test helper's `vx` locks before each run.
const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')

async function vx(cwd: string, args: string[]): Promise<{ code: number; text: string }> {
  const p = Bun.spawn([process.execPath, BIN, ...args], {
    cwd,
    env: { ...process.env, CI: '', GITHUB_ACTIONS: '', NO_COLOR: '1' },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ])
  return { code, text: out + err }
}

it(
  'naming a task in a config the lock has not seen asks for `vx lock`',
  async () => {
    // `d` depends on `c`: a configured dependant gives config-less `c` its default build.
    const root = await makeWorkspace({ prefix: 'vx-unlocked-config-', edges: { d: ['c'] } })
    try {
      const dir = await addProject(root, 'c', {})
      await addProject(root, 'd', { config: 'export default { tasks: {} }\n' })
      expect((await vx(root, ['lock'])).code).toBe(0)
      // CONTROL: with no config, `c#build` names the default build.
      expect((await vx(root, ['run', 'c#build'])).code).toBe(0)
      await writeFile(
        path.join(dir, 'vx.config.mjs'),
        "export default { tasks: { build: { exec: { command: 'echo c' } } } }\n",
      )
      const r = await vx(root, ['run', 'c#build'])
      expect(r.code).toBe(1)
      expect(r.text).toContain(
        'c#build: packages/c/vx.config.mjs is not in the lock yet — run `vx lock`',
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
  TIMEOUT,
)

it(
  'a scoped bare task in a project whose config the lock has not seen asks for `vx lock`',
  async () => {
    // From c's directory, or `--filter c`, the run said only projects
    // outside the selection declare build and to pass --all, which skips
    // c too: its config is no project config until it is locked.
    const root = await makeWorkspace({ prefix: 'vx-unlocked-scoped-', edges: {} })
    try {
      const dir = await addProject(root, 'c', {})
      await addProject(root, 'd', {
        config: "export default { tasks: { build: { exec: { command: 'echo d' } } } }\n",
      })
      expect((await vx(root, ['lock'])).code).toBe(0)
      await writeFile(
        path.join(dir, 'vx.config.mjs'),
        "export default { tasks: { build: { exec: { command: 'echo c' } } } }\n",
      )
      for (const r of [
        await vx(dir, ['run', 'build']),
        await vx(root, ['run', 'build', '--filter', 'c']),
      ]) {
        expect(r.code).toBe(1)
        // From c's directory the cwd check says it first, without the `build:` lead.
        expect(r.text).toContain('packages/c/vx.config.mjs is not in the lock yet — run `vx lock`')
        expect(r.text).not.toContain('outside the selection')
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
  TIMEOUT,
)

// From an unlocked config's own directory the run fell under the locked
// root project and ran ROOT's build, exit 0.
it(
  "a run from a directory whose config the lock has not seen asks for `vx lock`, not the parent's task",
  async () => {
    const root = await makeWorkspace({ prefix: 'vx-unlocked-cwd-', workspaceFile: false })
    try {
      await writeFile(
        path.join(root, 'vx.config.mjs'),
        "export default { tasks: { build: { exec: { command: 'echo ROOT-ran' } } } }\n",
      )
      expect((await vx(root, ['lock'])).code).toBe(0)
      const dir = path.join(root, 'packages', 'n')
      await mkdir(dir, { recursive: true })
      // CONTROL: a plain subdirectory of the root project runs the root's task.
      const control = await vx(dir, ['run', 'build'])
      expect(control.code).toBe(0)
      expect(control.text).toContain('ROOT-ran')
      await writeFile(
        path.join(dir, 'vx.config.mjs'),
        "export default { tasks: { build: { exec: { command: 'echo N-ran' } } } }\n",
      )
      const r = await vx(dir, ['run', 'build'])
      expect(r.text).not.toContain('ROOT-ran')
      expect(r.text).toContain('packages/n/vx.config.mjs is not in the lock yet — run `vx lock`')
      expect(r.code).toBe(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
  TIMEOUT,
)

// A lock that held no config at all made the hint "run `vx init`", false.
it(
  'a bare task from a project whose config the lock has not seen asks for `vx lock`, not `vx init`',
  async () => {
    const root = await makeWorkspace({ prefix: 'vx-unlocked-bare-', edges: {} })
    try {
      const dir = await addProject(root, 'c', {})
      expect((await vx(root, ['lock'])).code).toBe(0)
      await writeFile(
        path.join(dir, 'vx.config.mjs'),
        "export default { tasks: { build: { exec: { command: 'echo c' } } } }\n",
      )
      const r = await vx(dir, ['run', 'build'])
      expect(r.code).toBe(1)
      expect(r.text).not.toContain('vx init')
      expect(r.text).toContain('packages/c/vx.config.mjs is not in the lock yet — run `vx lock`')
      // From the root, whose own directory holds no config, the hint says the same.
      const all = await vx(root, ['run', 'build', '--all'])
      expect(all.code).toBe(1)
      expect(all.text).not.toContain('vx init')
      expect(all.text).toContain('packages/c/vx.config.mjs is not in the lock yet — run `vx lock`')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
  TIMEOUT,
)

// With no discover plugin a new directory is no project at all, so the
// check above, which asks only projects, never saw it: `packages/d#build`
// said no project declares it and offered `packages/a#build`, a root
// `c#build` listed the projects.
it(
  'naming a task of a directory whose config came after the lock asks for `vx lock`',
  async () => {
    const root = await makeWorkspace({ prefix: 'vx-unlocked-dir-', workspaceFile: false })
    try {
      for (const p of ['a', 'b'])
        await addProject(
          root,
          p,
          `export default { tasks: { build: { exec: { command: 'echo ${p}' } } } }\n`,
        )
      expect((await vx(root, ['lock'])).code).toBe(0)
      const config = "export default { tasks: { build: { exec: { command: 'echo new' } } } }\n"
      await mkdir(path.join(root, 'packages', 'd'), { recursive: true })
      await writeFile(path.join(root, 'packages', 'd', 'vx.config.mjs'), config)
      await mkdir(path.join(root, 'c'), { recursive: true })
      await writeFile(path.join(root, 'c', 'vx.config.mjs'), config)
      const d = await vx(root, ['run', 'packages/d#build'])
      expect(d.text).toContain(
        'packages/d#build: packages/d/vx.config.mjs is not in the lock yet — run `vx lock`',
      )
      expect(d.text).not.toContain('packages/a#build')
      expect(d.code).toBe(1)
      const c = await vx(root, ['run', 'c#build'])
      expect(c.text).toContain('c#build: c/vx.config.mjs is not in the lock yet — run `vx lock`')
      expect(c.code).toBe(1)
      // CONTROL: a directory with no config is still no project.
      const e = await vx(root, ['run', 'e#build'])
      expect(e.text).not.toContain('not in the lock yet')
      expect(e.code).toBe(1)
      // `vx show` said "unknown project" and guessed another.
      for (const target of ['c', 'c#build']) {
        const s = await vx(root, ['show', target])
        expect(s.text).toContain(
          `${target}: c/vx.config.mjs is not in the lock yet — run \`vx lock\``,
        )
        expect(s.text).not.toContain('unknown project')
        expect(s.code).toBe(1)
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
  TIMEOUT,
)
