// Turbo's and Nx's restore and output tests that vx had no row for, ported
// (Growth's map, org/growth/parity/restore-tests, 2026-10-16). Each test
// names its upstream source; the cache prune ones are in
// cache-prune-policy.test.ts, the declared-outputs gate in
// restore-declared-only.test.ts, the swapped parent in
// restore-link-swap.test.ts.

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readlinkSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  renameSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'bun:test'
import {
  extractArtifactStream,
  packArtifactBytes,
  packArtifactStream,
  planArtifact,
} from '../src/cache/archive.js'
import { Cache } from '../src/cache/index.js'
import { tarPack, type TarInput } from '../src/cache/tar-stream.js'
import { normalizeGlob, outputMatcher, restorableOutput } from '../src/util/index.js'
import { withSum } from './helpers/artifact-sum.js'
import { vx } from './helpers/parity.js'
import { streamOf } from './helpers/stream.js'
import { addProject, gitIn, makeWorkspace } from './helpers/workspace.js'
import { TAR_STORE } from './helpers/tar-store.js'

const made: string[] = []
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true })
})

function dir(prefix: string): string {
  const d = mkdtempSync(path.join(os.tmpdir(), prefix))
  made.push(d)
  return d
}

async function tarOf(inputs: TarInput[]): Promise<Uint8Array> {
  const parts: Uint8Array[] = []
  for await (const c of tarPack(inputs)) parts.push(c)
  return withSum(new Uint8Array(await new Blob(parts).arrayBuffer()))
}

const file = (name: string, body: string, mtime?: number): TarInput => ({
  name: `outputs/${name}`,
  size: Buffer.byteLength(body),
  body,
  ...(mtime === undefined ? {} : { mtime }),
})

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

// turborepo restore_allows_non_metadata_git_names
it('a name that only looks like git metadata restores', async () => {
  const dest = dir('vx-ported-git-')
  await extractArtifactStream(
    streamOf(await tarOf([file('.github/ci.yml', 'ci\n'), file('x.git', 'x\n')])),
    dest,
    undefined,
    undefined,
    (name) => restorableOutput(['**'])(name.slice('outputs/'.length)),
  )
  expect(filesUnder(dest)).toEqual(['.github/ci.yml', 'x.git'])
})

// turborepo test_nfc_vs_nfd_normalization
it('two names differing only in Unicode normalization restore inside, without error', async () => {
  const root = dir('vx-ported-nfc-')
  const dest = path.join(root, 'proj')
  mkdirSync(dest)
  const nfc = 'café.txt'
  const nfd = 'café.txt'
  await extractArtifactStream(
    streamOf(await tarOf([file(nfc, 'nfc\n'), file(nfd, 'nfd\n')])),
    dest,
    undefined,
  )
  // A normalizing file system (APFS) holds one file, the last written.
  expect(filesUnder(dest).length).toBeGreaterThanOrEqual(1)
  expect(filesUnder(root).every((f) => f.startsWith('proj/'))).toBe(true)
})

// turborepo test_deeply_nested_path
it('an entry 120 directories deep restores inside', async () => {
  const dest = dir('vx-ported-deep-')
  const name = `${Array.from({ length: 120 }, () => 'd').join('/')}/x.txt`
  await extractArtifactStream(streamOf(await tarOf([file(name, 'x\n')])), dest, undefined)
  expect(readFileSync(path.join(dest, name), 'utf8')).toBe('x\n')
})

// turborepo test_concurrent_restore_with_symlink_attack
it('a link planted while another restore of the same name runs writes nothing outside', async () => {
  const root = dir('vx-ported-race-')
  const dest = path.join(root, 'proj')
  const outside = path.join(root, 'outside')
  mkdirSync(path.join(dest, 'dist'), { recursive: true })
  mkdirSync(outside)
  const tar = await tarOf([file('dist/x.js', 'x\n')])
  const plant = (): void => {
    renameSync(path.join(dest, 'dist'), path.join(root, 'moved'))
    symlinkSync(outside, path.join(dest, 'dist'))
  }
  const results = await Promise.allSettled([
    extractArtifactStream(streamOf(tar), dest, undefined, plant, undefined, root),
    extractArtifactStream(streamOf(tar), dest, undefined, undefined, undefined, root),
  ])
  expect(results.some((r) => r.status === 'rejected')).toBe(true)
  expect(readdirSync(outside)).toEqual([])
})

// turborepo test_restore_regular_file_strips_special_mode_bits
it('a file entry carrying setuid, setgid and sticky bits restores without them', async () => {
  const dest = dir('vx-ported-mode-')
  const meta = JSON.stringify({
    version: 1,
    files: { 'outputs/run.sh': [0o7755, 1_700_000_000_000] },
  })
  await extractArtifactStream(
    streamOf(
      await tarOf([
        file('run.sh', '#!/bin/sh\n'),
        { name: '.vx-meta.json', size: meta.length, body: meta },
      ]),
    ),
    dest,
    undefined,
  )
  expect(statSync(path.join(dest, 'run.sh')).mode & 0o7777).toBe(0o755)
})

// turborepo test_empty_path_in_entry (a ustar header with no name)
it('an entry with an empty name restores nothing', async () => {
  const dest = dir('vx-ported-empty-')
  const err = await extractArtifactStream(
    streamOf(await tarOf([{ name: '', size: 1, body: 'x' }, file('a.txt', 'a\n')])),
    dest,
    undefined,
  ).then(
    () => null,
    (e: unknown) => e,
  )
  if (err === null) expect(filesUnder(dest)).toEqual(['a.txt'])
  else expect(filesUnder(dest)).toEqual([])
})

// nx should_keep_the_modified_time_of_a_read_only_file
it('a read-only output keeps its mode and mtime through a save and restore', async () => {
  const src = dir('vx-ported-ro-src-')
  const out = path.join(src, 'ro.txt')
  writeFileSync(out, 'ro\n')
  const when = new Date(1_700_000_000_000)
  utimesSync(out, when, when)
  chmodSync(out, 0o444)
  const dest = dir('vx-ported-ro-')
  const tar = await packArtifactBytes(
    await planArtifact({ stdout: '', outputs: new Map([['outputs/ro.txt', out]]) }),
  )
  await extractArtifactStream(streamOf(tar), dest, undefined)
  const st = statSync(path.join(dest, 'ro.txt'))
  expect([st.mode & 0o777, st.mtimeMs]).toEqual([0o444, 1_700_000_000_000])
})

// turborepo large_compressed_archive_matches_single_pass_encoding, nx
// zstd_sink output_matches_a_single_encoder (vx: the tar is the same bytes
// whichever path packs it; the zstd call is one per artifact, no workers)
for (const [label, size] of [
  ['small', 16],
  ['large', 9 * 1024 * 1024],
] as const) {
  it(`a ${label} artifact packs to the same bytes streamed or in one call`, async () => {
    const src = dir('vx-ported-pack-')
    const outputs = new Map<string, string>()
    for (const n of ['a.bin', 'b.bin']) {
      const p = path.join(src, n)
      writeFileSync(p, new Uint8Array(size).fill(n.charCodeAt(0)))
      outputs.set(`outputs/${n}`, p)
    }
    const plan = await planArtifact({ stdout: 'out\n', outputs })
    const streamed = new Uint8Array(await new Response(packArtifactStream(plan)).arrayBuffer())
    const whole = await packArtifactBytes(await planArtifact({ stdout: 'out\n', outputs }))
    expect(Buffer.compare(streamed, whole)).toBe(0)
  })
}

// turborepo test_generate_temp_path_uniqueness: two restores of many files
// staging at once never collide.
it('two restores of 400 files each, staging at once, both land whole', async () => {
  const root = dir('vx-ported-temps-')
  const files = Array.from({ length: 400 }, (_, i) => file(`out/${i}.txt`, `${i}\n`))
  const tar = await tarOf(files)
  await Promise.all(
    ['a', 'b'].map((p) =>
      extractArtifactStream(
        streamOf(tar),
        path.join(root, p),
        undefined,
        undefined,
        undefined,
        root,
      ),
    ),
  )
  for (const p of ['a', 'b']) {
    expect(readdirSync(path.join(root, p, 'out'))).toHaveLength(400)
    expect(readFileSync(path.join(root, p, 'out', '399.txt'), 'utf8')).toBe('399\n')
  }
})

// turborepo test_concurrent_reads: parallel hits on one entry.
it('eight restores of one entry at once all succeed', async () => {
  const root = dir('vx-ported-reads-')
  const src = path.join(root, 'src')
  mkdirSync(path.join(src, 'out'), { recursive: true })
  writeFileSync(path.join(src, 'out', 'a.bin'), crypto.getRandomValues(new Uint8Array(64 * 1024)))
  const cache = new Cache(
    path.join(root, 'cache'),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    TAR_STORE,
  )
  try {
    await cache.save({
      hash: '00000000000000aa',
      projectDir: src,
      outputFiles: [path.join(src, 'out', 'a.bin')],
      entry: { taskId: 'p#build', command: 'build', durationMs: 1, stdout: '' },
    })
    const dests = Array.from({ length: 8 }, (_, i) => path.join(root, `d${i}`))
    await Promise.all(dests.map((d) => cache.restoreOutputs('00000000000000aa', d, root)))
    const want = readFileSync(path.join(src, 'out', 'a.bin'))
    for (const d of dests)
      expect(readFileSync(path.join(d, 'out', 'a.bin')).equals(want)).toBe(true)
  } finally {
    cache.close()
  }
})

// nx get_batch_demotes_only_the_records_whose_artifacts_are_gone
it('a batch lookup drops only the entries whose artifact is gone', async () => {
  const root = dir('vx-ported-batch-')
  const src = path.join(root, 'src')
  mkdirSync(src)
  const cache = new Cache(
    path.join(root, 'cache'),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    TAR_STORE,
  )
  try {
    for (const h of ['00000000000000a1', '00000000000000a2']) {
      writeFileSync(path.join(src, `${h}.bin`), crypto.getRandomValues(new Uint8Array(64 * 1024)))
      await cache.save({
        hash: h,
        projectDir: src,
        outputFiles: [path.join(src, `${h}.bin`)],
        entry: { taskId: `p#${h}`, command: 'build', durationMs: 1, stdout: '' },
      })
    }
    rmSync(cache.outputsPath('00000000000000a1'))
    const got = await cache.getMany(['00000000000000a1', '00000000000000a2'])
    expect([...got.keys()]).toEqual(['00000000000000a2'])
    expect(await cache.has('00000000000000a2')).toBe('local')
  } finally {
    cache.close()
  }
})

// turborepo should_not_match_excluded_subtrees_of_dirs_with_glob_like_names,
// an_escaped_entry_reads_the_path_it_names, normalize_outputs_keeps_escapes
it('an escaped glob character in an output names itself, and survives normalizing', () => {
  const bracket = outputMatcher(['\\[x\\]/**', '!\\[x\\]/skip.txt'])
  expect([bracket('[x]/a.txt'), bracket('[x]/skip.txt'), bracket('x/a.txt')]).toEqual([
    true,
    false,
    false,
  ])
  const star = outputMatcher(['dist/\\*/x.js'])
  expect([star('dist/*/x.js'), star('dist/a/x.js')]).toEqual([true, false])
  expect(normalizeGlob('./dist/\\*/x.js')).toBe('dist/\\*/x.js')
})

// nx workspace-context-outputs: ignores files an output glob does not name
it('a file beside the outputs that no glob names does not make a hit restore', async () => {
  const root = await makeWorkspace({ prefix: 'vx-ported-beside-' })
  made.push(root)
  const proj = await addProject(root, 'app', {
    config: `export default { tasks: { build: {
      exec: { command: 'mkdir -p dist && echo a > dist/a.txt' },
      inputs: { files: ['src/**'] }, cache: { outputs: { files: ['dist/*.txt'] } },
    } } }`,
    files: { 'src/in.txt': 'v1\n' },
  })
  const git = gitIn(root)
  git('add', '-A')
  git('commit', '-q', '-m', 'init')
  const cacheDir = path.join(root, '.cache')
  const first = await vx(root, ['run', 'build', '--all', '--cache-dir', cacheDir])
  expect(`${first.code}\n${first.err}`).toStartWith('0\n')
  writeFileSync(path.join(proj, 'dist', 'notes.md'), 'mine\n')
  const second = await vx(root, ['run', 'build', '--all', '--cache-dir', cacheDir])
  expect(`${second.code}\n${second.err}`).toStartWith('0\n')
  expect(second.out).toContain('1✓')
  expect(existsSync(path.join(proj, 'dist', 'notes.md'))).toBe(true)
}, 60_000)

// turborepo put_archive_after_restore_restores_changed_files,
// put_archive_after_restore_restores_changed_symlinks,
// fetch_restores_symlinks_changed_since_put
for (const change of [
  'edited',
  'deleted',
  'retargeted link',
  'deleted link',
  'deleted dangling link',
  'link made a file',
]) {
  it(`an output ${change} after its run comes back as the entry holds it on the next hit`, async () => {
    const root = await makeWorkspace({ prefix: 'vx-ported-changed-' })
    made.push(root)
    const proj = await addProject(root, 'app', {
      config: `export default { tasks: { build: {
        exec: { command: 'mkdir -p dist && echo archived > dist/out.txt && echo a > dist/a.txt && echo b > dist/b.txt && ln -sf a.txt dist/link && ln -sf missing dist/dangling' },
        inputs: { files: ['src/**'] }, cache: { outputs: { files: ['dist/**'] } },
      } } }`,
      files: { 'src/in.txt': 'v1\n' },
    })
    const git = gitIn(root)
    git('add', '-A')
    git('commit', '-q', '-m', 'init')
    const cacheDir = path.join(root, '.cache')
    expect((await vx(root, ['run', 'build', '--all', '--cache-dir', cacheDir])).code).toBe(0)
    const d = path.join(proj, 'dist')
    if (change === 'edited') writeFileSync(path.join(d, 'out.txt'), 'changed\n')
    if (change === 'deleted') rmSync(path.join(d, 'out.txt'))
    if (change.includes('link'))
      rmSync(path.join(d, change.includes('dangling') ? 'dangling' : 'link'))
    if (change === 'retargeted link') symlinkSync('b.txt', path.join(d, 'link'))
    if (change === 'link made a file') writeFileSync(path.join(d, 'link'), 'a\n')
    const hit = await vx(root, ['run', 'build', '--all', '--cache-dir', cacheDir])
    expect(`${hit.code}\n${hit.err}`).toStartWith('0\n')
    expect([
      readFileSync(path.join(d, 'out.txt'), 'utf8'),
      readlinkSync(path.join(d, 'link')),
      readlinkSync(path.join(d, 'dangling')),
    ]).toEqual(['archived\n', 'a.txt', 'missing'])
  }, 60_000)
}

// vercel/turborepo#12488: a directory the entry holds, found on disk as a
// link into the project's sources, was written through, into the sources.
it('a hit replaces a link where the entry holds a directory, and writes nothing through it', async () => {
  const root = await makeWorkspace({ prefix: 'vx-ported-dirlink-' })
  made.push(root)
  const proj = await addProject(root, 'app', {
    config: `export default { tasks: { build: {
      exec: { command: 'mkdir -p dist/runtime && echo built > dist/runtime/x.js' },
      inputs: { files: ['src/in.txt'] }, cache: { outputs: { files: ['dist/**'] } },
    } } }`,
    files: { 'src/in.txt': 'v1\n', 'src/runtime/x.js': 'source\n' },
  })
  const git = gitIn(root)
  git('add', '-A')
  git('commit', '-q', '-m', 'init')
  const cacheDir = path.join(root, '.cache')
  expect((await vx(root, ['run', 'build', '--all', '--cache-dir', cacheDir])).code).toBe(0)
  rmSync(path.join(proj, 'dist', 'runtime'), { recursive: true })
  symlinkSync('../src/runtime', path.join(proj, 'dist', 'runtime'))
  const hit = await vx(root, ['run', 'build', '--all', '--cache-dir', cacheDir])
  expect(`${hit.code}\n${hit.err}`).toStartWith('0\n')
  expect(hit.out).toContain('local 1↓')
  expect(statSync(path.join(proj, 'dist', 'runtime'), { throwIfNoEntry: true }).isDirectory()).toBe(
    true,
  )
  expect(existsSync(path.join(proj, 'dist', 'runtime', 'x.js'))).toBe(true)
  expect([
    readFileSync(path.join(proj, 'dist', 'runtime', 'x.js'), 'utf8'),
    readFileSync(path.join(proj, 'src', 'runtime', 'x.js'), 'utf8'),
  ]).toEqual(['built\n', 'source\n'])
  expect(() => readlinkSync(path.join(proj, 'dist', 'runtime'))).toThrow()
}, 60_000)
