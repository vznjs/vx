import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import { withForwardArgs } from '@vzn/vx'
import { foldScriptHooks, scriptCommand, yarnPnp } from '../src/script-command.js'

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
      // `npm run install` runs `preinstall` too.
      preinstall: 'node check.js',
      install: 'node-gyp rebuild',
    }
    expect(scriptCommand('build', 'tsup', scripts)).toBe(
      foldScriptHooks('cp a.css a.directcss', 'tsup', 'rm a.directcss'),
    )
    expect(scriptCommand('test', 'vitest', scripts)).toBe('vitest')
    expect(scriptCommand('install', 'node-gyp rebuild', scripts)).toBe(
      foldScriptHooks('node check.js', 'node-gyp rebuild', undefined),
    )
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

  it('quotes a script name the shell would split or expand', () => {
    // `yarn run a b` ran script `a` with an argument; `$(…)` ran in sh.
    expect(scriptCommand('build all', 'x', {}, true)).toBe("yarn run 'build all'")
    expect(scriptCommand("it's$(id)", 'run x')).toBe(`yarn run 'it'\\''s$(id)'`)
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
      expect(yarnPnp(root)).toBe(expected)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('foldScriptHooks runs the hooks as npm does', () => {
  const run = async (command: string, args: string[] = []) => {
    const full = withForwardArgs(command, args)
    const p = Bun.spawn(['sh', '-c', full], { stdout: 'pipe', stderr: 'ignore' })
    const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited])
    return { code, out: out.trim().split('\n') }
  }

  it('hands the forwarded args to the body alone, not the post hook', async () => {
    expect(
      await run(foldScriptHooks('echo PRE', 'echo BODY', 'echo POST'), ['--flag', 'a b']),
    ).toEqual({ code: 0, out: ['PRE', 'BODY --flag a b', 'POST'] })
  })

  it('stops at a failing pre hook even when the body holds a `;`', async () => {
    expect(await run(foldScriptHooks('false', 'echo A; echo B', 'echo POST'))).toEqual({
      code: 1,
      out: [''],
    })
  })

  it('runs no post hook after a failing body, and keeps the body’s code', async () => {
    expect(await run(foldScriptHooks(undefined, 'echo A; exit 3', 'echo POST'))).toEqual({
      code: 3,
      out: ['A'],
    })
  })

  it('survives a trailing comment in any part', async () => {
    expect(await run(foldScriptHooks('echo PRE # c', 'echo BODY # c', 'echo POST # c'))).toEqual({
      code: 0,
      out: ['PRE', 'BODY', 'POST'],
    })
  })

  it('appends the args as text, as npm does: no part sees them as $1', async () => {
    const fold = foldScriptHooks('echo pre:$1:$#', 'echo body:$1:$#: "$*"', 'echo post:$1:$#')
    expect(await run(fold, ['foo', "it's", 'a b', '$HOME'])).toEqual({
      code: 0,
      out: ['pre::0', "body::0:  foo it's a b $HOME", 'post::0'],
    })
    const npm = await run('echo body:$1:$#: "$*"', ['foo', "it's", 'a b', '$HOME'])
    expect(npm.out[0]).toBe("body::0:  foo it's a b $HOME")
  })

  it('CONTROL: a script with no hooks is its body, verbatim', () => {
    expect(foldScriptHooks(undefined, 'tsc -b && echo x', undefined)).toBe('tsc -b && echo x')
  })
})
