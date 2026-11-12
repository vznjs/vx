// A test for the example `uv()` lockfile plugin beside it: a throwaway
// Python workspace declares `uv()` and vx's own lock and plan drive it.
// `bun test` runs it.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { planRun, type Logger } from '@vzn/vx'

let root: string
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vx-plugin-fingerprint-'))
  Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: root })
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const VX = path.join(path.dirname(new URL(import.meta.resolve('@vzn/vx')).pathname), 'bin.ts')

/** A `uv.lock` where `api` needs `requests` at `version`, and `web` needs nothing. */
const uvLock = (version: string): string => `version = 1
requires-python = ">=3.12"

[manifest]
members = ["api", "web"]

[[package]]
name = "api"
version = "0.1.0"
source = { editable = "packages/api" }
dependencies = [{ name = "requests" }]

[[package]]
name = "requests"
version = "${version}"
source = { registry = "https://pypi.org/simple" }
sdist = { url = "https://example.invalid/requests-${version}.tar.gz", hash = "sha256:${version}" }

[[package]]
name = "web"
version = "0.1.0"
source = { editable = "packages/web" }
`

async function project(name: string): Promise<void> {
  const dir = path.join(root, 'packages', name)
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'main.py'), 'print("hi")\n')
  await writeFile(
    path.join(dir, 'vx.config.mjs'),
    `export default { name: '${name}', tasks: { build: {
      exec: { command: 'true' },
      inputs: { files: ['main.py'] }, outputs: { files: [] }, cache: true,
    } } }\n`,
  )
}

function lock(): void {
  const r = Bun.spawnSync({ cmd: [process.execPath, VX, 'lock'], cwd: root })
  expect([r.exitCode, r.stderr.toString()]).toEqual([0, ''])
}

const quiet: Logger = {
  status() {},
  taskStart() {},
  taskStdout() {},
  taskStderr() {},
  taskComplete() {},
}

async function keys(): Promise<Record<string, string | undefined>> {
  const plan = await planRun({ cwd: root, tasks: ['api#build', 'web#build'], log: quiet })
  return Object.fromEntries(plan.tasks.map((t) => [t.node.id, t.hash]))
}

it('a dependency bump moves the key of the member that reaches it, and only that one', async () => {
  await project('api')
  await project('web')
  const from = JSON.stringify(path.join(import.meta.dir, 'uv.ts'))
  await Bun.write(
    path.join(root, '.vx/workspace.mjs'),
    `import { uv } from ${from}\nexport default { plugins: [uv()] }\n`,
  )
  await writeFile(path.join(root, 'uv.lock'), uvLock('2.32.3'))
  lock()
  const before = await keys()
  expect(before['api#build']).toBeDefined()
  expect(await keys()).toEqual(before)

  await writeFile(path.join(root, 'uv.lock'), uvLock('2.32.4'))
  lock()
  const after = await keys()
  expect(after['api#build']).not.toBe(before['api#build'])
  expect(after['web#build']).toBe(before['web#build'])
}, 20_000)
