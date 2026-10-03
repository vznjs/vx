// An executor package that is not installed reached the user as Nx's
// "Unable to resolve <pkg>:<executor>." over Node's "Cannot find module
// '<pkg>/package.json'" and its require stack. nx-exec names the package
// in one line, and what to do; verbose logging keeps the whole error.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { fakeNx } from './helpers/fake-nx.js'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'nx-exec.cjs')
const GRAPH = {
  nodes: { app: { name: 'app', type: 'app', data: { root: 'packages/app', targets: {} } } },
  dependencies: { app: [] },
}
// Nx's wrapper over Node's resolver error, as Nx 23 builds it.
const NOT_INSTALLED =
  "Unable to resolve @acme/gone:build.\nCannot find module '@acme/gone/package.json'\nRequire stack:\n- /w/node_modules/nx/src/utils/package-json.js"
const NOT_IN_FILE =
  "Unable to resolve @acme/here:nope.\nCannot find executor 'nope' in /w/executors.json."

let root: string

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'vx-nx-exec-missing-'))
  await mkdir(path.join(root, 'packages', 'app'), { recursive: true })
  await mkdir(path.join(root, '.nx', 'workspace-data'), { recursive: true })
  await writeFile(path.join(root, 'package.json'), '{"name":"ws","private":true}')
  await writeFile(path.join(root, 'nx.json'), '{}')
  await writeFile(
    path.join(root, '.nx', 'workspace-data', 'project-graph.json'),
    JSON.stringify(GRAPH),
  )
  await fakeNx(root)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function run(throws: string, env: Record<string, string> = {}) {
  const clean = { ...process.env }
  delete clean['NX_DAEMON']
  delete clean['NX_VERBOSE_LOGGING']
  const p = Bun.spawn(
    [
      'node',
      BIN,
      'x:y',
      '--project',
      'app',
      '--target',
      't',
      '--options',
      JSON.stringify({ throws }),
    ],
    {
      cwd: path.join(root, 'packages', 'app'),
      env: { ...clean, ...env },
      stdout: 'ignore',
      stderr: 'pipe',
    },
  )
  const [err, code] = await Promise.all([new Response(p.stderr).text(), p.exited])
  return { code, err }
}

describe('nx-exec with an executor package that is not installed', () => {
  it('one line names the package and what to do', async () => {
    expect(await run(NOT_INSTALLED)).toEqual({
      code: 1,
      err: 'nx-exec: executor package "@acme/gone" is not installed in this workspace (@acme/gone:build) — add it to devDependencies, or write the task as the command the executor runs\n',
    })
  })

  it('verbose logging keeps the whole error', async () => {
    const r = await run(NOT_INSTALLED, { NX_VERBOSE_LOGGING: 'true' })
    expect(r.code).toBe(1)
    expect(r.err).toContain('Require stack:')
  })

  // Control: an installed package without the executor is not "not installed".
  it('a package without the executor keeps Nx’s message', async () => {
    expect((await run(NOT_IN_FILE)).err).toBe(
      `nx-exec: ${NOT_IN_FILE}\nSet NX_VERBOSE_LOGGING=true to see the stack trace.\n`,
    )
  })
})
