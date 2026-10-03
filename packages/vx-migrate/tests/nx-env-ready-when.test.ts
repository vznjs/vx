// A run-commands target with several `readyWhen` strings is ready, in Nx,
// once every one has appeared in its output, stdout or stderr. vx's
// `readyWhen` is one pattern matched per line, so the line ran ready on the
// first string, with a TODO. It runs under `nx-env --ready-when`, which
// passes the streams through and prints `nx-env: ready` once all have
// been seen; the task's `readyWhen` matches that line.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { ProjectMeta } from '@vzn/vx'
import { mapNxWorkspace, parseNxGraph } from '../src/nx/nx-map.js'
import { fakeNx } from './helpers/fake-nx.js'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'nx-env.cjs')

let root: string

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'vx-nx-env-ready-'))
  await mkdir(path.join(root, 'packages', 'app'), { recursive: true })
  await writeFile(path.join(root, 'package.json'), '{"name":"ws","private":true}')
  await fakeNx(root)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function nxEnv(line: string, strings: string[]) {
  const p = Bun.spawn(['node', BIN, ...strings.flatMap((s) => ['--ready-when', s]), '--', line], {
    cwd: path.join(root, 'packages', 'app'),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ])
  return { code, out, err }
}

describe('nx-env --ready-when', () => {
  it('ready once every string has appeared, on either stream', async () => {
    expect(await nxEnv('echo api up; echo web up >&2', ['api up', 'web up'])).toEqual({
      code: 0,
      out: 'api up\nnx-env: ready\n',
      err: 'web up\n',
    })
  })

  it('a string split across two writes is seen', async () => {
    const r = await nxEnv("printf 'ap'; sleep 0.05; printf 'i up\\n'; echo web up", [
      'api up',
      'web up',
    ])
    expect(r.out).toBe('api up\nweb up\nnx-env: ready\n')
  })

  // Control: one string missing is never ready; the exit and streams pass through.
  it('one missing is not ready; the exit code and stderr pass through', async () => {
    expect(await nxEnv('echo api up; echo oops >&2; exit 3', ['api up', 'web up'])).toEqual({
      code: 3,
      out: 'api up\n',
      err: 'oops\n',
    })
  })
})

describe('the mapper waits for every readyWhen string', () => {
  it('several strings: the line under nx-env --ready-when, readyWhen its ready line, no TODO', async () => {
    const graph = {
      nodes: {
        app: {
          name: 'app',
          data: {
            root: 'packages/app',
            targets: {
              serve: {
                continuous: true,
                executor: 'nx:run-commands',
                options: { commands: ['api', 'web'], readyWhen: ['api up', 'web up'] },
              },
            },
          },
        },
      },
      dependencies: { app: [] },
    }
    const meta: ProjectMeta = {
      name: 'app',
      dir: path.join(root, 'packages', 'app'),
      packageJson: { name: 'app' },
      configPath: null,
    }
    const mapped = await mapNxWorkspace(root, [meta], parseNxGraph(JSON.stringify(graph), 'g'), {
      persistentTodo: 'p',
      cacheable: new Set(),
    })
    const serve = mapped.projects[0]!.tasks.find((t) => t.name === 'serve')!
    const exec = serve.task!['exec'] as { command: string; persistent: { readyWhen?: string } }
    expect(exec.command.startsWith("nx-env --ready-when 'api up' --ready-when 'web up' -- ")).toBe(
      true,
    )
    expect(exec.persistent).toEqual({ readyWhen: '^nx-env: ready$' })
    expect(serve.todos.filter((t) => t.includes('readyWhen'))).toEqual([])
  })
})
