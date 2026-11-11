// The execution record is a remote cache: the run's policy gates it as it
// gates the remote layer. A `--cache-policy=remote:` run replayed a record
// and wrote one; a run off CI, which uploads no artifact, wrote one a CI run
// on a fresh cache then replayed and uploaded as its own.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { CachePolicy } from '@vzn/vx'
import { run } from '../../vx/tests/helpers/orchestrator.js'
import { execDigestFor } from '../src/cache.js'
import { CHUNKING_SUPPORTED } from './helpers/bun-floor.js'
import { startFakeReapi, type FakeReapi } from './helpers/fake-reapi.js'
import { localWorkspaceSource } from './helpers/local-workspace.js'

const REAPI_INDEX = path.resolve(import.meta.dir, '..', 'src', 'index.ts')
const LOCAL_ONLY: CachePolicy = {
  localRead: true,
  localWrite: true,
  remoteRead: false,
  remoteWrite: false,
}

let fake: FakeReapi
let root: string
beforeAll(async () => {
  fake = await startFakeReapi()
})
afterAll(() => fake.stop())

const said = (text: string) => {
  const data = new TextEncoder().encode(text)
  const digest = fake.put(data)
  return { hash: digest.hash, size_bytes: String(digest.size_bytes) }
}
const answer = (text: string) => {
  fake.onExecute = () => ({
    response: { result: { exit_code: 0, output_files: [{ path: 'out.txt', digest: said(text) }] } },
  })
}
const executes = () => fake.calls.filter((c) => c.method === 'Execute').length
const quiet = {
  runStart: () => undefined,
  taskStart: () => undefined,
  taskStdout: () => undefined,
  taskStderr: () => undefined,
  taskComplete: () => undefined,
  runStatus: () => undefined,
  runEnd: () => undefined,
  status: () => undefined,
}

/** One run of `pkg#gen` on a fresh local cache: the key, what ran, the bytes left. */
async function gen(
  options: { cache?: CachePolicy; remoteReadOnlyByDefault?: boolean },
  cacheDir: string,
): Promise<{ key: string | undefined; executed: number; out: string }> {
  const before = executes()
  const res = await run({
    cwd: root,
    projects: ['pkg'],
    tasks: ['gen'],
    cacheDir: path.join(root, cacheDir),
    log: quiet,
    handleSignals: false,
    ...options,
  })
  expect(res.ok).toBe(true)
  return {
    key: res.outcomes.find((o) => o.node.id === 'pkg#gen')?.hash,
    executed: executes() - before,
    out: await readFile(path.join(root, 'pkg', 'out.txt'), 'utf8'),
  }
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'vx-reapi-policy-'))
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture' }))
  await mkdir(path.join(root, 'pkg', 'src'), { recursive: true })
  await writeFile(path.join(root, 'pkg', 'package.json'), JSON.stringify({ name: 'pkg' }))
  // Unique per row: the fake's action cache outlives a row.
  await writeFile(path.join(root, 'pkg', 'src', 'in.txt'), `${root}\n`)
  await writeFile(
    path.join(root, 'pkg', 'vx.config.mjs'),
    `export default { tasks: {
       gen: {
         exec: { command: 'echo LOCAL > out.txt' },
         inputs: { files: ['src/**'] }, outputs: { files: ['out.txt'] }, cache: true,
       },
     } }`,
  )
  await Bun.write(
    path.join(root, '.vx/workspace.mjs'),
    localWorkspaceSource(
      [`reapi({ endpoint: ${JSON.stringify(fake.endpoint)}, execute: true })`],
      `import { reapi } from ${JSON.stringify(REAPI_INDEX)}\n`,
    ),
  )
  const git = (...a: string[]) => Bun.spawnSync({ cmd: ['git', ...a], cwd: root })
  git('init', '-q')
  git('add', '-A')
  git('-c', 'user.email=t@vx.local', '-c', 'user.name=t', 'commit', '-qm', 'init')
  return async () => {
    await rm(root, { recursive: true, force: true })
  }
})

describe.if(CHUNKING_SUPPORTED)('the execution record follows the run policy', () => {
  it('a run with the remote off neither replays a record nor writes one', async () => {
    answer('REMOTE\n')
    const first = await gen({}, 'c1')
    expect(first).toMatchObject({ executed: 1, out: 'REMOTE\n' })
    expect(fake.actions.has(execDigestFor(first.key!).hash)).toBe(true)

    answer('FRESH\n')
    expect(await gen({ cache: LOCAL_ONLY }, 'c2')).toMatchObject({ executed: 1, out: 'FRESH\n' })
    // The record is still the first run's.
    fake.actions.delete(execDigestFor(first.key!).hash)
    expect(await gen({ cache: LOCAL_ONLY }, 'c3')).toMatchObject({ executed: 1 })
    expect(fake.actions.has(execDigestFor(first.key!).hash)).toBe(false)
  }, 60_000)

  it('a run off CI writes no record a later run replays', async () => {
    answer('LAPTOP\n')
    const laptop = await gen({ remoteReadOnlyByDefault: true }, 'c1')
    expect(laptop).toMatchObject({ executed: 1, out: 'LAPTOP\n' })
    expect(fake.actions.has(execDigestFor(laptop.key!).hash)).toBe(false)

    answer('CI\n')
    const ci = await gen({}, 'c2')
    expect(ci).toMatchObject({ key: laptop.key, executed: 1, out: 'CI\n' })
    expect(fake.actions.has(execDigestFor(ci.key!).hash)).toBe(true)
    // Off CI what CI wrote is read (control).
    expect(await gen({ remoteReadOnlyByDefault: true }, 'c3')).toMatchObject({
      executed: 0,
      out: 'CI\n',
    })
  }, 60_000)
})
