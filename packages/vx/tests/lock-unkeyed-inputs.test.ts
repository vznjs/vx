// What a cached task reads that its key never sees, named at `vx lock`:
// a glob is a filter over what git lists, so `.env*` leaves out an ignored
// `.env.production.local` (Vite and Next load it for a production build),
// and a run named it only on a miss, which a stale hit never brings. A
// `passThrough` name a bundler inlines (`VITE_API_URL`) is not keyed
// either unless `inputs.env` names it too.
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'bun:test'
import { localWorkspaceSource } from './helpers/local-workspace.js'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
const roots: string[] = []

afterAll(async () => {
  for (const r of roots) await rm(r, { recursive: true, force: true })
})

async function lock(tasks: string): Promise<{ code: number; err: string }> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'vx-lock-unkeyed-')))
  roots.push(root)
  await Bun.write(path.join(root, '.vx/workspace.mjs'), localWorkspaceSource())
  await writeFile(path.join(root, '.gitignore'), '*.local\n')
  const dir = path.join(root, 'packages', 'app')
  await mkdir(path.join(dir, 'src'), { recursive: true })
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'app' }))
  await writeFile(path.join(dir, 'src', 'main.js'), 'export {}\n')
  await writeFile(path.join(dir, '.env'), 'A=1\n')
  await writeFile(path.join(dir, '.env.production.local'), 'A=2\n')
  await writeFile(path.join(dir, 'gen.local'), 'out\n')
  await writeFile(path.join(dir, 'vx.config.mjs'), `export default { tasks: { ${tasks} } }\n`)
  expect(Bun.spawnSync(['git', 'init', '-q'], { cwd: root }).exitCode).toBe(0)
  const r = Bun.spawnSync({
    cmd: [process.execPath, BIN, 'lock'],
    cwd: root,
    env: { ...process.env, HOME: root },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return { code: r.exitCode, err: r.stderr.toString() }
}

const task = (name: string, inputs: object, env: object = {}, cache = true): string =>
  `${name}: ${JSON.stringify({
    exec: { command: 'vite build', env },
    inputs,
    outputs: { files: name === 'build' ? ['dist/**', 'gen.local'] : [`${name}/**`] },
    cache,
  })}`

describe('vx lock and what a key never sees', () => {
  it('names an ignored file a glob matches and a bundler variable only passThrough names', async () => {
    const r = await lock(
      task(
        'build',
        { files: ['src/**', '.env*', '*.local'] },
        { passThrough: ['VITE_API_URL', 'NEXT_PUBLIC_SITE', 'CI', 'VITE_API_TOKEN'] },
      ),
    )
    expect(r.code).toBe(0)
    expect(r.err).toContain(
      "packages/app#build: inputs leave out git-ignored .env.production.local (matched by .env*) — a glob reads only what git lists; name it as a literal input ('.env.production.local') to key on it",
    )
    expect(r.err).toContain(
      'packages/app#build: exec.env.passThrough forwards VITE_API_URL, NEXT_PUBLIC_SITE, which a bundler writes into its output, and the key does not see them — add them to inputs.env',
    )
    // Its own output, a tracked-or-not name, CI and a secret say nothing.
    expect(r.err).not.toContain('gen.local')
    expect(r.err).not.toContain('CI,')
    expect(r.err).not.toContain('VITE_API_TOKEN')
    expect(r.err.match(/packages\/app#build/g)?.length).toBe(2)
  })

  it('says nothing once the file is named, the name is keyed, or the task is not cached', async () => {
    const r = await lock(
      [
        task(
          'named',
          { files: ['src/**', '.env*', '.env.production.local'], env: ['VITE_API_URL'] },
          { passThrough: ['VITE_API_URL', 'CI'] },
        ),
        task('secret', { files: ['src/**'] }, { passThrough: ['VITE_DSN'], secret: ['VITE_DSN'] }),
        task('excluded', { files: ['src/**', '.env*', '!.env.production.local'] }),
        task('dev', { files: ['src/**'] }, { passThrough: ['VITE_API_URL'] }, false),
      ].join(', '),
    )
    expect(r).toEqual({ code: 0, err: '' })
  })
})
