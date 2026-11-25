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
import { BIN } from './helpers/vx.js'

const roots: string[] = []

afterAll(async () => {
  for (const r of roots) await rm(r, { recursive: true, force: true })
})

async function lock(tasks: string): Promise<{ code: number; err: string; locked: string }> {
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
  await writeFile(path.join(dir, '.env.example'), 'A=\n')
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
  let locked = ''
  for await (const f of new Bun.Glob('.vx/*.lock').scan({ cwd: root, dot: true }))
    locked += await Bun.file(path.join(root, f)).text()
  return { code: r.exitCode, err: r.stderr.toString(), locked }
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

  // create-t3-turbo's vx-migrate output passes NODE_ENV through on every
  // task (Turbo's globalPassThroughEnv): one line per task was 78 lines.
  it('names a finding once for every task it holds for', async () => {
    const pass = { passThrough: ['NODE_ENV'] }
    const r = await lock(
      ['a', 'b', 'c', 'd', 'e'].map((n) => task(n, { files: ['src/**'] }, pass)).join(', '),
    )
    expect(r.code).toBe(0)
    const lines = r.err.split('\n').filter((l) => l.includes('forwards NODE_ENV'))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain(
      'packages/app#a, packages/app#b and 3 more tasks: exec.env.passThrough forwards NODE_ENV,',
    )
  })

  it('names a bundler variable inputs.env keys that the child never gets', async () => {
    const r = await lock(
      task(
        'build',
        { files: ['src/**'], env: ['VITE_API_URL', 'NODE_ENV', 'VITE_MODE', 'BUILD_ID'] },
        {
          define: { VITE_MODE: 'prod' },
        },
      ),
    )
    expect(r.code).toBe(0)
    expect(r.err).toContain(
      'packages/app#build: inputs.env keys VITE_API_URL, NODE_ENV, which a bundler writes into its output, but the command never gets them — add them to exec.env.passThrough',
    )
    expect(r.err).not.toContain('VITE_MODE')
    expect(r.err).not.toContain('BUILD_ID')
  })

  it('says nothing once the file is named, the name is keyed, or the task is not cached', async () => {
    const r = await lock(
      [
        task(
          'named',
          { files: ['src/**', '.env*', '.env.production.local'], env: ['VITE_API_URL'] },
          { passThrough: ['VITE_API_URL', 'CI'] },
        ),
        task(
          'secret',
          { files: ['src/**', '!.env*'] },
          { passThrough: ['VITE_DSN'], secret: ['VITE_DSN'] },
        ),
        task('excluded', { files: ['src/**', '.env*', '!.env.production.local'] }),
        task('dev', { files: ['src/**'] }, { passThrough: ['VITE_API_URL'] }, false),
      ].join(', '),
    )
    expect({ code: r.code, err: r.err }).toEqual({ code: 0, err: '' })
  })

  // `['**']` keys every file git lists, and `.env.production.local` is not one.
  it('names an ignored .env file a cached task reads through `**`', async () => {
    const r = await lock(task('all', { files: ['**'] }))
    expect(r.code).toBe(0)
    expect(r.err).toContain(
      "packages/app#all: inputs leave out git-ignored .env.production.local (matched by **) — a glob reads only what git lists; name it as a literal input ('.env.production.local') to key on it",
    )
    expect(r.err).not.toContain('gen.local')
    expect(r.err.match(/inputs leave out/g)?.length).toBe(1)
  })

  // Vite, Next and Bun load `.env` and `.env.<mode>.local` beside the config
  // on their own: `src/**` alone replayed the old bundle after an edit.
  it('names a dotenv file beside the config that no input of a build names', async () => {
    const r = await lock(
      [task('build', { files: ['src/**'] }), task('lint', { files: ['src/**'] })]
        .join(', ')
        .replace(`"outputs":{"files":["lint/**"]}`, `"outputs":{"files":[]}`),
    )
    expect(r.code).toBe(0)
    expect(r.err).toContain(
      "packages/app#build: .env, .env.production.local beside its config are in no input, and Vite, Next and Bun load them on their own — add '.env*' to inputs.files, or '!.env*' if the task reads none",
    )
    // A task with no outputs builds nothing a value is inlined into.
    expect(r.err).not.toContain('app#lint')
  })

  // A runtime probe that prints a file's path keys it (turbo()'s `.env`
  // probe); one that names other files leaves the rest named.
  it('names no dotenv file a runtime probe prints, and still names the rest', async () => {
    const r = await lock(task('build', { files: ['src/**'], runtime: ['echo .env; echo vite 6'] }))
    expect(r.code).toBe(0)
    expect(r.err).toContain(
      'packages/app#build: .env.production.local beside its config is in no input',
    )
  })

  // The lock asks a probe only to spare a note: one that hangs, fails or
  // prints junk costs the note, never the lock, and nothing it prints is
  // locked.
  it('bounds a hung, failing or junk probe and locks none of its output', async () => {
    const started = Date.now()
    const r = await lock(
      [
        task('build', { files: ['src/**'], runtime: ['sleep 60; echo .env'] }),
        task('fail', { files: ['src/**'], runtime: ["printf 'PROBE_%s' JUNK; exit 3"] }),
        task('junk', { files: ['src/**'], runtime: ["printf '\\377PROBE_%s .env' JUNK"] }),
      ].join(', '),
    )
    expect(Date.now() - started).toBeLessThan(25_000)
    expect(r.code).toBe(0)
    expect(r.err).toContain('packages/app#build, packages/app#fail, packages/app#junk: .env,')
    expect(r.err).not.toContain('PROBE_JUNK')
    expect(r.locked).not.toContain('PROBE_JUNK')
  }, 60_000)

  // The probes shared one deadline but ran one task after another: a third
  // 2 s probe started at 4 s and got 1 s, so a probe that keys `.env` still
  // left the note on its task.
  it('asks every probe under the one deadline at once', async () => {
    const r = await lock(
      ['a', 'b', 'c']
        .map((n) => task(n, { files: ['src/**'], runtime: [`sleep 2; echo .env # ${n}`] }))
        .join(', '),
    )
    expect(r.code).toBe(0)
    expect(r.err).toContain(
      'packages/app#a, packages/app#b, packages/app#c: .env.production.local beside its config is in no input',
    )
    expect(r.err).not.toContain('.env, .env.production.local')
  }, 30_000)

  it('names Bun and Nx public variables only passThrough names', async () => {
    const r = await lock(
      task(
        'build',
        { files: ['src/**', '.env*', '.env.production.local'] },
        { passThrough: ['BUN_PUBLIC_API', 'NX_PUBLIC_SITE'] },
      ),
    )
    expect(r.err).toContain(
      'packages/app#build: exec.env.passThrough forwards BUN_PUBLIC_API, NX_PUBLIC_SITE, which a bundler writes into its output',
    )
  })
})
