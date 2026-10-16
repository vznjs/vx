// A restore stages every entry in the workspace's `.vx/tmp/<pid>-<n>/`,
// never in an output folder, and renames each over its target; the next
// run sweeps the staging a killed run left, never a live run's (M,
// 2026-10-16). A target on another filesystem goes through a temp beside
// it, and a setgid directory's group is kept.

import {
  chmodSync,
  chownSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'bun:test'
import { extractArtifactStream } from '../src/cache/archive.js'
import { tarPack } from '../src/cache/tar-stream.js'
import { withSum } from './helpers/artifact-sum.js'
import { vx } from './helpers/parity.js'
import { streamOf } from './helpers/stream.js'
import { addProject, gitIn, makeWorkspace } from './helpers/workspace.js'

const made: string[] = []
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true })
})

function dir(prefix: string, under = os.tmpdir()): string {
  const d = mkdtempSync(path.join(under, prefix))
  made.push(d)
  return d
}

async function artifact(files: Record<string, string>): Promise<Uint8Array> {
  const parts: Uint8Array[] = []
  const entries = Object.entries(files).map(([name, body]) => ({
    name: `outputs/${name}`,
    size: Buffer.byteLength(body),
    body,
  }))
  for await (const c of tarPack(entries)) parts.push(c)
  return withSum(new Uint8Array(await new Blob(parts).arrayBuffer()))
}

/** Every file under `root`, relative. */
function filesUnder(root: string): string[] {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) =>
      path
        .join(e.parentPath, e.name)
        .slice(root.length + 1)
        .split(path.sep)
        .join('/'),
    )
    .sort()
}

it('a restore writes nothing into an output folder before it renames', async () => {
  const ws = dir('vx-staging-')
  const dest = path.join(ws, 'app')
  mkdirSync(path.join(dest, 'dist'), { recursive: true })
  writeFileSync(path.join(dest, 'dist', 'a.js'), 'old\n')
  let during: string[] = []
  await extractArtifactStream(
    streamOf(await artifact({ 'dist/a.js': 'new\n', 'dist/sub/b.js': 'b\n' })),
    dest,
    undefined,
    () => {
      during = filesUnder(dest)
    },
    undefined,
    ws,
  )
  // Small entries may still be in flight to `.vx/tmp/` here; none is in dest.
  expect(during).toEqual(['dist/a.js'])
  expect(readFileSync(path.join(dest, 'dist', 'a.js'), 'utf8')).toBe('new\n')
  // The renames empty the staging; its ignore file stays.
  expect(filesUnder(path.join(ws, '.vx', 'tmp'))).toEqual(['.gitignore'])
})

it('a staging directory removed between two restores is made again', async () => {
  const ws = dir('vx-staging-gone-')
  const dest = path.join(ws, 'app')
  const restore = async (body: string) =>
    extractArtifactStream(
      streamOf(await artifact({ 'dist/a.js': body })),
      dest,
      undefined,
      undefined,
      undefined,
      ws,
    )
  await restore('one\n')
  rmSync(path.join(ws, '.vx', 'tmp'), { recursive: true })
  await restore('two\n')
  expect(readFileSync(path.join(dest, 'dist', 'a.js'), 'utf8')).toBe('two\n')
})

it('a failed restore leaves no staging and the outputs as they were', async () => {
  const ws = dir('vx-staging-fail-')
  const dest = path.join(ws, 'app')
  mkdirSync(path.join(dest, 'dist'), { recursive: true })
  writeFileSync(path.join(dest, 'dist', 'a.js'), 'old\n')
  const err = await extractArtifactStream(
    streamOf(await artifact({ 'dist/a.js': 'new\n' })),
    dest,
    undefined,
    () => {
      throw new Error('verify refused')
    },
    undefined,
    ws,
  ).then(
    () => null,
    (e: unknown) => e,
  )
  expect(err).toBeInstanceOf(Error)
  expect(readFileSync(path.join(dest, 'dist', 'a.js'), 'utf8')).toBe('old\n')
  expect(filesUnder(path.join(ws, '.vx', 'tmp'))).toEqual(['.gitignore'])
})

// A tmpfs beside the disk: the only second filesystem a test reaches
// without a mount.
const otherFs =
  process.platform === 'linux' &&
  existsSync('/dev/shm') &&
  statSync('/dev/shm').dev !== statSync(os.tmpdir()).dev

it.skipIf(!otherFs)(
  'a target on another filesystem than the staging lands through a temp beside it',
  async () => {
    const ws = dir('vx-staging-xdev-', '/dev/shm')
    const dest = dir('vx-staging-xdev-dest-')
    mkdirSync(path.join(dest, 'dist'))
    writeFileSync(path.join(dest, 'dist', 'a.js'), 'old\n')
    await extractArtifactStream(
      streamOf(await artifact({ 'dist/a.js': 'new\n' })),
      dest,
      undefined,
      undefined,
      undefined,
      ws,
    )
    expect(readFileSync(path.join(dest, 'dist', 'a.js'), 'utf8')).toBe('new\n')
    expect(filesUnder(dest)).toEqual(['dist/a.js'])
    expect(filesUnder(path.join(ws, '.vx', 'tmp'))).toEqual(['.gitignore'])
  },
)

// A group this process may give a file other than its own: a supplementary
// one, or for root any gid. A user namespace maps only some (the sandbox's:
// chown gives EINVAL for the rest), so each candidate is tried.
function chownable(): number | undefined {
  const egid = process.getegid!()
  const candidates = process.getgroups!().filter((g) => g !== egid)
  if (process.getuid!() === 0) candidates.push(4242)
  const probe = path.join(mkdtempSync(path.join(os.tmpdir(), 'vx-chown-')), 'f')
  writeFileSync(probe, '')
  try {
    return candidates.find((g) => {
      try {
        chownSync(probe, process.getuid!(), g)
        return true
      } catch {
        return false
      }
    })
  } finally {
    rmSync(path.dirname(probe), { recursive: true })
  }
}
const otherGroup = chownable()

it.skipIf(otherGroup === undefined)(
  'a file restored into a setgid directory takes its group',
  async () => {
    const group = otherGroup
    const ws = dir('vx-staging-sgid-')
    const dest = path.join(ws, 'app')
    const out = path.join(dest, 'dist')
    mkdirSync(out, { recursive: true })
    chownSync(out, process.getuid!(), group!)
    chmodSync(out, 0o2775)
    await extractArtifactStream(
      streamOf(await artifact({ 'dist/a.js': 'new\n' })),
      dest,
      undefined,
      undefined,
      undefined,
      ws,
    )
    expect(statSync(path.join(out, 'a.js')).gid).toBe(group!)
  },
)

it("the next run sweeps a killed run's staging and leaves a live run's", async () => {
  const root = await makeWorkspace({ prefix: 'vx-staging-sweep-' })
  made.push(root)
  await addProject(root, 'app', {
    config: `export default { tasks: { build: {
        exec: { command: 'mkdir -p dist && echo a > dist/a.txt' },
        inputs: { files: ['src/**'] }, cache: { outputs: { files: ['dist/**'] } },
      } } }`,
    files: { 'src/in.txt': 'v1\n' },
  })
  const git = gitIn(root)
  git('add', '-A')
  git('commit', '-q', '-m', 'init')
  const tmp = path.join(root, '.vx', 'tmp')
  // A pid above any pid_max: its run is gone. This test's own pid is live.
  const dead = path.join(tmp, 'zzzzzz-1')
  const live = path.join(tmp, `${process.pid.toString(36)}-1`)
  for (const d of [dead, live]) {
    mkdirSync(d, { recursive: true })
    writeFileSync(path.join(d, '0'), 'partial')
  }
  const r = await vx(root, ['run', 'build', '--all', '--cache-dir', path.join(root, '.cache')])
  expect(`${r.code}\n${r.err}`).toStartWith('0\n')
  expect([existsSync(dead), existsSync(live)]).toEqual([false, true])
}, 60_000)
