// `vx lock` writes each config as evaluated into .vx/projects.lock.json, which is
// committed. A config that interpolated a secret from the environment
// (`--token ${process.env.API_TOKEN}`) wrote the value there, and
// masking it would freeze a `***` that every run then runs. The lock is
// refused instead, naming where the value sits (L-42).
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'bun:test'
import { localWorkspaceSource } from './helpers/local-workspace.js'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
const SECRET = 'supersecretvalue123'
const roots: string[] = []

afterAll(async () => {
  for (const r of roots) await rm(r, { recursive: true, force: true })
})

async function lock(config: string, env: Record<string, string>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vx-lock-secret-'))
  roots.push(root)
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'r', private: true, workspaces: ['packages/*'] }),
  )
  await Bun.write(path.join(root, '.vx/workspace.mjs'), localWorkspaceSource())
  const dir = path.join(root, 'packages', 'a')
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'a' }))
  await writeFile(path.join(dir, 'vx.config.mjs'), config)
  const r = Bun.spawnSync({
    cmd: [process.execPath, BIN, 'lock'],
    cwd: root,
    env: { ...process.env, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return {
    code: r.exitCode,
    err: r.stderr.toString(),
    written: existsSync(path.join(root, '.vx/projects.lock.json')),
  }
}

const INTERPOLATED = `export default { tasks: {
  deploy: { exec: {
    command: \`deploy --token \${process.env.API_TOKEN}\`,
    env: { define: { NPM_AUTH: process.env.GH_PAT ?? '' }, secret: ['GH_PAT'] },
  } },
} }
`

describe('vx lock and a secret in an evaluated config', () => {
  it('refuses, names each place, and writes nothing', async () => {
    const r = await lock(INTERPOLATED, { API_TOKEN: SECRET, GH_PAT: 'ghp_patvalue456' })
    expect(r).toEqual({
      code: 1,
      err:
        '✗ vx lock  lock not written\n\n' +
        '  these configs evaluated to a secret value\n' +
        '  a: tasks.deploy.exec.command holds $API_TOKEN\n' +
        '  a: tasks.deploy.exec.env.define.NPM_AUTH holds $GH_PAT\n' +
        '  the lock is committed, so the secret would be too\n\n' +
        '  fix  let the shell expand it ($API_TOKEN in the command, the name in exec.env.passThrough) instead of reading process.env in the config\n',
      written: false,
    })
  })

  it('the hint names the variable that leaked, not a fixed one', async () => {
    const r = await lock(INTERPOLATED, { API_TOKEN: '', GH_PAT: 'ghp_patvalue456' })
    expect(r.err).toBe(
      '✗ vx lock  lock not written\n\n' +
        '  these configs evaluated to a secret value\n' +
        '  a: tasks.deploy.exec.env.define.NPM_AUTH holds $GH_PAT\n' +
        '  the lock is committed, so the secret would be too\n\n' +
        '  fix  let the shell expand it ($GH_PAT in the command, the name in exec.env.passThrough) instead of reading process.env in the config\n',
    )
  })

  it('locks the same config when the environment holds no secret (control)', async () => {
    const r = await lock(INTERPOLATED, { API_TOKEN: '', GH_PAT: '' })
    expect(r).toEqual({ code: 0, err: '', written: true })
  })

  // The output masks a URL's password and each line of a PEM key: the lock
  // looked for the whole value only, and wrote either piece.
  it('refuses a piece of a value the output masks: a URL password, a key line', async () => {
    const r = await lock(
      `export default { tasks: { up: { exec: {
  command: 'up --pw ' + new URL(process.env.DATABASE_URL).password + ' --key ' + process.env.SIGNING_KEY.split('\\n')[1],
} } } }
`,
      {
        DATABASE_URL: 'postgres://app:dbpass-value@db/app',
        SIGNING_KEY: '-----BEGIN KEY-----\nkeyline-value-two\n-----END KEY-----',
      },
    )
    expect([r.code, r.written]).toEqual([1, false])
    expect(r.err).toContain('a: tasks.up.exec.command holds $DATABASE_URL\n')
    expect(r.err).toContain('a: tasks.up.exec.command holds $SIGNING_KEY\n')
  })

  it('locks a command the shell expands (control)', async () => {
    const r = await lock(
      `export default { tasks: { deploy: { exec: { command: 'deploy --token $API_TOKEN', env: { passThrough: ['API_TOKEN'] } } } } }\n`,
      { API_TOKEN: SECRET },
    )
    expect(r).toEqual({ code: 0, err: '', written: true })
  })
})
