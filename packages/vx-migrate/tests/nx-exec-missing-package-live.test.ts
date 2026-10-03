// The not-installed refusal against REAL Nx: its own "Unable to resolve"
// over Node's resolver error is what nx-exec turns into one line naming
// the package. Live against `VX_NX_MODULES`, as `nx-exec-live` is.
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'nx-exec.cjs')
const MODULES = process.env['VX_NX_MODULES']
if (process.env['VX_REQUIRE_NX'] === '1' && !MODULES) {
  throw new Error('VX_REQUIRE_NX=1 but VX_NX_MODULES is unset — the live nx-exec suite cannot run')
}
const TIMEOUT = 120_000

let root: string

describe.skipIf(!MODULES)('nx-exec names an executor package that is not installed', () => {
  beforeAll(async () => {
    root = await realpath(await mkdtemp(path.join(tmpdir(), 'vx-nx-exec-missing-')))
    await symlink(path.join(MODULES!, 'node_modules'), path.join(root, 'node_modules'))
    await writeFile(path.join(root, 'package.json'), '{"name":"live","private":true}')
    await writeFile(path.join(root, 'nx.json'), '{}')
    const lib = path.join(root, 'packages', 'lib')
    await mkdir(lib, { recursive: true })
    await writeFile(path.join(lib, 'project.json'), '{"name":"lib","targets":{}}')
  })
  afterAll(async () => {
    if (root) await rm(root, { recursive: true, force: true })
  })

  // Without a tsconfig Nx's local-plugin lookup says so; with one, Node's
  // "Cannot find module" comes through. Both are the same refusal.
  it.each([
    ['no tsconfig', undefined],
    ['a tsconfig.base.json', '{"compilerOptions":{"paths":{}}}'],
  ])(
    'one line, exit 1 (%s)',
    async (_name, tsconfig) => {
      const base = path.join(root, 'tsconfig.base.json')
      if (tsconfig === undefined) await rm(base, { force: true })
      else await writeFile(base, tsconfig)
      const env = {
        PATH: process.env['PATH']!,
        HOME: process.env['HOME']!,
        NX_DAEMON: 'false',
        NX_NO_CLOUD: 'true',
        NX_ISOLATE_PLUGINS: 'false',
      }
      const p = Bun.spawn(
        ['node', BIN, '@acme/not-installed:build', '--project', 'lib', '--target', 'build'],
        { cwd: path.join(root, 'packages', 'lib'), env, stdout: 'ignore', stderr: 'pipe' },
      )
      const [err, code] = await Promise.all([new Response(p.stderr).text(), p.exited])
      expect({ code, err }).toEqual({
        code: 1,
        err: 'nx-exec: executor package "@acme/not-installed" is not installed in this workspace (@acme/not-installed:build) — add it to devDependencies, or write the task as the command the executor runs\n',
      })
    },
    TIMEOUT,
  )
})
