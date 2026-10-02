// `nx-exec` runs an executor where Nx would: Nx forks it in the directory
// Nx was started from, the workspace root (`forked-process-task-runner`),
// and vx starts a task in its project dir. A workspace-local executor that
// records `process.cwd()` reads the same directory under both. Live against
// `VX_NX_MODULES`, as `nx-exec-live` is.
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

describe.skipIf(!MODULES)('nx-exec runs an executor from the workspace root', () => {
  beforeAll(async () => {
    root = await realpath(await mkdtemp(path.join(tmpdir(), 'vx-nx-exec-cwd-')))
    await symlink(path.join(MODULES!, 'node_modules'), path.join(root, 'node_modules'))
    await writeFile(
      path.join(root, 'package.json'),
      '{"name":"live","private":true,"workspaces":["tools/*"]}',
    )
    await writeFile(path.join(root, 'nx.json'), '{}')
    // A local plugin: a workspace project whose package names its executors.
    const plugin = path.join(root, 'tools', 'where')
    await mkdir(plugin, { recursive: true })
    await writeFile(
      path.join(plugin, 'package.json'),
      '{"name":"where","version":"0.0.0","executors":"./executors.json"}',
    )
    await writeFile(
      path.join(plugin, 'executors.json'),
      '{"executors":{"cwd":{"implementation":"./cwd.js","schema":"./schema.json"}}}',
    )
    await writeFile(path.join(plugin, 'schema.json'), '{"type":"object","properties":{}}')
    await writeFile(
      path.join(plugin, 'cwd.js'),
      "const fs = require('node:fs'), path = require('node:path')\n" +
        'module.exports = async function (_options, context) {\n' +
        "  fs.writeFileSync(path.join(context.root, 'cwd.txt'), path.relative(context.root, process.cwd()) || '.')\n" +
        '  return { success: true }\n' +
        '}\n',
    )
    await writeFile(path.join(plugin, 'project.json'), '{"name":"where"}')
    const lib = path.join(root, 'packages', 'lib')
    await mkdir(lib, { recursive: true })
    await writeFile(
      path.join(lib, 'project.json'),
      '{"name":"lib","targets":{"where":{"executor":"./tools/where:cwd"}}}',
    )
  })
  afterAll(async () => {
    if (root) await rm(root, { recursive: true, force: true })
  })

  it(
    'process.cwd() is the workspace root under nx run and under nx-exec',
    async () => {
      const env = {
        PATH: process.env['PATH']!,
        HOME: process.env['HOME']!,
        NX_DAEMON: 'false',
        NX_TUI: 'false',
        NX_NO_CLOUD: 'true',
        NX_ISOLATE_PLUGINS: 'false',
      }
      const out = path.join(root, 'cwd.txt')
      const run = async (cmd: string[], cwd: string): Promise<string> => {
        await rm(out, { force: true })
        const p = Bun.spawn(cmd, { cwd, env, stdout: 'pipe', stderr: 'pipe' })
        const [o, e, code] = await Promise.all([
          new Response(p.stdout).text(),
          new Response(p.stderr).text(),
          p.exited,
        ])
        expect({ code, tail: code === 0 ? '' : o + e }).toEqual({ code: 0, tail: '' })
        return Bun.file(out).text()
      }
      const byNx = await run(
        [path.join(root, 'node_modules', '.bin', 'nx'), 'run', 'lib:where', '--skip-nx-cache'],
        root,
      )
      const byVx = await run(
        ['node', BIN, './tools/where:cwd', '--project', 'lib', '--target', 'where'],
        path.join(root, 'packages', 'lib'),
      )
      expect({ nx: byNx, vx: byVx }).toEqual({ nx: '.', vx: '.' })
    },
    TIMEOUT,
  )
})
