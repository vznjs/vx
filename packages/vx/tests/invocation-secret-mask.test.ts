// The run's invocation line is stored in cache.db and `vx last` prints it.
// A secret passed after `--` (`-- --token=$NPM_TOKEN`) was masked in the
// task's own output but kept whole there (L-35). Since the line keeps the
// args shell-quoted (X-45), a value holding a `'` is stored as the shell
// spells it, which the plain value no longer matched.
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'bun:test'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
const SECRET = 'supersecretvalue123'
let root: string | undefined

afterAll(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
})

async function walk(dir: string): Promise<string[]> {
  const out: string[] = []
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...(await walk(p)))
    else out.push(p)
  }
  return out
}

async function lastLine(secret: string): Promise<{ line: string[]; holding: string[] }> {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = await mkdtemp(path.join(os.tmpdir(), 'vx-inv-mask-'))
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'r', private: true, workspaces: ['packages/*'] }),
  )
  const dir = path.join(root, 'packages', 'a')
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'a' }))
  await writeFile(
    path.join(dir, 'vx.config.mjs'),
    `export default { tasks: { deploy: { exec: { command: 'echo deploying' } } } }\n`,
  )
  expect(Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: root }).exitCode).toBe(0)
  const env = { ...process.env, NPM_TOKEN: secret }
  const run = Bun.spawnSync({
    cmd: [process.execPath, BIN, 'run', 'a#deploy', '--', `--token=${secret}`],
    cwd: root,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  expect(run.exitCode).toBe(0)
  const last = Bun.spawnSync({
    cmd: [process.execPath, BIN, 'last'],
    cwd: root,
    env,
    stdout: 'pipe',
  })
  const line = last.stdout
    .toString()
    .split('\n')
    .filter((l) => l.startsWith('  $ '))
  const holding: string[] = []
  for (const f of await walk(path.join(root, '.vx')))
    if ((await readFile(f)).includes(secret.slice(-8))) holding.push(path.relative(root, f))
  return { line, holding }
}

describe('a secret forwarded after -- in the invocation line', () => {
  it('is masked in vx last and absent from the cache directory', async () => {
    expect(await lastLine(SECRET)).toEqual({
      line: ['  $ vx run a#deploy -- --token=***'],
      holding: [],
    })
  })

  it('a value holding a quote is masked as the shell-quoted line spells it (X-45)', async () => {
    expect(await lastLine("super'secretvalue123")).toEqual({
      line: ["  $ vx run a#deploy -- '--token=***'"],
      holding: [],
    })
  })
})
