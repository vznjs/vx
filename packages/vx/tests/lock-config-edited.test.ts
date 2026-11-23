// A run reads configs only from `.vx/projects.lock`: a config edited with no
// `vx lock` after it ran the locked config, green, and an agent read the
// green run as its edit working. The run names the edited file and says
// `run vx lock`; it never relocks.
import { readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { addProject, makeWorkspace } from './helpers/workspace.js'

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

  it('runs when the file was rewritten with the same bytes', async () => {
    await writeFile(file, config('before'))
    const { code } = await vx(root, ['run', 'say', '--all'])
    expect(code).toBe(0)
  })

  it('runs a lock no stamp was taken beside, as a fresh clone has', async () => {
    await rm(path.join(root, '.vx', 'cache', 'config-stamps.json'), { force: true })
    await writeFile(file, config('after'))
    const { code } = await vx(root, ['run', 'say', '--all'])
    expect(code).toBe(0)
  })

  it('a passing `vx lock --check` takes the stamp too', async () => {
    await writeFile(file, `// a comment\n${config('before')}`)
    expect((await vx(root, ['lock', '--check'])).code).toBe(0)
    const { code } = await vx(root, ['run', 'say', '--all'])
    expect(code).toBe(0)
  })
})
