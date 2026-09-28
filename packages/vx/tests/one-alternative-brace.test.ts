// `Bun.Glob` reads `{b}` as a brace of one alternative: `src/{b}.ts` matched
// `src/b.ts` and never the file named `src/{b}.ts`, which stayed out of the
// key, so an edit to it was a hit. The entry is refused, naming both
// spellings; the escaped one selects the braces themselves.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { resolveInputs } from '../src/cache/inputs.js'
import type { CacheInputs } from '../src/config.js'
import { relPosix } from '../src/util/index.js'

let root: string
let projectDir: string

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vx-onebrace-'))
  projectDir = path.join(root, 'pkg')
  await mkdir(path.join(projectDir, 'src'), { recursive: true })
  for (const f of ['{b}.ts', 'b.ts', 'c.ts']) await writeFile(path.join(projectDir, 'src', f), f)
  for (const args of [
    ['init', '-q'],
    ['add', '-A'],
  ]) {
    expect(Bun.spawnSync({ cmd: ['git', ...args], cwd: root }).exitCode).toBe(0)
  }
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

async function resolve(inputs: CacheInputs): Promise<string[]> {
  const r = await resolveInputs({
    projectDir,
    workspaceRoot: root,
    envSource: {},
    inputs,
    ownOutputs: [],
    nestedProjectDirs: [],
  })
  return r.files.map((f) => relPosix(root, f)).sort()
}

async function refusal(inputs: CacheInputs): Promise<string> {
  return resolve(inputs).then(
    () => 'resolved',
    (err: Error) => err.message,
  )
}

describe('a brace of one alternative', () => {
  it('is refused in files, naming both spellings', async () => {
    expect(await refusal({ files: ['src/{b}.ts'] })).toBe(
      'cache.inputs.files: "src/{b}.ts" holds a brace with one alternative, which matches "b" ' +
        'and never a name holding "{b}". Write "src/b.ts", or "src/\\{b\\}.ts" for the braces themselves.',
    )
  })

  it('is refused in workspaceFiles', async () => {
    expect(await refusal({ files: [], workspaceFiles: ['pkg/src/{b}.ts'] })).toStartWith(
      'cache.inputs.workspaceFiles: "pkg/src/{b}.ts" holds a brace with one alternative',
    )
  })

  it('is refused in a negation and when empty', async () => {
    expect(await refusal({ files: ['src/**', '!src/{b}.ts'] })).toStartWith(
      'cache.inputs.files: "!src/{b}.ts" holds',
    )
    expect(await refusal({ files: ['src/{}.ts'] })).toStartWith(
      'cache.inputs.files: "src/{}.ts" holds',
    )
  })

  it('control: the escaped form selects the braces, two alternatives select both', async () => {
    expect(await resolve({ files: ['src/\\{b\\}.ts'] })).toEqual(['pkg/src/{b}.ts'])
    expect(await resolve({ files: ['src/{b,c}.ts'] })).toEqual(['pkg/src/b.ts', 'pkg/src/c.ts'])
    expect(await resolve({ files: ['src/*.ts'] })).toEqual([
      'pkg/src/b.ts',
      'pkg/src/c.ts',
      'pkg/src/{b}.ts',
    ])
  })
})
