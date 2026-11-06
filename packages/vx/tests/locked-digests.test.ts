// A run keys a claimed lockfile from `.vx/dependencies.lock.json`, as it
// takes configs from `.vx/projects.lock.json`: the file's bytes must hash
// to what `vx lock` recorded, and the recorded per-project digests are the
// key; the file is never parsed. A file changed since, a lock with no
// record of a present file, or no lock at all refuses with `vx lock` as
// the fix. A file the digests read (a `link:` directory, edited with no
// install) that moved since makes the record stale for the claimant, which
// digests anew. The fixture's claim counts its parses on `globalThis` (the
// workspace file evaluates in this process) and throws once told a run
// must not parse.
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { type Logger } from '../src/index.js'
import { lock } from './helpers/orchestrator.js'
import { planRun } from '../src/orchestrator/index.js'
import { CORE_INDEX, localWorkspaceSource } from './helpers/local-workspace.js'
import { pluginSource } from './helpers/plugin.js'

const TIMEOUT = 30_000
const LOCK = '.vx/dependencies.lock.json'
const g = globalThis as { __vxParses?: number; __vxNoParse?: boolean }
let root: string

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vx-locked-digests-'))
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'ws', private: true }))
  await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
  Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: root })
  const dir = path.join(root, 'packages', 'a')
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'a', version: '1.0.0' }))
  await writeFile(
    path.join(dir, 'vx.config.mjs'),
    "export default { tasks: { build: { exec: { command: 'echo b' }, inputs: { files: [] }, outputs: { files: [] }, cache: true } } }\n",
  )
  // Lines `dir=digest`; `extra:<path>` names a file the digests read.
  const prelude = `import { lockfileClaim } from ${JSON.stringify(CORE_INDEX)}
const claim = lockfileClaim({
  file: 'deps.lock',
  version: 1,
  extraFiles: (text) => text.split('\\n').filter((l) => l.startsWith('extra:')).map((l) => l.slice(6)),
  digest: (text) => {
    globalThis.__vxParses = (globalThis.__vxParses ?? 0) + 1
    if (globalThis.__vxNoParse) throw new Error('deps.lock parsed by a run')
    return new Map(text.split('\\n').filter((l) => l.includes('=')).map((l) => l.split('=')))
  },
})
`
  await Bun.write(
    path.join(root, '.vx/workspace.mjs'),
    localWorkspaceSource(
      [pluginSource('org/claim', '{ fingerprint: claim.fingerprint, key: claim.key }')],
      prelude,
    ),
  )
  await claimed('packages/a=a1\nextra:patches/p.patch\n')
  await mkdir(path.join(root, 'patches'))
  await writeFile(path.join(root, 'patches', 'p.patch'), 'one')
  g.__vxParses = 0
  g.__vxNoParse = false
})
afterEach(async () => {
  delete g.__vxParses
  delete g.__vxNoParse
  await rm(root, { recursive: true, force: true })
})

const claimed = (text: string) => writeFile(path.join(root, 'deps.lock'), text)

function silent(): Logger {
  return {
    runStart() {},
    taskStart() {},
    taskStdout() {},
    taskStderr() {},
    taskComplete() {},
    runStatus() {},
    runEnd() {},
    status() {},
  } as never
}

/** The claim's key part on a#build, from a run that may not parse unless told. */
async function part(parse = false): Promise<string | undefined> {
  g.__vxNoParse = !parse
  const plan = await planRun({ cwd: root, tasks: ['build'], log: silent() })
  return plan.tasks[0]!.node.keyParts?.find(([n]) => n === 'org/claim/deps')?.[1]
}

it(
  'a run keys from the recorded digests and never parses the file',
  async () => {
    await lock(root)
    expect(g.__vxParses).toBeGreaterThan(0)
    expect(await part()).toBe('a1')
    // The record is what keys the task: the proof nothing was parsed.
    const text = (await readFile(path.join(root, LOCK), 'utf8')).replace('"a1"', '"planted"')
    await writeFile(path.join(root, LOCK), text)
    expect(await part()).toBe('planted')
  },
  TIMEOUT,
)

it(
  'a file changed since `vx lock` refuses, named, until `vx lock`',
  async () => {
    await lock(root)
    await claimed('packages/a=a2\nextra:patches/p.patch\n')
    await expect(part()).rejects.toThrow('deps.lock changed since `vx lock`: run `vx lock`')
    g.__vxNoParse = false
    await lock(root)
    expect(await part()).toBe('a2')
  },
  TIMEOUT,
)

it(
  'a file its digests read, changed since `vx lock`, is digested anew: the record is stale',
  async () => {
    await lock(root)
    const text = (await readFile(path.join(root, LOCK), 'utf8')).replace('"a1"', '"planted"')
    await writeFile(path.join(root, LOCK), text)
    // CONTROL: unchanged, the record keys it.
    expect(await part()).toBe('planted')
    await writeFile(path.join(root, 'patches', 'p.patch'), 'two')
    const parses = g.__vxParses!
    expect(await part(true)).toBe('a1')
    expect(g.__vxParses).toBe(parses + 1)
    // The parse is memoised like any: the next run reads the memo.
    expect(await part()).toBe('a1')
    // CONTROL: back as locked, the record keys it again.
    await writeFile(path.join(root, 'patches', 'p.patch'), 'one')
    expect(await part()).toBe('planted')
  },
  TIMEOUT,
)

it(
  'a file removed since `vx lock` refuses',
  async () => {
    await lock(root)
    await rm(path.join(root, 'deps.lock'))
    await expect(part()).rejects.toThrow('deps.lock changed since `vx lock`: run `vx lock`')
  },
  TIMEOUT,
)

it(
  'no dependencies lock, or none recording a present file, refuses: never a parse',
  async () => {
    await lock(root)
    await rm(path.join(root, LOCK))
    await expect(part()).rejects.toThrow(`no ${LOCK}: run \`vx lock\``)
    // A lock written before the file was there records none of it.
    g.__vxNoParse = false
    await rm(path.join(root, 'deps.lock'))
    await lock(root)
    expect(await part()).toBeUndefined()
    await claimed('packages/a=a1\n')
    await expect(part()).rejects.toThrow(`deps.lock is not in ${LOCK}: run \`vx lock\``)
  },
  TIMEOUT,
)
