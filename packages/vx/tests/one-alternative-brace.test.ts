// `Bun.Glob` reads `{b}` as a brace of one alternative: `src/{b}.ts` matched
// `src/b.ts` and never the file named `src/{b}.ts`, which stayed out of the
// key, so an edit to it was a hit. The entry is refused at `vx lock`
// (`validateProjectConfig`; every run refused it after a lock that took it,
// 2026-10-17), naming both spellings; the escaped one selects the braces
// themselves. A path under `.git` keyed nothing and is refused the same way.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { resolveInputs } from '../src/cache/inputs.js'
import type { InputsConfig } from '../src/config.js'
import { relPosix } from '../src/util/index.js'
import { validateProjectConfig } from '../src/workspace/config-schema.js'

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

async function resolve(inputs: InputsConfig): Promise<string[]> {
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

function refusal(inputs: InputsConfig): string {
  try {
    validateProjectConfig(
      { tasks: { t: { exec: { command: 'x' }, inputs, cache: { outputs: { files: [] } } } } },
      'vx.config.ts',
    )
  } catch (err) {
    return (err as Error).message.replace(/^.*?inputs\./, 'inputs.')
  }
  return 'accepted'
}

describe('a brace of one alternative', () => {
  it('is refused in files, naming both spellings', () => {
    expect(refusal({ files: ['src/{b}.ts'] })).toBe(
      'inputs.files: "src/{b}.ts" holds a brace with one alternative, which matches "b" ' +
        'and never a name holding "{b}". Write "src/b.ts", or "src/\\{b\\}.ts" for the braces themselves.',
    )
  })

  it('is refused in workspaceFiles', () => {
    expect(refusal({ files: [], workspaceFiles: ['pkg/src/{b}.ts'] })).toStartWith(
      'inputs.workspaceFiles: "pkg/src/{b}.ts" holds a brace with one alternative',
    )
  })

  it('is refused in a negation and when empty', () => {
    expect(refusal({ files: ['src/**', '!src/{b}.ts'] })).toStartWith(
      'inputs.files: "!src/{b}.ts" holds',
    )
    expect(refusal({ files: ['src/{}.ts'] })).toStartWith('inputs.files: "src/{}.ts" holds')
  })

  it('a path under .git is refused, in files and workspaceFiles', () => {
    expect(refusal({ files: ['.git/config'] })).toStartWith(
      'inputs.files: ".git/config" names a path under .git, which git never lists, so it keys nothing — inputs are the repository\'s files',
    )
    expect(refusal({ files: [], workspaceFiles: ['.git/HEAD'] })).toStartWith(
      'inputs.workspaceFiles: ".git/HEAD" names a path under .git',
    )
    expect(refusal({ files: ['src/**', '.gitignore', '.github/**'] })).toBe('accepted')
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
