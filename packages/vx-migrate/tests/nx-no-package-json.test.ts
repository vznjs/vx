// Nx runs a repo with no package.json at all: `nx init` in a Gradle, .NET
// or Go repo pins Nx in `.nx/installation` and projects are `project.json`
// files. `vx init` handed such a repo here (it has nx.json) and this
// refused it for want of a package.json, pointing back at `vx init`: a
// loop, so the repo Nx runs could not be set up at all. Nothing is
// installable here, so the migration writes configs core runs alone: Nx
// names, Nx's graph edges as explicit edges (a `^` edge needs a lockfile
// plugin), no plugin, no package.json.
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'

const MIGRATE = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
const VX = path.resolve(import.meta.dir, '..', '..', 'vx', 'src', 'bin.ts')

const GRAPH = {
  graph: {
    nodes: {
      a: {
        name: 'a',
        type: 'lib',
        data: {
          root: 'libs/a',
          targets: {
            build: {
              executor: 'nx:run-commands',
              options: { command: 'mkdir -p libs/a/dist && cp libs/a/src/x libs/a/dist/x' },
              inputs: ['{projectRoot}/src/**'],
              outputs: ['{projectRoot}/dist'],
              cache: true,
            },
          },
        },
      },
      b: {
        name: 'b',
        type: 'app',
        data: {
          root: 'apps/b',
          targets: {
            build: {
              executor: 'nx:run-commands',
              options: {
                command: 'mkdir -p apps/b/dist && cat libs/a/dist/x apps/b/src/y > apps/b/dist/out',
              },
              dependsOn: ['^build'],
              inputs: ['{projectRoot}/src/**'],
              outputs: ['{projectRoot}/dist'],
              cache: true,
            },
          },
        },
      },
    },
    dependencies: { a: [], b: [{ source: 'b', target: 'a', type: 'implicit' }] },
  },
}

let root: string
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'vx-nx-no-pkg-'))
  const write = async (rel: string, body: string) => {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true })
    await writeFile(path.join(root, rel), body)
  }
  await write('nx.json', '{"installation":{"version":"22.0.0"}}\n')
  await write('libs/a/project.json', '{"name":"a"}\n')
  await write('apps/b/project.json', '{"name":"b","implicitDependencies":["a"]}\n')
  await write('libs/a/src/x', 'x\n')
  await write('apps/b/src/y', 'y\n')
  await write('graph.json', JSON.stringify(GRAPH))
  // Where Nx's own wrapper installs it; its only verb here is the export.
  const nx = '.nx/installation/node_modules/.bin/nx'
  await write(
    nx,
    `#!/bin/sh\ncase "$2" in --file=*) cp ${JSON.stringify(path.join(root, 'graph.json'))} "\${2#--file=}" ;; *) exit 9 ;; esac\n`,
  )
  await chmod(path.join(root, nx), 0o755)
  await write('.gitignore', '.nx/installation/node_modules\ngraph.json\n')
  Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: root })
  Bun.spawnSync({ cmd: ['git', 'add', '-A'], cwd: root })
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function run(cmd: string[]): Promise<{ code: number; out: string }> {
  const p = Bun.spawn([process.execPath, '--no-install', ...cmd], {
    cwd: root,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, NO_COLOR: '1', CI: '' },
  })
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ])
  return { code, out: out + err }
}

it('maps an Nx repo with no package.json to configs core runs alone', async () => {
  const migrated = await run([MIGRATE, '--native'])
  expect(migrated).toMatchObject({ code: 0 })
  const listed = Bun.spawnSync({
    cmd: ['git', 'ls-files', '-o', '--exclude-standard'],
    cwd: root,
  }).stdout.toString()
  expect(listed.split('\n').filter(Boolean).sort()).toEqual([
    '.vx/.gitattributes',
    '.vx/.gitignore',
    '.vx/projects.lock.json',
    '.vx/workspace.ts',
    'apps/b/vx.config.ts',
    'apps/b/vx.lock.json',
    'libs/a/vx.config.ts',
    'libs/a/vx.lock.json',
  ])
  expect(await readFile(path.join(root, '.vx', 'workspace.ts'), 'utf8')).not.toContain(
    "from '@vzn/vx-",
  )
  const b = await readFile(path.join(root, 'apps', 'b', 'vx.config.ts'), 'utf8')
  expect(b).toContain("name: 'b'")
  expect(b).toContain("dependsOn: ['a#build']")

  const built = await run([VX, 'run', 'build', '--all'])
  expect(built).toMatchObject({ code: 0 })
  expect(await readFile(path.join(root, 'apps', 'b', 'dist', 'out'), 'utf8')).toBe('x\ny\n')
})

it('refuses --keep: no plugin can be installed without a package.json', async () => {
  const kept = await run([MIGRATE, '--keep'])
  expect(kept.code).toBe(1)
  expect(kept.out).toContain('--keep')
  expect(kept.out).toContain('package.json')
})
