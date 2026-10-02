// The run's invocation line is stored in cache.db and `vx last` prints it.
// A secret passed after `--` (`-- --token=$NPM_TOKEN`) was masked in the
// task's own output but kept whole there (L-35).
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

describe('a secret forwarded after -- in the invocation line', () => {
  it('is masked in vx last and absent from the cache directory', async () => {
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
    const env = { ...process.env, NPM_TOKEN: SECRET }
    const run = Bun.spawnSync({
      cmd: [process.execPath, BIN, 'run', 'a#deploy', '--', `--token=${SECRET}`],
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
    expect(
      last.stdout
        .toString()
        .split('\n')
        .filter((l) => l.startsWith('  $ ')),
    ).toEqual(['  $ vx run a#deploy -- --token=***'])
    const holding: string[] = []
    for (const f of await walk(path.join(root, '.vx')))
      if ((await readFile(f)).includes(SECRET)) holding.push(path.relative(root, f))
    expect(holding).toEqual([])
  })
})
