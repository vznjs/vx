// An upgrade that moves SCHEMA_VERSION drops every table — cache entries
// and run history — on the next open. Silently, the run after it is an
// all-miss run that looks like a bug; so the opener that did the drop
// says so once, on the run's status line and on a verb's stderr.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { run } from '../src/index.js'
import { run as cli } from '../src/cli/index.js'
import { CACHE_VERSION } from '../src/cache/index.js'

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
  return lines.filter((l) => l.includes('cache index reset') || l.includes('cache format changed'))
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
async function verb(args: string[]): Promise<{ threw: string | null; stderr: string }> {
  process.chdir(root)
  let stderr = ''
  const origErr = process.stderr.write.bind(process.stderr)
  const origOut = process.stdout.write.bind(process.stdout)
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += String(chunk)
    return true
  }) as typeof process.stderr.write
  process.stdout.write = (() => true) as typeof process.stdout.write
  let threw: string | null = null
  try {
    await cli(args)
  } catch (err) {
    threw = (err as Error).message
  } finally {
    process.stderr.write = origErr
    process.stdout.write = origOut
  }
  return { threw, stderr }
}

function pokeVersion(value: string): void {
  const db = new Database(path.join(root, '.vx', 'cache', 'cache.db'))
  db.prepare("UPDATE schema_meta SET value = ? WHERE key = 'version'").run(value)
  db.close()
}

describe('a schema reset says so once', () => {
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

  it('the run after an upgrade names both versions; the run after that is quiet', async () => {
    expect(await runOnce()).toEqual([])
    pokeVersion('v0')
    const notices = await runOnce()
    expect(notices).toHaveLength(1)
    expect(notices[0]).toMatch(/^\[vx\] cache index reset: schema v0 → v\d+ \(vx upgraded\)/)
    expect(notices[0]).toContain('vx cache prune')
    // Control: the version now matches, so the next run says nothing.
    expect(await runOnce()).toEqual([])
  })

  // Item 896: a reading verb never resets the index. `vx last`, `vx why`,
  // `vx info` and a dry prune dropped every table of an earlier schema, and
  // of a NEWER one too, announcing "vx upgraded" after a downgrade.
  for (const args of [
    ['last'],
    ['why', 'app#build'],
    ['info'],
    ['cache', 'prune', '--older-than', '1d', '--dry-run'],
  ]) {
    it(`\`vx ${args[0]}${args[0] === 'cache' ? ' prune --dry-run' : ''}\` refuses an earlier schema and leaves it untouched`, async () => {
      expect(await runOnce()).toEqual([])
      pokeVersion('v0')
      const before = index()
      const { threw, stderr } = await verb(args)
      expect({ threw, stderr, after: index() }).toEqual({
        threw: expect.stringContaining(
          'holds index schema v0 from an earlier vx',
        ) as unknown as string,
        stderr: '',
        after: before,
      })
      expect(before.entries).toBe(1)
    })
  }

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

  it('`vx show` says it too, from the staged load the reading verbs share', async () => {
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
    expect(stderr).toMatch(/^\[vx\] cache index reset: schema v0 → v\d+ \(vx upgraded\)/m)
  })

  // Roadmap 3.3 (item 671): a CACHE_VERSION bump keeps the index but moves
  // every key; the all-miss run it causes is announced like a reset.
  function pokeFormat(value: string | null): void {
    const db = new Database(path.join(root, '.vx', 'cache', 'cache.db'))
    if (value === null) db.prepare("DELETE FROM schema_meta WHERE key = 'cache_version'").run()
    else db.prepare("UPDATE schema_meta SET value = ? WHERE key = 'cache_version'").run(value)
    db.close()
  }

  it('a cache-format bump names both versions once; the next run is quiet', async () => {
    expect(await runOnce()).toEqual([])
    pokeFormat('vx-cache-v0')
    expect(await runOnce()).toEqual([
      `[vx] cache format changed: vx-cache-v0 → ${CACHE_VERSION} (vx upgraded); every cached task misses once and re-saves, and the old entries, never read again, age out under \`vx cache prune --older-than\` or \`cacheRetention\``,
    ])
    expect(await runOnce()).toEqual([])
  })

  it('a store with entries and no recorded format predates the record, and says so', async () => {
    expect(await runOnce()).toEqual([])
    pokeFormat(null)
    expect(await runOnce()).toEqual([
      `[vx] cache format changed: an earlier format → ${CACHE_VERSION} (vx upgraded); every cached task misses once and re-saves, and the old entries, never read again, age out under \`vx cache prune --older-than\` or \`cacheRetention\``,
    ])
  })

  it('a schema reset and a format bump together say the reset alone', async () => {
    expect(await runOnce()).toEqual([])
    pokeVersion('v0')
    pokeFormat('vx-cache-v0')
    const notices = await runOnce()
    expect(notices).toHaveLength(1)
    expect(notices[0]).toMatch(/^\[vx\] cache index reset: schema v0 → v\d+/)
  })
})
