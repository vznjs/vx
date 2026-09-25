// An output set past the artifact ceiling (2 GiB decoded, zstd.ts) is
// refused at save: the task's work ran, so the run stays green, one status
// line names the task and the ceiling, and nothing lands in the cache for a
// later run to hit — every restore enforces the same ceiling, so an entry
// past it would be a hit that fails forever. The ceiling is lowered through
// `RunOptions.artifactCeiling`: 2 GiB of output is out of a test's reach
// (the upstream probe, a sparse 2.2 GB file, cost 6 to 14 s a run).

import { readdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { Cache, CorruptArtifactError } from '../src/cache/cache.js'
import { run, type Logger } from '../src/orchestrator/index.js'
import { addProject, gitIn, makeWorkspace } from './helpers/workspace.js'

const CEILING = 64 * 1024

const collecting = (lines: string[]): Logger => ({
  status(m) {
    lines.push(m)
  },
  taskStdout() {},
  taskStderr() {},
  taskComplete() {},
})

/** The artifacts and their temps (`<hash>.tar.zst.tmp-…`) under the cache directory. */
async function artifactFiles(root: string): Promise<string[]> {
  const all = await readdir(path.join(root, '.vx', 'cache'), { recursive: true })
  return all.filter((f) => f.includes('.tar.zst')).sort()
}

describe('an output set past the artifact ceiling', () => {
  let root: string
  beforeEach(async () => {
    root = await makeWorkspace({ prefix: 'vx-artifact-ceiling-' })
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  async function workspace(bytes: number): Promise<void> {
    await addProject(root, 'big', {
      files: { 'src/x.txt': 'x' },
      config: `
        export default {
          tasks: {
            build: {
              exec: { command: 'mkdir -p dist && head -c ${bytes} /dev/urandom > dist/out.bin' },
              cache: { inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] } },
            },
          },
        }
      `,
    })
    const git = gitIn(root)
    git('add', '-A')
    git('commit', '-q', '-m', 'init')
  }

  it('is refused at save with one status line, the run green, nothing cached', async () => {
    await workspace(CEILING)
    const lines: string[] = []
    const miss = await run({
      cwd: root,
      tasks: ['build'],
      log: collecting(lines),
      artifactCeiling: CEILING,
    })
    expect(miss.ok).toBe(true)
    expect(miss.outcomes.map((o) => o.status)).toEqual(['success'])
    // 64 KiB of output plus the tar's headers and stdout / sidecar entries.
    expect(lines.filter((l) => l.includes('cache save failed'))).toEqual([
      '[vx] cache save failed: big#build is not cached: its outputs pack to 67 KB, past the ' +
        '64 KB artifact ceiling a restore enforces — narrow cache.outputs.files',
    ])
    // No artifact and no temp left behind it.
    expect(await artifactFiles(root)).toEqual([])
    const again = await run({
      cwd: root,
      tasks: ['build'],
      log: collecting([]),
      artifactCeiling: CEILING,
    })
    expect(again.outcomes.map((o) => o.status)).toEqual(['success'])
  })

  it('control: an output set under it is cached and hit, no line', async () => {
    await workspace(CEILING / 2)
    const lines: string[] = []
    const miss = await run({
      cwd: root,
      tasks: ['build'],
      log: collecting(lines),
      artifactCeiling: CEILING,
    })
    expect(miss.outcomes.map((o) => o.status)).toEqual(['success'])
    expect(lines.filter((l) => l.includes('cache save failed'))).toEqual([])
    expect((await artifactFiles(root)).map((f) => path.extname(f))).toEqual(['.zst'])
    const hit = await run({
      cwd: root,
      tasks: ['build'],
      log: collecting([]),
      artifactCeiling: CEILING,
    })
    expect(hit.outcomes.map((o) => o.status)).toEqual(['cache-hit'])
  })

  it('the ceiling is inclusive at save as at restore: exactly its size is cached and hit', async () => {
    await workspace(CEILING / 2)
    await run({ cwd: root, tasks: ['build'], log: collecting([]) })
    const [artifact] = await artifactFiles(root)
    const cacheDir = path.join(root, '.vx', 'cache')
    const exact = (await Bun.zstdDecompress(await Bun.file(path.join(cacheDir, artifact!)).bytes()))
      .byteLength
    await rm(cacheDir, { recursive: true, force: true })
    const under: string[] = []
    await run({ cwd: root, tasks: ['build'], log: collecting(under), artifactCeiling: exact - 1 })
    expect(under.filter((l) => l.includes('cache save failed'))).toHaveLength(1)
    expect(await artifactFiles(root)).toEqual([])
    const at: string[] = []
    await run({ cwd: root, tasks: ['build'], log: collecting(at), artifactCeiling: exact })
    expect(at.filter((l) => l.includes('cache save failed'))).toEqual([])
    const hit = await run({
      cwd: root,
      tasks: ['build'],
      log: collecting([]),
      artifactCeiling: exact,
    })
    expect(hit.outcomes.map((o) => o.status)).toEqual(['cache-hit'])
  })

  it('a restore enforces the same ceiling: an artifact past it is refused, loudly', async () => {
    // A local artifact a restore refuses is a real fault, not a miss
    // (layered-cache.ts): the task fails naming the cap, never replays.
    await workspace(CEILING / 2)
    await run({ cwd: root, tasks: ['build'], log: collecting([]) })
    await rm(path.join(root, 'packages', 'big', 'dist'), { recursive: true, force: true })
    // The scheduler writes a task's crash to stderr itself, not through the logger.
    const stderr = spyOn(process.stderr, 'write').mockImplementation(() => true)
    let refused: Awaited<ReturnType<typeof run>>
    let lines: string[]
    try {
      refused = await run({
        cwd: root,
        tasks: ['build'],
        log: collecting([]),
        artifactCeiling: 1024,
      })
      lines = stderr.mock.calls.map(([chunk]) => String(chunk).trimEnd())
    } finally {
      stderr.mockRestore()
    }
    expect(refused.outcomes.map((o) => o.status)).toEqual(['failed'])
    expect(lines.filter((l) => l.startsWith('[vx] internal error'))).toEqual([
      expect.stringMatching(
        /^\[vx\] internal error in big#build: CorruptArtifactError: cache: corrupt artifact for [0-9a-f]+: declares \d+ decompressed bytes \(> 1024 cap\)$/,
      ),
    ])
  })

  it('an ingest enforces it too: remote bytes past it never land', async () => {
    await workspace(CEILING / 2)
    await run({ cwd: root, tasks: ['build'], log: collecting([]) })
    const [artifact] = await artifactFiles(root)
    const bytes = await Bun.file(path.join(root, '.vx', 'cache', artifact!)).bytes()
    const hash = artifact!.slice(0, -'.tar.zst'.length)
    const otherDir = path.join(root, 'other-cache')
    const other = new Cache(otherDir, undefined, undefined, 1024)
    try {
      const err = await other
        .ingest(hash, new Blob([bytes]), { taskId: 'big#build', command: 'x', durationMs: 1 })
        .then(
          () => null,
          (e: unknown) => e,
        )
      expect(err).toBeInstanceOf(CorruptArtifactError)
      expect((err as Error).message).toMatch(
        new RegExp(
          `^cache: corrupt artifact for ${hash}: declares \\d+ decompressed bytes \\(> 1024 cap\\)$`,
        ),
      )
      expect(await other.get(hash)).toBeNull()
      expect((await readdir(otherDir)).filter((f) => f.includes('.tar.zst'))).toEqual([])
    } finally {
      other.close()
    }
  })
})
