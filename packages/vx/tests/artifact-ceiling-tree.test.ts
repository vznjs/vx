// The artifact ceiling (`cache.artifactCeiling`, 1 GiB decoded by default)
// bounds what a REMOTE can make a hit write. The default store keeps this machine's own entries as plain
// files, never decoded, so the ceiling has nothing to guard there: a real
// Next.js build with `output: 'standalone'` packs to 2.1 GB (formbricks,
// 2026-11-20) and was never cached, though Turbo caches it. Such an entry is
// saved and hit here; only its upload is refused, by the ceiling every remote
// hit enforces. The `.tar.zst` store keeps the ceiling: its restore decodes
// (artifact-ceiling.test.ts).

import { readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { Cache } from '../src/cache/cache.js'
import { type Logger } from '../src/report/index.js'
import { run } from './helpers/orchestrator.js'
import { addProject, gitIn, makeWorkspace } from './helpers/workspace.js'
import { storedKeys } from './helpers/stored-artifact.js'

const CEILING = 64 * 1024

/** A run under `cache.artifactCeiling` lowered to `bytes`, through its variable. */
async function runAt(bytes: number, opts: Parameters<typeof run>[0]): ReturnType<typeof run> {
  process.env.VX_CACHE_ARTIFACT_CEILING = `${bytes}B`
  try {
    return await run(opts)
  } finally {
    delete process.env.VX_CACHE_ARTIFACT_CEILING
  }
}

const collecting = (lines: string[]): Logger => ({
  status(m) {
    lines.push(m)
  },
  taskStdout() {},
  taskStderr() {},
  taskComplete() {},
})

describe('an output set past the artifact ceiling, on the plain-file store', () => {
  let root: string
  beforeEach(async () => {
    root = await makeWorkspace({ prefix: 'vx-artifact-ceiling-tree-' })
    await addProject(root, 'big', {
      files: { 'src/x.txt': 'x' },
      config: `
        export default {
          tasks: {
            build: {
              exec: { command: 'mkdir -p dist && head -c ${CEILING * 2} /dev/urandom > dist/out.bin' },
              inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] }, cache: true,
            },
          },
        }
      `,
    })
    const git = gitIn(root)
    git('add', '-A')
    git('commit', '-q', '-m', 'init')
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('is saved and hit, its bytes restored, with no line', async () => {
    const lines: string[] = []
    const opts = { cwd: root, tasks: ['build'], log: collecting(lines) }
    const miss = await runAt(CEILING, opts)
    expect(miss.outcomes.map((o) => o.status)).toEqual(['success'])
    const out = path.join(root, 'packages', 'big', 'dist', 'out.bin')
    const built = await readFile(out)
    await rm(path.join(root, 'packages', 'big', 'dist'), { recursive: true, force: true })
    const hit = await runAt(CEILING, opts)
    expect(hit.outcomes.map((o) => o.status)).toEqual(['cache-hit'])
    expect(Buffer.compare(await readFile(out), built)).toBe(0)
    expect(lines.filter((l) => l.includes('[vx]') || l.includes('corrupt'))).toEqual([])
  })

  it('is not sent to a remote: the upload says the ceiling refused it', async () => {
    await runAt(CEILING, { cwd: root, tasks: ['build'], log: collecting([]) })
    const dir = path.join(root, '.vx', 'cache')
    const [hash] = storedKeys(dir)
    const cache = new Cache(dir, undefined, root, CEILING)
    try {
      const err = await cache.pinArtifact(hash!).then(
        () => null,
        (e: unknown) => (e as Error).message,
      )
      expect(err).toMatch(
        /^not sent to a remote: its outputs pack to 1\d\d KB, past the 64 KB cache\.artifactCeiling a remote hit enforces; this machine keeps it$/,
      )
    } finally {
      cache.close()
    }
  })

  it('is not sent to a remote when it is stored inline, under a ceiling below the inline bound', async () => {
    const small = 4 * 1024
    await rm(root, { recursive: true, force: true })
    root = await makeWorkspace({ prefix: 'vx-artifact-ceiling-inline-' })
    await addProject(root, 'small', {
      files: { 'src/x.txt': 'x' },
      config: `
        export default {
          tasks: {
            build: {
              exec: { command: 'mkdir -p dist && head -c ${small * 2} /dev/urandom > dist/out.bin' },
              inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] }, cache: true,
            },
          },
        }
      `,
    })
    const git = gitIn(root)
    git('add', '-A')
    git('commit', '-q', '-m', 'init')
    await runAt(small, { cwd: root, tasks: ['build'], log: collecting([]) })
    const dir = path.join(root, '.vx', 'cache')
    const [hash] = storedKeys(dir)
    const cache = new Cache(dir, undefined, root, small)
    try {
      const err = await cache.pinArtifact(hash!).then(
        () => null,
        (e: unknown) => (e as Error).message,
      )
      expect(err).toMatch(
        /^not sent to a remote: its outputs pack to \d+(\.\d)? KB, past the 4\.0 KB cache\.artifactCeiling a remote hit enforces; this machine keeps it$/,
      )
    } finally {
      cache.close()
    }
  })
})
