// The run's invocation line is stored in cache.db and `vx last` prints it.
// A secret passed after `--` (`-- --token=$NPM_TOKEN`) was masked in the
// task's own output but kept whole there (L-35). Since the line keeps the
// args shell-quoted (X-45), a value holding a `'` is stored as the shell
// spells it, which the plain value no longer matched.
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'bun:test'
import { localWorkspaceSource } from './helpers/local-workspace.js'

const BIN = path.resolve(import.meta.dir, 'helpers', 'vx-locked.ts')
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

async function lastLine(
  secret: string,
  // Where the secret lives: vx's own environment, or only the task's config.
  from: { exec: string; env: Record<string, string> } = {
    exec: `{ command: 'echo deploying' }`,
    env: { NPM_TOKEN: secret },
  },
): Promise<{ line: string[]; holding: string[] }> {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = await mkdtemp(path.join(os.tmpdir(), 'vx-inv-mask-'))
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'r', private: true, workspaces: ['packages/*'] }),
  )
  await Bun.write(path.join(root, '.vx/workspace.mjs'), localWorkspaceSource())
  const dir = path.join(root, 'packages', 'a')
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'a' }))
  await writeFile(
    path.join(dir, 'vx.config.mjs'),
    `export default { tasks: { deploy: { exec: ${from.exec} } } }\n`,
  )
  expect(Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: root }).exitCode).toBe(0)
  const env = { ...process.env, ...from.env }
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
  for (const f of await walk(path.join(root, '.vx', 'cache')))
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

  // The task's own output masked a secret its config names, the line did
  // not: `vx last` printed it, and cache.db held it.
  it("is masked when only the task's config names it: a define, or exec.env.secret", async () => {
    const config = (env: string) => `{ command: 'echo deploying', env: ${env} }`
    expect(
      await lastLine(SECRET, {
        exec: config(`{ define: { DEPLOY_TOKEN: '${SECRET}' } }`),
        env: {},
      }),
    ).toEqual({ line: ['  $ vx run a#deploy -- --token=***'], holding: [] })
    expect(
      await lastLine(SECRET, {
        exec: config(`{ passThrough: ['GH_PAT'], secret: ['GH_PAT'] }`),
        env: { GH_PAT: SECRET },
      }),
    ).toEqual({ line: ['  $ vx run a#deploy -- --token=***'], holding: [] })
  })
})
