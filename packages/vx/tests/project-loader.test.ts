import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { loadProjectConfig, loadWorkspaceConfig } from '../src/workspace/project-loader.js'

describe('loadProjectConfig', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'vx-loader-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('loads a default-exported object from .mjs', async () => {
    const file = path.join(dir, 'vx.config.mjs')
    await writeFile(file, "export default { tasks: { build: { exec: { command: 'tsc' } } } }")
    const cfg = await loadProjectConfig(file)
    expect(cfg.tasks?.build?.exec?.command).toBe('tsc')
  })

  it('an import the config cannot resolve is a user error naming the file, with the install hint for @vzn/vx', async () => {
    // The usual cause: the workspace runs the vx binary and never
    // installed `@vzn/vx`, which the config imports at runtime.
    const file = path.join(dir, 'vx.config.mjs')
    await writeFile(
      file,
      "import { defineProject } from '@vzn/vx'\nexport default defineProject({ tasks: {} })\n",
    )
    const err = await loadProjectConfig(file).then(
      () => null,
      (e: unknown) => e as Error,
    )
    expect(err?.name).toBe('UserError')
    expect(err?.message).toContain(`Project config ${file}`)
    expect(err?.message).toContain("cannot find '@vzn/vx'")
    expect(err?.message).toContain('bun add -d @vzn/vx')
    expect(err?.message).not.toContain('vx-bust')
    // Any other unresolved package: same shape, no vx-specific hint.
    await writeFile(file, "import x from 'no-such-package-xyz'\nexport default { tasks: {} }\n")
    const other = await loadProjectConfig(file).then(
      () => null,
      (e: unknown) => e as Error,
    )
    expect(other?.name).toBe('UserError')
    expect(other?.message).toContain("cannot find 'no-such-package-xyz'")
    expect(other?.message).not.toContain('bun add')
  })

  it('throws clearly when the config did not export a default object', async () => {
    const file = path.join(dir, 'vx.config.mjs')
    await writeFile(file, 'export const notDefault = 1')
    await expect(loadProjectConfig(file)).rejects.toThrow(/did not export a default object/)
  })

  it('throws when the default export is not an object', async () => {
    const file = path.join(dir, 'vx.config.mjs')
    await writeFile(file, 'export default 42')
    await expect(loadProjectConfig(file)).rejects.toThrow(/did not export a default object/)
  })

  describe('group tasks (no exec)', () => {
    it('accepts a task that has only dependsOn', async () => {
      const file = path.join(dir, 'vx.config.mjs')
      await writeFile(file, `export default { tasks: { install: { dependsOn: ['^build'] } } }`)
      const cfg = await loadProjectConfig(file)
      expect(cfg.tasks?.install?.exec).toBeUndefined()
      expect(cfg.tasks?.install?.dependsOn).toEqual(['^build'])
    })

    it('rejects a task with no exec and no dependsOn', async () => {
      const file = path.join(dir, 'vx.config.mjs')
      await writeFile(file, `export default { tasks: { empty: {} } }`)
      await expect(loadProjectConfig(file)).rejects.toThrow(/must declare `dependsOn`/)
    })

    it('accepts a string description on a task', async () => {
      const file = path.join(dir, 'vx.config.mjs')
      await writeFile(
        file,
        `export default { tasks: { lint: { description: 'lint with oxlint', exec: { command: 'oxlint' } } } }`,
      )
      const cfg = await loadProjectConfig(file)
      expect(cfg.tasks?.lint?.description).toBe('lint with oxlint')
    })

    it('rejects a non-string description', async () => {
      const file = path.join(dir, 'vx.config.mjs')
      await writeFile(
        file,
        `export default { tasks: { lint: { description: 42, exec: { command: 'oxlint' } } } }`,
      )
      await expect(loadProjectConfig(file)).rejects.toThrow(/description must be a string/)
    })

    it('accepts a persistent exec', async () => {
      const file = path.join(dir, 'vx.config.mjs')
      await writeFile(
        file,
        `export default { tasks: { dev: { exec: { command: 'vite', persistent: { readyWhen: 'Local:' } } } } }`,
      )
      const cfg = await loadProjectConfig(file)
      expect(cfg.tasks?.dev?.exec?.persistent?.readyWhen).toBe('Local:')
    })

    it('accepts empty persistent (ready immediately)', async () => {
      const file = path.join(dir, 'vx.config.mjs')
      await writeFile(
        file,
        `export default { tasks: { dev: { exec: { command: 'vite', persistent: {} } } } }`,
      )
      const cfg = await loadProjectConfig(file)
      expect(cfg.tasks?.dev?.exec?.persistent).toEqual({})
    })

    it('rejects cache + persistent (persistent tasks have no exit to cache)', async () => {
      const file = path.join(dir, 'vx.config.mjs')
      await writeFile(
        file,
        `export default { tasks: { dev: { exec: { command: 'vite', persistent: {} }, cache: { inputs: { files: [] }, outputs: { files: [] } } } } }`,
      )
      await expect(loadProjectConfig(file)).rejects.toThrow(
        /cache.*not allowed on a persistent task/,
      )
    })

    it('rejects non-string readyWhen', async () => {
      const file = path.join(dir, 'vx.config.mjs')
      await writeFile(
        file,
        `export default { tasks: { dev: { exec: { command: 'vite', persistent: { readyWhen: 42 } } } } }`,
      )
      await expect(loadProjectConfig(file)).rejects.toThrow(/readyWhen must be a string/)
    })

    it('rejects non-object persistent', async () => {
      const file = path.join(dir, 'vx.config.mjs')
      await writeFile(
        file,
        `export default { tasks: { dev: { exec: { command: 'vite', persistent: true } } } }`,
      )
      await expect(loadProjectConfig(file)).rejects.toThrow(/persistent must be an object/)
    })

    it('rejects cache on a group task (no exec)', async () => {
      const file = path.join(dir, 'vx.config.mjs')
      await writeFile(
        file,
        `export default { tasks: { g: {
          dependsOn: ['^build'],
          cache: { inputs: { files: ['**'] }, outputs: { files: [] } },
        } } }`,
      )
      await expect(loadProjectConfig(file)).rejects.toThrow(/`cache` requires `exec`/)
    })

    it('rejects wildcards in cache.inputs.env (no silent literal misinterpretation)', async () => {
      // Turbo expands `VERCEL_*` in env tracking; vx requires explicit
      // names so an unset wildcard doesn't silently become an empty
      // value in the cache key. Reject at load time with a clear
      // pointer to the workaround (list names individually).
      const file = path.join(dir, 'vx.config.mjs')
      await writeFile(
        file,
        `export default { tasks: { build: {
          exec: { command: 'tsc' },
          cache: { inputs: { files: ['src/**'], env: ['VERCEL_*'] }, outputs: { files: [] } },
        } } }`,
      )
      await expect(loadProjectConfig(file)).rejects.toThrow(/wildcards.*env names.*not supported/)
    })

    it('rejects non-string env entries in cache.inputs.env', async () => {
      const file = path.join(dir, 'vx.config.mjs')
      await writeFile(
        file,
        `export default { tasks: { build: {
          exec: { command: 'tsc' },
          cache: { inputs: { files: ['src/**'], env: [42] }, outputs: { files: [] } },
        } } }`,
      )
      await expect(loadProjectConfig(file)).rejects.toThrow(/env.*non-empty/)
    })

    it('rejects empty-string entries in cache.outputs.files', async () => {
      const file = path.join(dir, 'vx.config.mjs')
      await writeFile(
        file,
        `export default { tasks: { build: {
          exec: { command: 'tsc' },
          cache: { inputs: { files: ['src/**'] }, outputs: { files: [''] } },
        } } }`,
      )
      await expect(loadProjectConfig(file)).rejects.toThrow(/outputs.files.*non-empty/)
    })

    it('rejects absolute paths in cache.outputs.files (must be project-relative)', async () => {
      const file = path.join(dir, 'vx.config.mjs')
      await writeFile(
        file,
        `export default { tasks: { build: {
          exec: { command: 'tsc' },
          cache: { inputs: { files: ['src/**'] }, outputs: { files: ['/tmp/leak.js'] } },
        } } }`,
      )
      await expect(loadProjectConfig(file)).rejects.toThrow(/absolute paths are not allowed/)
    })

    // Two refusals for glob forms that currently select NOTHING and say so
    // nowhere. Both were reproduced end-to-end against the Turbo/Nx parity
    // research (docs/design/turbo-nx-parity-2026-07.md); both are refusals
    // rather than semantic changes, so no working config's cache key moves
    // and no CACHE_VERSION bump is owed — a config using either form was
    // already broken, just silently.

    it('rejects a cache.inputs.files list that is ONLY negations', async () => {
      // The sharpest of the six parity defects, and two independent research
      // passes reached it from different upstreams by different methods.
      // `resolveFiles` builds its set from the POSITIVE globs and uses `!`
      // entries only to subtract, so with no positive pattern it returns [] —
      // the task folds ZERO file inputs and its key stops moving with its
      // source. Every gitignore-trained reader parses this as "everything
      // except specs". Turbo makes it a hard config error for the same reason.
      const file = path.join(dir, 'vx.config.mjs')
      await writeFile(
        file,
        `export default { tasks: { build: {
          exec: { command: 'tsc' },
          cache: { inputs: { files: ['!**/*.spec.ts'] }, outputs: { files: ['dist/**'] } },
        } } }`,
      )
      await expect(loadProjectConfig(file)).rejects.toThrow(/every entry is a negation/)
      // The message has to carry the fix, because the reader's mental model is
      // the one that produced the bug.
      await expect(loadProjectConfig(file)).rejects.toThrow(/\*\*\/\*/)
    })

    it('accepts negations ALONGSIDE a positive glob — that form works', async () => {
      // The control. Negation is a supported and useful feature; only the
      // degenerate all-negations list selects nothing. Without this the
      // refusal above could have been implemented as "reject any negation"
      // and still passed.
      const file = path.join(dir, 'vx.config.mjs')
      await writeFile(
        file,
        `export default { tasks: { build: {
          exec: { command: 'tsc' },
          cache: {
            inputs: { files: ['src/**', '!**/*.spec.ts'] },
            outputs: { files: ['dist/**'] },
          },
        } } }`,
      )
      await expect(loadProjectConfig(file)).resolves.toBeDefined()
    })

    it('accepts an EMPTY cache.inputs.files list', async () => {
      // Empty is a different statement from all-negations: it declares no file
      // inputs at all, which is legitimate for a task keyed only on env or
      // upstream hashes. Refusing it would break working configs.
      const file = path.join(dir, 'vx.config.mjs')
      await writeFile(
        file,
        `export default { tasks: { build: {
          exec: { command: 'tsc' },
          cache: { inputs: { files: [] }, outputs: { files: ['dist/**'] } },
        } } }`,
      )
      await expect(loadProjectConfig(file)).resolves.toBeDefined()
    })

    it('rejects a negation in cache.outputs.files (unsupported, silently matches nothing)', async () => {
      // Asymmetric with inputs on purpose: `resolveOutputs` never splits on
      // '!', so the entry is read as a literal path beginning with '!' and
      // matches nothing at all. A user who writes it believes they excluded
      // something from the artifact; they excluded nothing and declared a
      // nonexistent output.
      const file = path.join(dir, 'vx.config.mjs')
      await writeFile(
        file,
        `export default { tasks: { build: {
          exec: { command: 'tsc' },
          cache: { inputs: { files: ['src/**'] }, outputs: { files: ['dist/**', '!dist/*.map'] } },
        } } }`,
      )
      await expect(loadProjectConfig(file)).rejects.toThrow(/negation is not supported/)
    })

    it('rejects a negation-only cache.inputs.workspaceFiles, and a negation in outputs.workspaceFiles', async () => {
      // The workspace-anchored namespace has the SAME split in both
      // directions — `resolveWorkspaceFiles` returns [] with no positive
      // glob, `resolveWorkspaceOutputs` never splits — so both rules apply
      // there too. Missing this pair would leave the documented escape hatch
      // carrying exactly the defect just closed on the project-relative one.
      const inputsOnly = path.join(dir, 'ws-in.mjs')
      await writeFile(
        inputsOnly,
        `export default { tasks: { build: {
          exec: { command: 'tsc' },
          cache: {
            inputs: { files: ['src/**'], workspaceFiles: ['!tsconfig.json'] },
            outputs: { files: ['dist/**'] },
          },
        } } }`,
      )
      await expect(loadProjectConfig(inputsOnly)).rejects.toThrow(/every entry is a negation/)

      const outNeg = path.join(dir, 'ws-out.mjs')
      await writeFile(
        outNeg,
        `export default { tasks: { build: {
          exec: { command: 'tsc' },
          cache: {
            inputs: { files: ['src/**'] },
            outputs: { files: ['dist/**'], workspaceFiles: ['!generated/x'] },
          },
        } } }`,
      )
      await expect(loadProjectConfig(outNeg)).rejects.toThrow(/negation is not supported/)
    })

    it('rejects non-string entries in cache.outputs.files', async () => {
      const file = path.join(dir, 'vx.config.mjs')
      await writeFile(
        file,
        `export default { tasks: { build: {
          exec: { command: 'tsc' },
          cache: { inputs: { files: ['src/**'] }, outputs: { files: [42] } },
        } } }`,
      )
      await expect(loadProjectConfig(file)).rejects.toThrow(/outputs.files.*non-empty/)
    })

    // A `..` output glob escapes the project dir; `cleanOutputs` rm()s resolved
    // output paths before every run, so an accepted `../victim/**` would delete
    // files OUTSIDE the project. Reject at load (the boundary is hard).
    it('rejects `..` path segments in cache.outputs.files (data-loss vector)', async () => {
      const file = path.join(dir, 'vx.config.mjs')
      await writeFile(
        file,
        `export default { tasks: { build: {
          exec: { command: 'tsc' },
          cache: { inputs: { files: ['src/**'] }, outputs: { files: ['../victim/**'] } },
        } } }`,
      )
      await expect(loadProjectConfig(file)).rejects.toThrow(/'\.\.' path segments are not allowed/)
    })

    it('rejects `..` path segments in cache.inputs.files', async () => {
      const file = path.join(dir, 'vx.config.mjs')
      await writeFile(
        file,
        `export default { tasks: { build: {
          exec: { command: 'tsc' },
          cache: { inputs: { files: ['../sibling/**'] }, outputs: { files: [] } },
        } } }`,
      )
      await expect(loadProjectConfig(file)).rejects.toThrow(/'\.\.' path segments are not allowed/)
    })

    // workspaceFiles are workspace-root-relative and deliberately boundary-free
    // WITHIN the workspace — but `..` escapes ABOVE the root (deletes outside
    // the repo). Reject it while still allowing cross-project workspace globs.
    it('rejects `..` in cache.outputs.workspaceFiles (escapes the workspace root)', async () => {
      const file = path.join(dir, 'vx.config.mjs')
      await writeFile(
        file,
        `export default { tasks: { build: {
          exec: { command: 'tsc' },
          cache: { inputs: { files: ['src/**'] }, outputs: { files: [], workspaceFiles: ['../above.txt'] } },
        } } }`,
      )
      await expect(loadProjectConfig(file)).rejects.toThrow(/'\.\.' path segments are not allowed/)
    })

    it('accepts a filename with dots (foo..bar is not a `..` segment)', async () => {
      // `foo..bar` is a valid filename (the `..` is not a path SEGMENT).
      const file = path.join(dir, 'vx.config.mjs')
      await writeFile(
        file,
        `export default { tasks: { build: {
          exec: { command: 'tsc' },
          cache: { inputs: { files: ['src/a..b.ts'] }, outputs: { files: [] } },
        } } }`,
      )
      await expect(loadProjectConfig(file)).resolves.toBeDefined()
    })

    // exec.env was never validated: a malformed passThrough reaches
    // buildIsolatedEnv's `for (const name of passThrough)` — a number throws
    // "not iterable" mid-run, a string silently char-iterates. Fail loud at load.
    it('rejects a non-array exec.env.passThrough', async () => {
      const file = path.join(dir, 'vx.config.mjs')
      await writeFile(
        file,
        `export default { tasks: { build: {
          exec: { command: 'tsc', env: { passThrough: 123 } },
        } } }`,
      )
      await expect(loadProjectConfig(file)).rejects.toThrow(/passThrough must be an array/)
    })

    it('rejects a string exec.env.passThrough (would silently char-iterate)', async () => {
      const file = path.join(dir, 'vx.config.mjs')
      await writeFile(
        file,
        `export default { tasks: { build: {
          exec: { command: 'tsc', env: { passThrough: 'FOO' } },
        } } }`,
      )
      await expect(loadProjectConfig(file)).rejects.toThrow(/passThrough must be an array/)
    })

    it('rejects a non-object exec.env.define', async () => {
      const file = path.join(dir, 'vx.config.mjs')
      await writeFile(
        file,
        `export default { tasks: { build: {
          exec: { command: 'tsc', env: { define: { PORT: 3000 } } },
        } } }`,
      )
      await expect(loadProjectConfig(file)).rejects.toThrow(/define\.PORT must be a string/)
    })

    it('accepts a well-formed exec.env', async () => {
      const file = path.join(dir, 'vx.config.mjs')
      await writeFile(
        file,
        `export default { tasks: { build: {
          exec: { command: 'tsc', env: { passThrough: ['CI', 'HOME'], define: { NODE_ENV: 'production' } } },
        } } }`,
      )
      await expect(loadProjectConfig(file)).resolves.toBeDefined()
    })

    it('rejects absolute paths in cache.inputs.files (must be project-relative)', async () => {
      const file = path.join(dir, 'vx.config.mjs')
      await writeFile(
        file,
        `export default { tasks: { build: {
          exec: { command: 'tsc' },
          cache: { inputs: { files: ['/etc/passwd'] }, outputs: { files: [] } },
        } } }`,
      )
      await expect(loadProjectConfig(file)).rejects.toThrow(/absolute paths are not allowed/)
    })

    it('rejects empty-string entries in cache.inputs.files', async () => {
      const file = path.join(dir, 'vx.config.mjs')
      await writeFile(
        file,
        `export default { tasks: { build: {
          exec: { command: 'tsc' },
          cache: { inputs: { files: [''] }, outputs: { files: [] } },
        } } }`,
      )
      await expect(loadProjectConfig(file)).rejects.toThrow(/inputs.files.*non-empty/)
    })

    it('accepts cache.inputs.runtime and workspaceRuntime as string arrays', async () => {
      const file = path.join(dir, 'vx.config.mjs')
      await writeFile(
        file,
        `export default { tasks: { build: {
          exec: { command: 'echo hi' },
          cache: {
            inputs: { files: ['src/**'], runtime: ['node -v'], workspaceRuntime: ['uname -s'] },
            outputs: { files: [] },
          },
        } } }`,
      )
      const cfg = await loadProjectConfig(file)
      expect(cfg.tasks?.build?.cache?.inputs.runtime).toEqual(['node -v'])
      expect(cfg.tasks?.build?.cache?.inputs.workspaceRuntime).toEqual(['uname -s'])
    })

    it('rejects non-string runtime entries', async () => {
      const file = path.join(dir, 'vx.config.mjs')
      await writeFile(
        file,
        `export default { tasks: { build: {
          exec: { command: 'x' },
          cache: { inputs: { files: [], runtime: [123] }, outputs: { files: [] } },
        } } }`,
      )
      await expect(loadProjectConfig(file)).rejects.toThrow(
        /cache\.inputs\.runtime must be an array of non-empty shell command strings/,
      )
    })

    it('rejects empty-string workspaceRuntime entries', async () => {
      const file = path.join(dir, 'vx.config.mjs')
      await writeFile(
        file,
        `export default { tasks: { build: {
          exec: { command: 'x' },
          cache: { inputs: { files: [], workspaceRuntime: [''] }, outputs: { files: [] } },
        } } }`,
      )
      await expect(loadProjectConfig(file)).rejects.toThrow(
        /cache\.inputs\.workspaceRuntime must be an array of non-empty shell command strings/,
      )
    })
  })

  describe('exec.resources validation', () => {
    const withResources = (literal: string) =>
      `export default { tasks: { build: { exec: { command: 'tsc', resources: ${literal} } } } }`

    it('accepts cores, megabytes, an image, and fractional cpus', async () => {
      for (const literal of [
        `{ cpus: 2 }`,
        `{ cpus: 0.5 }`,
        `{ memory: 1024 }`,
        `{ image: 'vx-playwright' }`,
        `{ cpus: 2, memory: 4096, image: 'vx-playwright' }`,
        `{}`,
      ]) {
        const file = path.join(dir, 'vx.config.mjs')
        await writeFile(file, withResources(literal))
        const cfg = await loadProjectConfig(file)
        expect(cfg.tasks?.build?.exec?.resources).toBeDefined()
      }
    })

    it('rejects invalid cpus forms', async () => {
      // Percent forms went with the 2026-08-30 units change: a percentage
      // names a fraction of THIS run's budget, and an executor placing the
      // task on another machine has no way to mean anything by it.
      for (const literal of [
        `{ cpus: -1 }`,
        `{ cpus: NaN }`,
        `{ cpus: '50%' }`,
        `{ cpus: '2GB' }`,
      ]) {
        const file = path.join(dir, 'vx.config.mjs')
        await writeFile(file, withResources(literal))
        await expect(loadProjectConfig(file)).rejects.toThrow(
          /resources\.cpus must be a non-negative number of CPU cores/,
        )
      }
    })

    it('rejects invalid memory forms', async () => {
      // A size STRING is rejected too, deliberately: the unit is megabytes,
      // and silently accepting '512MB' beside `memory: 512` would give two
      // spellings that differ by a factor of a million.
      for (const literal of [
        `{ memory: -1 }`,
        `{ memory: 1.5 }`,
        `{ memory: '512MB' }`,
        `{ memory: '25%' }`,
      ]) {
        const file = path.join(dir, 'vx.config.mjs')
        await writeFile(file, withResources(literal))
        await expect(loadProjectConfig(file)).rejects.toThrow(
          /resources\.memory must be a non-negative integer number of megabytes/,
        )
      }
    })

    it('rejects an empty or non-string image', async () => {
      for (const literal of [`{ image: '' }`, `{ image: 7 }`]) {
        const file = path.join(dir, 'vx.config.mjs')
        await writeFile(file, withResources(literal))
        await expect(loadProjectConfig(file)).rejects.toThrow(
          /resources\.image must be a non-empty/,
        )
      }
    })

    it('rejects unknown fields (future axes must be added deliberately)', async () => {
      const file = path.join(dir, 'vx.config.mjs')
      await writeFile(file, withResources(`{ gpu: 1 }`))
      await expect(loadProjectConfig(file)).rejects.toThrow(/unknown field "gpu"/)
    })

    it('rejects a non-object resources', async () => {
      const file = path.join(dir, 'vx.config.mjs')
      await writeFile(file, withResources(`4`))
      await expect(loadProjectConfig(file)).rejects.toThrow(/resources must be an object/)
    })
  })

  // A typo'd field was silently DROPPED, so the task hashed as if it had
  // never been written — for a cache-key field that is a stale hit, not a
  // config mistake. Every level that feeds the key now rejects unknown
  // keys, the way `exec.resources` and `sandbox` already did.
  describe('unknown fields', () => {
    const cfg = (task: string): string => `export default { tasks: { build: ${task} } }`

    it('rejects a typo in a cache-key input field', async () => {
      const file = path.join(dir, 'vx.config.mjs')
      await writeFile(
        file,
        cfg(`{
          exec: { command: 'true' },
          cache: {
            inputs: { files: ['src/**'], workspaceFile: ['../shared.txt'] },
            outputs: { files: [] },
          },
        }`),
      )
      await expect(loadProjectConfig(file)).rejects.toThrow(
        /cache\.inputs has unknown field "workspaceFile"/,
      )
    })

    it('rejects unknown keys at the task level', async () => {
      const file = path.join(dir, 'vx.config.mjs')
      await writeFile(file, cfg(`{ exec: { command: 'true' }, dependOn: ['lint'] }`))
      await expect(loadProjectConfig(file)).rejects.toThrow(/unknown field "dependOn"/)
    })

    it('rejects unknown keys at the exec level', async () => {
      const file = path.join(dir, 'vx.config.mjs')
      await writeFile(file, cfg(`{ exec: { command: 'true', timeoutMs: 500 } }`))
      await expect(loadProjectConfig(file)).rejects.toThrow(/exec has unknown field "timeoutMs"/)
    })

    it('rejects a misspelled persistent', async () => {
      const file = path.join(dir, 'vx.config.mjs')
      await writeFile(file, cfg(`{ exec: { command: 'true', persistant: {} } }`))
      await expect(loadProjectConfig(file)).rejects.toThrow(/exec has unknown field "persistant"/)
    })

    it('refuses the REMOVED backend capability by name instead of ignoring it', async () => {
      // The whole-run backend seam went with vx cloud on 2026-08-23, but it
      // stayed in the capability list — so a plugin declaring only
      // `backend` (a third-party one written against the old API) counted
      // as "contributes a capability" and was then silently ignored. A
      // no-op plugin that validates is exactly what this check exists to
      // prevent.
      const file = path.join(dir, 'vx.workspace.mjs')
      await writeFile(
        file,
        `export default { plugins: [{ name: 'org/old', backend() { return {} } }] }\n`,
      )
      await expect(loadWorkspaceConfig(dir)).rejects.toThrow(
        /backend` is no longer a capability[\s\S]*Use `executor`/,
      )
    })

    it('CONTROL: the surviving capabilities still load', async () => {
      const file = path.join(dir, 'vx.workspace.mjs')
      await writeFile(
        file,
        `export default { plugins: [
           { name: 'org/c', cache() { return undefined } },
           { name: 'org/e', executor() { return undefined } },
           { name: 'org/t', telemetry() { return undefined } },
         ] }\n`,
      )
      await expect(loadWorkspaceConfig(dir)).resolves.toBeDefined()
    })

    it('rejects a typo INSIDE persistent, one level below the sibling checks', async () => {
      // `persistant` (the level above) was already caught; `readWhen` was
      // not, and it is the quieter failure: `readyWhen` stays undefined, so
      // the task reports ready the moment it spawns rather than when its
      // server listens, and the dependents that start too early fail in a
      // way that points at the user's code instead of their config.
      const file = path.join(dir, 'vx.config.mjs')
      await writeFile(file, cfg(`{ exec: { command: 'true', persistent: { readWhen: 'up' } } }`))
      await expect(loadProjectConfig(file)).rejects.toThrow(
        /exec\.persistent has unknown field "readWhen"/,
      )
    })

    it('CONTROL: valid persistent shapes still load', async () => {
      // A refusal that breaks a working config is worse than the typo it
      // catches, so both legal shapes are pinned alongside it.
      const file = path.join(dir, 'vx.config.mjs')
      await writeFile(file, cfg(`{ exec: { command: 'true', persistent: { readyWhen: 'up' } } }`))
      await expect(loadProjectConfig(file)).resolves.toBeDefined()
      await writeFile(file, cfg(`{ exec: { command: 'true', persistent: {} } }`))
      await expect(loadProjectConfig(file)).resolves.toBeDefined()
    })

    it('rejects unknown keys at the cache level', async () => {
      const file = path.join(dir, 'vx.config.mjs')
      await writeFile(
        file,
        cfg(`{
          exec: { command: 'true' },
          cache: { inputs: { files: [] }, outputs: { files: [] }, caches: true },
        }`),
      )
      await expect(loadProjectConfig(file)).rejects.toThrow(/cache has unknown field "caches"/)
    })

    it('rejects unknown keys at the cache.outputs level', async () => {
      const file = path.join(dir, 'vx.config.mjs')
      await writeFile(
        file,
        cfg(`{
          exec: { command: 'true' },
          cache: { inputs: { files: [] }, outputs: { files: [], dirs: ['dist'] } },
        }`),
      )
      await expect(loadProjectConfig(file)).rejects.toThrow(
        /cache\.outputs has unknown field "dirs"/,
      )
    })

    it('rejects a tasks ARRAY (Object.entries would name the task "0")', async () => {
      const file = path.join(dir, 'vx.config.mjs')
      await writeFile(file, `export default { tasks: [{ exec: { command: 'true' } }] }`)
      await expect(loadProjectConfig(file)).rejects.toThrow(
        /`tasks` must be an object keyed by task name/,
      )
    })

    it('still accepts every declared field', async () => {
      const file = path.join(dir, 'vx.config.mjs')
      await writeFile(
        file,
        cfg(`{
          description: 'build it',
          dependsOn: ['^build'],
          exec: {
            command: 'true',
            timeout: 1000,
            retries: 1,
            resources: { cpus: 1, memory: 1024, image: 'vx-toolchain' },
            env: { passThrough: ['CI'], define: { A: 'b' } },
          },
          sandbox: { allow: { read: ['../shared'], network: ['registry.npmjs.org'] } },
          cache: {
            inputs: {
              files: ['src/**'],
              workspaceFiles: ['shared/**'],
              env: ['NODE_ENV'],
              tasks: ['^build'],
              runtime: ['node -v'],
              workspaceRuntime: ['uname -sm'],
            },
            outputs: { files: ['dist/**'], workspaceFiles: ['generated/**'] },
          },
        }`),
      )
      await expect(loadProjectConfig(file)).resolves.toBeDefined()
    })
  })

  // The one CacheInputs field with no shape check: a non-string entry
  // crashed deep in filterUpstreamHashes / parseDependencySpec with a raw
  // TypeError that named neither the task nor the config.
  describe('cache.inputs.tasks', () => {
    const withTasks = (literal: string): string =>
      `export default { tasks: { build: { exec: { command: 'true' }, cache: {
        inputs: { files: [], tasks: ${literal} }, outputs: { files: [] } } } } }`

    it('rejects a bare string instead of a list', async () => {
      const file = path.join(dir, 'vx.config.mjs')
      await writeFile(file, withTasks(`'^build'`))
      await expect(loadProjectConfig(file)).rejects.toThrow(
        /cache\.inputs\.tasks must be an array of non-empty strings/,
      )
    })

    it('rejects null', async () => {
      const file = path.join(dir, 'vx.config.mjs')
      await writeFile(file, withTasks(`null`))
      await expect(loadProjectConfig(file)).rejects.toThrow(
        /cache\.inputs\.tasks must be an array of non-empty strings/,
      )
    })

    it('rejects non-string / empty entries', async () => {
      for (const literal of [`[42]`, `['']`, `['build', null]`]) {
        const file = path.join(dir, 'vx.config.mjs')
        await writeFile(file, withTasks(literal))
        await expect(loadProjectConfig(file)).rejects.toThrow(
          /cache\.inputs\.tasks must be an array of non-empty strings/,
        )
      }
    })

    it('accepts the documented filter forms', async () => {
      const file = path.join(dir, 'vx.config.mjs')
      await writeFile(file, withTasks(`['*', '^*', 'lint', '^build', 'pkg#gen', '!^noisy']`))
      await expect(loadProjectConfig(file)).resolves.toBeDefined()
    })

    it('accepts an empty list (fully decoupled)', async () => {
      const file = path.join(dir, 'vx.config.mjs')
      await writeFile(file, withTasks(`[]`))
      await expect(loadProjectConfig(file)).resolves.toBeDefined()
    })
  })
})

describe('loadWorkspaceConfig', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'vx-ws-loader-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('returns null when no vx.workspace.* file exists', async () => {
    expect(await loadWorkspaceConfig(dir)).toBeNull()
  })

  it('loads a default-exported object from vx.workspace.mjs', async () => {
    await writeFile(
      path.join(dir, 'vx.workspace.mjs'),
      'export default { concurrency: 4, cacheDir: "build/.vx-cache" }',
    )
    const cfg = await loadWorkspaceConfig(dir)
    expect(cfg).toEqual({ concurrency: 4, cacheDir: 'build/.vx-cache' })
  })

  it('throws when concurrency is non-positive or non-integer', async () => {
    await writeFile(path.join(dir, 'vx.workspace.mjs'), 'export default { concurrency: 0 }')
    await expect(loadWorkspaceConfig(dir)).rejects.toThrow(/positive integer/)
  })

  it('throws when concurrency is a non-number', async () => {
    await writeFile(path.join(dir, 'vx.workspace.mjs'), 'export default { concurrency: "8" }')
    await expect(loadWorkspaceConfig(dir)).rejects.toThrow(/positive integer/)
  })

  it('throws when cacheDir is not a string', async () => {
    await writeFile(path.join(dir, 'vx.workspace.mjs'), 'export default { cacheDir: 7 }')
    await expect(loadWorkspaceConfig(dir)).rejects.toThrow(/must be a string/)
  })

  it('throws when the file does not export a default object', async () => {
    await writeFile(path.join(dir, 'vx.workspace.mjs'), 'export const x = 1')
    await expect(loadWorkspaceConfig(dir)).rejects.toThrow(/did not export a default object/)
  })
})
