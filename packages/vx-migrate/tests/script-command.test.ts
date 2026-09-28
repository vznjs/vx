import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import { foldScriptHooks } from '@vzn/vx'
import { scriptCommand, yarnPnp } from '../src/script-command.js'

describe('scriptCommand — a script body becomes the task command', () => {
  it('inlines a body that stands on its own in sh', () => {
    expect(scriptCommand('build', 'tsc -b')).toBe('tsc -b')
    expect(scriptCommand('build', 'pnpm run clean && tsc -b')).toBe('pnpm run clean && tsc -b')
    expect(scriptCommand('build', 'npm-run-all clean --parallel build:code')).toBe(
      'npm-run-all clean --parallel build:code',
    )
    // `run` inside a word or an argument is not the builtin.
    expect(scriptCommand('test', 'vitest run')).toBe('vitest run')
    expect(scriptCommand('test', 'prerun-check && vitest')).toBe('prerun-check && vitest')
  })

  it('folds pre<name> and post<name> hooks into the command, in that order', () => {
    // novu, 2026-09-11: `prebuild` copies the CSS the build inlines.
    const scripts = {
      prebuild: 'cp a.css a.directcss',
      build: 'tsup',
      postbuild: 'rm a.directcss',
      test: 'vitest',
      // Lifecycle hooks of the package manager's own verbs never ride inside a task.
      preinstall: 'node check.js',
      install: 'node-gyp rebuild',
    }
    expect(scriptCommand('build', 'tsup', scripts)).toBe(
      foldScriptHooks('cp a.css a.directcss', 'tsup', 'rm a.directcss'),
    )
    expect(scriptCommand('test', 'vitest', scripts)).toBe('vitest')
    expect(scriptCommand('install', 'node-gyp rebuild', scripts)).toBe('node-gyp rebuild')
    // An empty hook is no hook.
    expect(scriptCommand('build', 'tsup', { prebuild: '', build: 'tsup' })).toBe('tsup')
    // yarn >= 2 runs no hooks: a builtin anywhere means `yarn run`, hooks dropped.
    expect(scriptCommand('build', 'tsup', { prebuild: 'run clean', build: 'tsup' })).toBe(
      'yarn run build',
    )
  })

  it("routes a body that calls yarn's `run` builtin through `yarn run <name>`", () => {
    // strapi, 2026-09-11: every package script is `run -T <root bin>`.
    expect(scriptCommand('build:code', 'run -T rollup -c')).toBe('yarn run build:code')
    expect(scriptCommand('build', 'run -T npm-run-all clean --parallel build:code')).toBe(
      'yarn run build',
    )
    expect(scriptCommand('build', 'run clean && run build:code')).toBe('yarn run build')
    expect(scriptCommand('build', 'tsc -b; run copy')).toBe('yarn run build')
  })
})

describe("Yarn Plug'n'Play: no node_modules, so every script runs through `yarn run`", () => {
  it('a PnP workspace runs the script by name, hooks and all left to yarn', () => {
    const scripts = { prebuild: 'gen', build: 'node -e "require(\'left-pad\')"' }
    expect(scriptCommand('build', scripts.build, scripts, true)).toBe('yarn run build')
  })

  it.each([
    ['no .yarnrc.yml (yarn 1, npm, pnpm)', null, false],
    ['a .yarnrc.yml naming no linker (yarn >= 2 defaults to pnp)', 'yarnPath: y.js\n', true],
    ['nodeLinker: pnp', 'nodeLinker: pnp\n', true],
    ['nodeLinker: "pnp", quoted', 'nodeLinker: "pnp"\n', true],
    ['nodeLinker: node-modules', 'yarnPath: y.js\nnodeLinker: node-modules\n', false],
    ['nodeLinker: pnpm', "nodeLinker: 'pnpm'\n", false],
  ])('%s', async (_what, rc, expected) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'vx-migrate-pnp-'))
    try {
      if (rc !== null) await writeFile(path.join(root, '.yarnrc.yml'), rc)
      expect(await yarnPnp(root)).toBe(expected)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
