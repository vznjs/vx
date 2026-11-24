// turbo() keys a package's gitignored `.env` files through a runtime probe
// that prints each file's name and bytes, yet `vx lock` said the file was
// in no input (or left out of `**/*`) and told the user to add `.env*`.
// A probe that names the file keys it; a file no probe names still warns.
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import { useTurboWorkspace } from './helpers/turbo-workspace.js'

const CORE = path.resolve(import.meta.dir, '../../vx/src/bin.ts')

const ws = useTurboWorkspace({ tasks: { build: { outputs: ['dist/**'] } } })

async function lock(inputs: readonly string[]): Promise<string> {
  const root = ws.root
  await writeFile(
    path.join(root, 'turbo.json'),
    JSON.stringify({ tasks: { build: { inputs, outputs: ['dist/**'] } } }),
  )
  await writeFile(path.join(root, '.gitignore'), 'dist\n.env*\n')
  await writeFile(path.join(root, 'packages', 'app', '.env'), 'A=1\n')
  await writeFile(path.join(root, 'packages', 'lib', '.env.local'), 'A=2\n')
  Bun.spawnSync({ cmd: ['git', 'add', '-A'], cwd: root })
  const r = Bun.spawnSync([process.execPath, CORE, 'lock'], {
    cwd: root,
    env: { ...process.env, HOME: root },
    stderr: 'pipe',
  })
  expect(r.exitCode).toBe(0)
  return r.stderr.toString()
}

describe('turbo(): vx lock and a probed .env', () => {
  it('names no .env the probe keys', async () => {
    expect(await lock(['src/**', '.env*'])).not.toContain('.env')
  }, 30_000)

  it('names no .env the probe keys beside $TURBO_DEFAULT$', async () => {
    expect(await lock(['$TURBO_DEFAULT$', '.env*'])).not.toContain('.env')
  }, 30_000)

  it('still names a .env no input keys', async () => {
    const err = await lock(['src/**'])
    expect(err).toContain('app#build: .env beside its config is in no input')
    expect(err).toContain('lib#build: .env.local beside its config is in no input')
  }, 30_000)
})
