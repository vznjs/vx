// An upgrade that moves SCHEMA_VERSION drops every table — cache entries
// and run history — on the next open, and a CACHE_VERSION bump moves
// every key. vx keeps its own cache: neither is printed (owner,
// 2026-10-06, "no more comments like this").

import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { run } from '../src/index.js'
import { run as cli } from '../src/cli/index.js'
import { SCHEMA_VERSION } from '../src/cache/index.js'
import { formatBytes } from '../src/util/index.js'

let root: string
const origCwd = process.cwd()

function logger(lines: string[]) {
  return {
    runStart: () => undefined,
    taskStart: () => undefined,
    taskStdout: () => undefined,
    taskStderr: () => undefined,
    taskComplete: () => undefined,
    runStatus: () => undefined,
    runEnd: () => undefined,
    status: (line: string) => {
      lines.push(line)
    },
  }
}

async function runOnce(): Promise<string[]> {
  const lines: string[] = []
  const summary = await run({
    cwd: root,
    tasks: ['build'],
    projects: ['app'],
    log: logger(lines),
    handleSignals: false,
  })
  expect(summary.ok).toBe(true)
  return lines.filter(housekeeping)
}

/** Any line about the cache's own upkeep; the owner wants none. */
function housekeeping(line: string): boolean {
  return /cache index reset|cache format changed|shared cache store|shared store|vx upgraded/.test(
    line,
  )
}

/** The index as a reader finds it: the recorded schema and how many entries and runs it holds. */
function index(): { version: string; entries: number; runs: number } {
  const db = new Database(path.join(root, '.vx', 'cache', 'cache.db'))
  try {
    return db
      .query(
        "SELECT (SELECT value FROM schema_meta WHERE key = 'version') AS version, (SELECT count(*) FROM entries) AS entries, (SELECT count(*) FROM invocations) AS runs",
      )
      .get() as { version: string; entries: number; runs: number }
  } finally {
    db.close()
  }
}

/** Runs a verb with stderr captured; resolves to what it threw (or null) and what it wrote. */
async function verb(
  args: string[],
): Promise<{ threw: string | null; stderr: string; stdout: string }> {
  process.chdir(root)
  let stderr = ''
  let stdout = ''
  const origErr = process.stderr.write.bind(process.stderr)
  const origOut = process.stdout.write.bind(process.stdout)
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += String(chunk)
    return true
  }) as typeof process.stderr.write
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += String(chunk)
    return true
  }) as typeof process.stdout.write
  let threw: string | null = null
  try {
    await cli(args)
  } catch (err) {
    threw = (err as Error).message
  } finally {
    process.stderr.write = origErr
    process.stdout.write = origOut
  }
  return { threw, stderr, stdout }
}

function pokeVersion(value: string): void {
  const db = new Database(path.join(root, '.vx', 'cache', 'cache.db'))
  db.query("UPDATE schema_meta SET value = ? WHERE key = 'version'").run(value)
  db.close()
}

describe('an upgrade resets the cache in silence', () => {
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'vx-schema-reset-'))
    await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'r', private: true }))
    const app = path.join(root, 'packages', 'app')
    await mkdir(path.join(app, 'src'), { recursive: true })
    await writeFile(path.join(app, 'package.json'), JSON.stringify({ name: 'app' }))
    await writeFile(path.join(app, 'src', 'index.js'), 'export {}\n')
    await writeFile(
      path.join(app, 'vx.config.mjs'),
      `export default { tasks: { build: { exec: { command: 'true' },
        cache: { inputs: { files: ['src/**'] }, outputs: { files: [] } } } } }\n`,
    )
    await Bun.spawn(['git', 'init', '-q'], { cwd: root }).exited
  })

  afterEach(async () => {
    process.chdir(origCwd)
    await rm(root, { recursive: true, force: true })
  })

  it('the run after an upgrade resets the index and says nothing', async () => {
    expect(await runOnce()).toEqual([])
    pokeVersion('v0')
    expect(await runOnce()).toEqual([])
    expect(index().version).toBe(SCHEMA_VERSION)
  })

  // Item 896: a reading verb never resets the index. `vx last`, `vx why`,
  // `vx info` and a dry prune dropped every table of an earlier schema, and
  // of a NEWER one too, announcing "vx upgraded" after a downgrade.
  for (const args of [['last'], ['why', 'app#build'], ['info']]) {
    it(`\`vx ${args[0]}\` refuses an earlier schema and leaves it untouched`, async () => {
      expect(await runOnce()).toEqual([])
      pokeVersion('v0')
      const before = index()
      const { threw, stderr } = await verb(args)
      expect({ threw, stderr, after: index() }).toEqual({
        // "a reading verb leaves it untouched" was false of `vx show`, which
        // opens the index to store configs and resets it: the message
        // speaks for the verb that printed it (item 1042).
        threw: expect.stringContaining(
          `holds index schema v0 from an earlier vx; this vx reads ${SCHEMA_VERSION}, so nothing in it is readable here, and this verb leaves it untouched. The next \`vx run\` resets it`,
        ) as unknown as string,
        stderr: '',
        after: before,
      })
      expect(before.entries).toBe(1)
    })
  }

  // A prune that deletes opens the index to write it, so an earlier schema
  // is reset there as a run resets it, and says so once as a run does. The
  // notice is the one word the user gets that every entry just went; the
  // sweep of cli/cache.ts (E-9) deleted it with the suite green.
  it('a prune that deletes resets an earlier schema in silence', async () => {
    expect(await runOnce()).toEqual([])
    pokeVersion('v0')
    const { threw, stderr } = await verb(['cache', 'prune', '--older-than', '1d'])
    expect(threw).toBeNull()
    expect(stderr.split('\n').filter(housekeeping)).toEqual([])
    expect(index().version).toBe(SCHEMA_VERSION)
  })

  // Item 1083: the dry prune refused an earlier schema, so it could not
  // preview the prune after an upgrade, which resets the index and reaps
  // every aged artifact as row-less. It now names what that prune reaps,
  // and still writes nothing.
  it('`vx cache prune --dry-run` on an earlier schema names what the real prune reaps', async () => {
    expect(await runOnce()).toEqual([])
    pokeVersion('v0')
    const cacheDir = path.join(root, '.vx', 'cache')
    const artifacts = Array.from(new Bun.Glob('*.tar.zst').scanSync({ cwd: cacheDir }))
    expect(artifacts).toHaveLength(1)
    const aged = new Date(Date.now() - 2 * 60 * 60 * 1000)
    await utimes(path.join(cacheDir, artifacts[0]!), aged, aged)
    const bytes = Bun.file(path.join(cacheDir, artifacts[0]!)).size
    const before = index()
    const dry = await verb(['cache', 'prune', '--older-than', '30d', '--dry-run'])
    expect({ ...dry, after: index() }).toEqual({
      threw: null,
      stderr:
        "[vx] the cache index is schema v0 from an earlier vx: the prune resets it first, and every artifact past the hour's grace is then an orphan\n",
      stdout: `Would prune 0 entries (0 B), would reap 1 orphaned artifact (${formatBytes(bytes)})\n`,
      after: before,
    })
    const wet = await verb(['cache', 'prune', '--older-than', '30d'])
    expect({ threw: wet.threw, stdout: wet.stdout }).toEqual({
      threw: null,
      stdout: `Pruned 0 entries (0 B freed), reaped 1 orphaned artifact (${formatBytes(bytes)})\n`,
    })
  })

  it('every opener, a run too, refuses a NEWER schema and leaves it untouched', async () => {
    expect(await runOnce()).toEqual([])
    pokeVersion('v999')
    const before = index()
    let threw: unknown
    try {
      await runOnce()
    } catch (err) {
      threw = err
    }
    expect((threw as Error).message).toContain('holds index schema v999, written by a newer vx')
    expect((await verb(['last'])).threw).toContain('written by a newer vx')
    expect(index()).toEqual(before)
    expect(before).toEqual({ version: 'v999', entries: 1, runs: 1 })
  })

  it('`vx show` says nothing either, from the staged load the reading verbs share', async () => {
    expect(await runOnce()).toEqual([])
    pokeVersion('v0')
    process.chdir(root)
    let stderr = ''
    const origErr = process.stderr.write.bind(process.stderr)
    const origOut = process.stdout.write.bind(process.stdout)
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderr += String(chunk)
      return true
    }) as typeof process.stderr.write
    process.stdout.write = (() => true) as typeof process.stdout.write
    try {
      await cli(['show'])
    } finally {
      process.stderr.write = origErr
      process.stdout.write = origOut
    }
    expect(stderr.split('\n').filter(housekeeping)).toEqual([])
  })

  // Roadmap 3.3 (item 671): a CACHE_VERSION bump keeps the index but moves
  // every key; the all-miss run it causes is announced like a reset.
  function pokeFormat(value: string | null): void {
    const db = new Database(path.join(root, '.vx', 'cache', 'cache.db'))
    if (value === null) db.query("DELETE FROM schema_meta WHERE key = 'cache_version'").run()
    else db.query("UPDATE schema_meta SET value = ? WHERE key = 'cache_version'").run(value)
    db.close()
  }

  it('a cache-format bump says nothing', async () => {
    expect(await runOnce()).toEqual([])
    pokeFormat('vx-cache-v0')
    expect(await runOnce()).toEqual([])
    expect(await runOnce()).toEqual([])
  })

  // A reading verb wrote the new format over the old one, so the run after
  // it missed everything with no word of why (item 1080).
  for (const args of [['info'], ['cache', 'prune', '--older-than', '30d', '--dry-run']]) {
    it(`\`vx ${args.join(' ')}\` and the run after it say nothing of a format bump`, async () => {
      expect(await runOnce()).toEqual([])
      pokeFormat('vx-cache-v0')
      expect((await verb(args)).threw).toBeNull()
      expect(await runOnce()).toEqual([])
    })
  }

  it('a store with entries and no recorded format says nothing', async () => {
    expect(await runOnce()).toEqual([])
    pokeFormat(null)
    expect(await runOnce()).toEqual([])
  })

  it('a schema reset and a format bump together say nothing', async () => {
    expect(await runOnce()).toEqual([])
    pokeVersion('v0')
    pokeFormat('vx-cache-v0')
    expect(await runOnce()).toEqual([])
  })
})
