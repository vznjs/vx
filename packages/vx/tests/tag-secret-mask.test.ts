// A `--tag` value is stored on the run's history row and handed to
// telemetry as a `vx.tag.<key>` attribute. A tag that carried a secret
// (`--tag key=$DEPLOY_KEY`) was masked in the stored invocation line (L-35)
// and kept whole in the tags beside it (L-38).
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'bun:test'
import { run, type TelemetryRecord } from '../src/index.js'
import { defaultLogger } from '../src/orchestrator/logger.js'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
const SECRET = 'supersecretvalue123'
const roots: string[] = []

afterAll(async () => {
  for (const r of roots) await rm(r, { recursive: true, force: true })
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

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vx-tag-mask-'))
  roots.push(root)
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
  return root
}

describe('a secret in a --tag', () => {
  it('is absent from the cache directory', async () => {
    const root = await fixture()
    const r = Bun.spawnSync({
      cmd: [process.execPath, BIN, 'run', 'a#deploy', '--tag', `key=${SECRET}`],
      cwd: root,
      env: { ...process.env, DEPLOY_KEY: SECRET },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(r.exitCode).toBe(0)
    const holding: string[] = []
    for (const f of await walk(path.join(root, '.vx')))
      if ((await readFile(f)).includes(SECRET)) holding.push(path.relative(root, f))
    expect(holding).toEqual([])
  })

  it('reaches telemetry masked', async () => {
    const root = await fixture()
    const records: TelemetryRecord[] = []
    const prev = process.env.DEPLOY_KEY
    process.env.DEPLOY_KEY = SECRET
    try {
      await run({
        cwd: root,
        tasks: ['a#deploy'],
        tags: { key: SECRET },
        log: defaultLogger({ enabled: false }, { mode: 'focused' }, { write: () => true }),
        handleSignals: false,
        telemetrySinks: [{ onRecord: (rec) => void records.push(rec) }],
      })
    } finally {
      if (prev === undefined) delete process.env.DEPLOY_KEY
      else process.env.DEPLOY_KEY = prev
    }
    expect(records.flatMap((r) => (r.kind === 'run.start' ? [r.run.tags] : []))).toEqual([
      { key: '***' },
    ])
    expect(JSON.stringify(records).includes(SECRET)).toBe(false)
  })
})
