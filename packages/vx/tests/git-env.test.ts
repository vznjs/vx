// A `git` vx runs got vx's whole env, and is readable after its `exec`
// like any child, so a same-user task could read a token vx never passed
// it there (`vx watch` runs git while its tasks run). It now gets what git
// reads and nothing else (`gitEnv`, util/hide-env.ts).
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, expect, it } from 'bun:test'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
let root: string | undefined

afterAll(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
})

it('every git vx runs sees the git and locale variables, not the rest', async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vx-git-env-'))
  const real = Bun.which('git')!
  const shim = path.join(root, 'bin')
  const seen = path.join(root, 'seen')
  await mkdir(shim)
  await mkdir(seen)
  await writeFile(
    path.join(shim, 'git'),
    // One file per git run: runs overlap.
    `#!/bin/sh\nenv | grep -E '^(VX_TEST_CANARY|GIT_CONFIG_NOSYSTEM|HOME)=' | sed 's/=.*//' > "$(mktemp ${JSON.stringify(seen)}/XXXXXX)"\nexec ${JSON.stringify(real)} "$@"\n`,
  )
  await chmod(path.join(shim, 'git'), 0o755)
  const ws = path.join(root, 'ws')
  await mkdir(path.join(ws, 'packages', 'a'), { recursive: true })
  await writeFile(
    path.join(ws, 'package.json'),
    JSON.stringify({ name: 'r', private: true, workspaces: ['packages/*'] }),
  )
  await writeFile(path.join(ws, 'vx.workspace.mjs'), 'export default {}\n')
  await writeFile(path.join(ws, 'packages', 'a', 'package.json'), JSON.stringify({ name: 'a' }))
  await writeFile(
    path.join(ws, 'packages', 'a', 'vx.config.mjs'),
    `export default { tasks: { build: { exec: { command: 'true' }, cache: { inputs: { files: ['package.json'] }, outputs: { files: [] } } } } }\n`,
  )
  expect(Bun.spawnSync({ cmd: [real, 'init', '-q'], cwd: ws }).exitCode).toBe(0)
  const r = Bun.spawnSync({
    cmd: [process.execPath, BIN, 'run', 'a#build'],
    cwd: ws,
    env: {
      ...process.env,
      PATH: `${shim}${path.delimiter}${process.env['PATH']}`,
      VX_TEST_CANARY: 'secret',
      GIT_CONFIG_NOSYSTEM: '1',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  expect(r.exitCode, r.stderr.toString()).toBe(0)
  const runs = await Promise.all(
    (await readdir(seen)).map(async (f) =>
      (await readFile(path.join(seen, f), 'utf8')).trim().split('\n').sort().join(' '),
    ),
  )
  expect(runs.length).toBeGreaterThan(0)
  expect([...new Set(runs)]).toEqual(['GIT_CONFIG_NOSYSTEM HOME'])
})
