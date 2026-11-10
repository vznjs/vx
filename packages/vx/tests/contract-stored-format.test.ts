// What a cache stores is read back by the next vx, and two versions gate
// the reading: `SCHEMA_VERSION` the index (`cache.db`), `CACHE_VERSION`
// the artifact container. A layout that moves under an unchanged version
// is read by a vx that expects the other layout: a missing column fails
// every insert on an upgraded cache only (A-54), and an artifact read
// with the wrong container restores wrong bytes under a green hit. This
// records each layout beside the version that names it, in
// `tests/contract/stored-format.json`: the index's DDL as a fresh open
// makes it, a fixture artifact's entries, sidecar and digest, and the
// tree (`cache.store.decompress`) a save keeps of it. A
// changed layout under the recorded version fails; with the version
// bumped, regenerate:
//   VX_UPDATE_CONTRACT=1 bun test tests/contract-stored-format.test.ts
// which refuses to rewrite a layout under the version it was recorded at.

import { Database } from 'bun:sqlite'
import { afterAll, describe, expect, it } from 'bun:test'
import { chmodSync, lstatSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { packArtifact } from '../src/cache/archive.js'
import { CACHE_VERSION, Cache, SCHEMA_VERSION } from '../src/cache/index.js'
import { tarEntries } from '../src/cache/tar-stream.js'

const RECORD = path.join(import.meta.dir, 'contract', 'stored-format.json')

interface Layout {
  version: string
  layout: unknown
}
interface StoredFormat {
  index: Layout
  artifact: Layout
}

const dirs: string[] = []
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true })
})
const tmp = async (): Promise<string> => {
  const d = await mkdtemp(path.join(os.tmpdir(), 'vx-stored-'))
  dirs.push(d)
  return d
}

/** Every table, index and trigger a fresh open makes, as SQLite keeps it. */
async function indexLayout(): Promise<string[]> {
  const dir = await tmp()
  new Cache(dir).close()
  const db = new Database(path.join(dir, 'cache.db'), { readonly: true })
  try {
    const rows = db
      .query(
        "SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type, name",
      )
      .all() as Array<{ sql: string }>
    return rows.flatMap(({ sql }) => [
      ...sql
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l !== '' && !l.startsWith('--')),
      '',
    ])
  } finally {
    db.close()
  }
}

/** One fixed artifact: each tar entry's header and the sidecar, and the bytes' digest. */
async function artifactLayout(): Promise<unknown> {
  const dir = await tmp()
  const file = path.join(dir, 'a.txt')
  await writeFile(file, 'hello\n')
  chmodSync(file, 0o644)
  // Half a millisecond past, so the sidecar's floor reads 123 on any clock grain.
  utimesSync(file, 1_700_000_000, 1_700_000_000.1235)
  const bytes = await packArtifact({
    key: 'fixture-key',
    stdout: 'built\n',
    outputs: new Map([['dist/a.txt', file]]),
    exec: { cpuMs: 7, peakRssBytes: 4096 },
  })
  const entries: unknown[] = []
  for await (const e of tarEntries(new Blob([bytes]).stream())) {
    const body = Buffer.concat(await Array.fromAsync(e.body)).toString('utf8')
    entries.push({
      name: e.name,
      type: e.type,
      size: e.size,
      mtimeMs: e.mtimeMs,
      body: e.name === 'dist/a.txt' || e.name === 'stdout' || e.name.endsWith('.json') ? body : '…',
    })
  }
  const sha256 = new Bun.CryptoHasher('sha256').update(bytes).digest('hex')
  return { entries, sha256, tree: await treeLayout() }
}

/** What a tree-form save of a file, a link and a workspace file keeps on disk: each path and kind. */
async function treeLayout(): Promise<string[]> {
  const ws = await tmp()
  const proj = path.join(ws, 'p')
  await mkdir(path.join(proj, 'dist'), { recursive: true })
  await mkdir(path.join(ws, 'gen'))
  await writeFile(path.join(proj, 'dist/a.txt'), 'hello\n')
  await symlink('a.txt', path.join(proj, 'dist/l'))
  await writeFile(path.join(ws, 'gen/w.txt'), 'w\n')
  const store = path.join(ws, 'store')
  const cache = new Cache(store, undefined, undefined, undefined, undefined, undefined, {
    embeddings: 0,
    decompress: true,
  })
  try {
    await cache.save({
      hash: 'fixture-key',
      entry: { taskId: 'p#build', command: 'build', durationMs: 1, stdout: 'built\n' },
      projectDir: proj,
      outputFiles: [path.join(proj, 'dist/a.txt'), path.join(proj, 'dist/l')],
      workspaceOutputFiles: [path.join(ws, 'gen/w.txt')],
      workspaceRoot: ws,
    })
  } finally {
    cache.close()
  }
  const tree = path.join(store, 'fixture-key.tree')
  return readdirSync(tree, { recursive: true })
    .map(String)
    .sort()
    .map((rel) => {
      const st = lstatSync(path.join(tree, rel))
      return `${st.isSymbolicLink() ? 'link' : st.isDirectory() ? 'dir' : 'file'} ${rel}`
    })
}

describe('the stored formats move with their versions', () => {
  it('a recorded layout changes only with its version, and the record is current', async () => {
    const live: StoredFormat = {
      index: { version: SCHEMA_VERSION, layout: await indexLayout() },
      artifact: { version: CACHE_VERSION, layout: await artifactLayout() },
    }
    const recorded = JSON.parse(readFileSync(RECORD, 'utf8')) as StoredFormat
    const unbumped = (['index', 'artifact'] as const).filter(
      (k) =>
        live[k].version === recorded[k].version &&
        JSON.stringify(live[k].layout) !== JSON.stringify(recorded[k].layout),
    )
    // A layout that moved under its recorded version: bump the version
    // (SCHEMA_VERSION for the index, CACHE_VERSION for the artifact) first.
    expect(unbumped).toEqual([])
    if (process.env['VX_UPDATE_CONTRACT'] === '1' && process.env['CI'] !== 'true') {
      writeFileSync(RECORD, JSON.stringify(live, null, 2) + '\n')
    }
    expect(live).toEqual(JSON.parse(readFileSync(RECORD, 'utf8')))
  })
})
