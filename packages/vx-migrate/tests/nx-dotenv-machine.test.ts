// nx() kept only the `.env` files on this disk, and the lock records the
// mapping: a gitignored `.env.local` put `--dotenv .env.local` and a probe in
// the lock, and a fresh clone without it failed `vx lock --check`. Executor
// lines now pass Nx's whole candidate list, and a shell line loads `.env`
// files only when one is committed: the same on every machine.
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { dotenvCandidates } from '../src/nx/nx-dotenv.js'
import { mapNxWorkspace, type NxGraph } from '../src/nx/nx-map.js'
import { trackedFiles, trackedKinds } from '../src/tracked-outputs.js'

let root: string
beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), 'vx-nx-dotenv-machine-')))
  await mkdir(path.join(root, 'packages', 'lib', 'src'), { recursive: true })
  await writeFile(path.join(root, 'packages', 'lib', 'package.json'), '{"name":"lib"}')
  await writeFile(path.join(root, 'packages', 'lib', 'src', 'a.ts'), '')
  await writeFile(path.join(root, '.gitignore'), '.env.local\n')
  git('init', '-q')
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const git = (...args: string[]) =>
  expect(Bun.spawnSync(['git', ...args], { cwd: root, stderr: 'pipe' }).exitCode).toBe(0)

async function mapped() {
  const targets = {
    build: { command: 'tsc', cache: true, inputs: ['{projectRoot}/src/**/*'], outputs: [] },
    test: { executor: '@nx/jest:jest', cache: true, inputs: ['{projectRoot}/src/**/*'] },
  }
  const graph = {
    nodes: { lib: { data: { root: 'packages/lib', targets } } },
    dependencies: { lib: [] },
  } as unknown as NxGraph
  const meta = {
    name: 'lib',
    dir: path.join(root, 'packages', 'lib'),
    packageJson: { name: 'lib' } as never,
    configPath: null,
  }
  const tracked = trackedKinds((await trackedFiles(root))!)
  const m = await mapNxWorkspace(root, [meta], graph, { cacheable: new Set(), tracked })
  const tasks = Object.fromEntries(m.projects[0]!.tasks.map((t) => [t.name, t.task]))
  return { tasks: tasks as Record<string, Record<string, any>>, notes: m.notes }
}

const candidates = (target: string) =>
  dotenvCandidates('packages/lib', target, undefined, undefined).map((f) =>
    path.posix.relative('packages/lib', f),
  )

it('maps the same with or without an uncommitted .env.local', async () => {
  git('add', '-A')
  const clone = await mapped()
  await writeFile(path.join(root, 'packages', 'lib', '.env.local'), 'SECRET=1\n')
  const dev = await mapped()
  expect(JSON.stringify(dev.tasks)).toBe(JSON.stringify(clone.tasks))
  expect(clone.tasks['build']!['exec'].command).toBe('cd ../.. && tsc')
  // The machine that has it is told the shell line does not load it.
  expect(dev.notes.join('\n')).toContain('packages/lib/.env.local')
  expect(clone.notes.join('\n')).not.toContain('.env.local')
})

it('a committed .env wraps the shell line; an executor line lists every candidate', async () => {
  await writeFile(path.join(root, 'packages', 'lib', '.env'), 'A=1\n')
  git('add', '-A')
  const { tasks } = await mapped()
  const build = tasks['build']!
  const flags = (names: readonly string[]) => names.map((f) => `--dotenv ${f}`).join(' ')
  expect(build['exec'].command).toBe(`nx-env ${flags(candidates('build'))} -- 'cd ../.. && tsc'`)
  expect(tasks['test']!['exec'].command).toContain(` ${flags(candidates('test'))}`)
  for (const [name, t] of Object.entries(tasks)) {
    const all = candidates(name)
    // The project's own as `files`, the root's as `workspaceFiles`: literals,
    // keyed present or not.
    expect(t['inputs'].files).toEqual(
      expect.arrayContaining(all.filter((f) => !f.startsWith('../'))),
    )
    expect(t['inputs'].workspaceFiles).toEqual(
      expect.arrayContaining(all.filter((f) => f.startsWith('../')).map((f) => f.slice(6))),
    )
    expect(t['inputs'].runtime).toBeUndefined()
    expect(t['inputs'].env).toContain('NX_LOAD_DOT_ENV_FILES')
    expect(t['exec'].env.passThrough).toContain('NX_LOAD_DOT_ENV_FILES')
  }
})
