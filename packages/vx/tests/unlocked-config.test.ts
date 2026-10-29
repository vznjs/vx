// `c#build` where c's vx.config came after the lock ran c's default
// `build`: 0 tasks, exit 0, while a renamed task gets "run `vx lock`"
// (Growth, lock drift L2). It is that config's task: refused, with the fix.
import { rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { expect, it } from 'bun:test'
import { addProject, makeWorkspace } from './helpers/workspace.js'
import { PARITY_TIMEOUT as TIMEOUT } from './helpers/parity.js'

// The bare CLI: the test helper's `vx` locks before each run.
const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')

async function vx(root: string, args: string[]): Promise<{ code: number; text: string }> {
  const p = Bun.spawn([process.execPath, BIN, ...args], {
    cwd: root,
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
