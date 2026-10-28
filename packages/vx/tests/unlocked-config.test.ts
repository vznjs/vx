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
    const root = await makeWorkspace({ prefix: 'vx-unlocked-config-', edges: {} })
    try {
      const dir = await addProject(root, 'c', {})
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
