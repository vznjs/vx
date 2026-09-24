import os from 'node:os'
import path from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { describe, expect, it } from 'bun:test'
import { buildIsolatedEnv } from '../src/exec/env.js'
import { resolveInputs } from '../src/cache/index.js'
import { run } from '../src/orchestrator/index.js'
import { addProject, makeWorkspace } from './helpers/workspace.js'

describe('buildIsolatedEnv', () => {
  it('passes essential allowlist values from source', () => {
    const env = buildIsolatedEnv({
      passThrough: [],
      define: {},
      source: { PATH: '/usr/bin', HOME: '/root', SECRET: 'leak' },
    })
    expect(env.PATH).toBe('/usr/bin')
    expect(env.HOME).toBe('/root')
    expect(env.SECRET).toBeUndefined()
  })

  it('omits essentials that are not set in source', () => {
    const env = buildIsolatedEnv({
      passThrough: [],
      define: {},
      source: {},
    })
    expect(env.PATH).toBeUndefined()
  })

  // Item 652: the row above cannot tell an absent PATH from a PATH key
  // holding `undefined` — and the env is handed to every executor plugin,
  // where `Object.entries` sees the second. The exact key set can.
  it('an essential unset in source is no key at all, not one holding undefined', () => {
    expect(Object.keys(buildIsolatedEnv({ passThrough: [], define: {}, source: {} }))).toEqual([])
    // CONTROL: one that IS set is the one key there.
    expect(
      Object.keys(buildIsolatedEnv({ passThrough: [], define: {}, source: { HOME: '/h' } })),
    ).toEqual(['HOME'])
  })

  it('forwards passThrough values from source', () => {
    const env = buildIsolatedEnv({
      passThrough: ['AWS_REGION'],
      define: {},
      source: { AWS_REGION: 'us-east-1', OTHER: 'leak' },
    })
    expect(env.AWS_REGION).toBe('us-east-1')
    expect(env.OTHER).toBeUndefined()
  })

  it('does not include passThrough vars that are unset in source', () => {
    const env = buildIsolatedEnv({
      passThrough: ['MISSING'],
      define: {},
      source: {},
    })
    expect('MISSING' in env).toBe(false)
  })

  it('applies define values', () => {
    const env = buildIsolatedEnv({
      passThrough: [],
      define: { NODE_ENV: 'production' },
      source: {},
    })
    expect(env.NODE_ENV).toBe('production')
  })

  it('define overrides passThrough values', () => {
    const env = buildIsolatedEnv({
      passThrough: ['NODE_ENV'],
      define: { NODE_ENV: 'production' },
      source: { NODE_ENV: 'development' },
    })
    expect(env.NODE_ENV).toBe('production')
  })

  it('define overrides essential allowlist values', () => {
    const env = buildIsolatedEnv({
      passThrough: [],
      define: { PATH: '/custom/bin' },
      source: { PATH: '/usr/bin' },
    })
    expect(env.PATH).toBe('/custom/bin')
  })

  it('prepends binPaths onto PATH (highest priority first)', () => {
    const env = buildIsolatedEnv({
      passThrough: [],
      define: {},
      source: { PATH: '/usr/bin' },
      binPaths: ['/proj/node_modules/.bin'],
    })
    expect(env.PATH).toBe(`/proj/node_modules/.bin${path.delimiter}/usr/bin`)
  })

  it('binPaths becomes PATH when source has no PATH', () => {
    const env = buildIsolatedEnv({
      passThrough: [],
      define: {},
      source: {},
      binPaths: ['/proj/node_modules/.bin'],
    })
    expect(env.PATH).toBe('/proj/node_modules/.bin')
  })

  // Item 652: an empty list joins to '', and prepending '' puts an EMPTY
  // entry first on PATH — which a shell reads as the current directory, so
  // a `tsc` in the task's cwd would shadow the real one.
  it('an empty binPaths leaves PATH exactly as it was — no empty first entry', () => {
    const env = buildIsolatedEnv({
      passThrough: [],
      define: {},
      source: { PATH: '/usr/bin' },
      binPaths: [],
    })
    expect(env.PATH).toBe('/usr/bin')
  })

  it('binPaths prepend even after define overrides PATH', () => {
    const env = buildIsolatedEnv({
      passThrough: [],
      define: { PATH: '/custom/bin' },
      source: { PATH: '/usr/bin' },
      binPaths: ['/proj/node_modules/.bin'],
    })
    expect(env.PATH).toBe(`/proj/node_modules/.bin${path.delimiter}/custom/bin`)
  })
})

// The essentials are forwarded to every child and folded into NO cache key.
// That is deliberate — hashing them would mean a laptop and a CI runner can
// never share a remote cache entry, since PATH/HOME/TERM differ on every
// machine — but three of them can change what a task PRODUCES, so the
// asymmetry has to be pinned rather than assumed.
//
// vx's answer is the explicit one, consistent with how it refuses to infer
// inputs anywhere else: a build whose output depends on one of these declares
// it in `cache.inputs.env`. These tests exist so that decision cannot be
// reversed silently in either direction — folding an essential into the key
// would destroy cross-machine sharing, and dropping one from the allowlist
// would break tools that need it.
describe('essential env vars are forwarded but NEVER hashed', () => {
  it('changing NODE_OPTIONS moves NOTHING in the key unless it is declared', async () => {
    // The sharpest case, and the reason this is documented rather than
    // guessed at: `--require` injects code into every node process, so these
    // two runs genuinely produce different artifacts. vx does not see that,
    // by design — it sees only what the config declared.
    //
    // Driven through `resolveInputs`, which is where the decision actually
    // lives. Asserting on `cache.key()` alone would be VACUOUS: `key()` takes
    // `envValues` as an argument and never reads `process.env`, so two calls
    // with the same arguments are equal whatever the essentials do.
    const dir = await mkdtemp(path.join(os.tmpdir(), 'vx-essential-key-'))
    try {
      Bun.spawnSync(['git', 'init', '-q'], { cwd: dir })
      await Bun.write(path.join(dir, 'src', 'a.ts'), 'x')
      const base = {
        projectDir: dir,
        workspaceRoot: dir,
        ownOutputs: [],
        nestedProjectDirs: [],
      }
      const undeclared = { files: ['src/**'] }

      const a = await resolveInputs({
        ...base,
        inputs: undeclared,
        envSource: { NODE_OPTIONS: '-r ./instrument.js' },
      })
      const b = await resolveInputs({
        ...base,
        inputs: undeclared,
        envSource: { NODE_OPTIONS: '--conditions=production' },
      })
      expect(a.envValues).toEqual([])
      expect(b.envValues).toEqual(a.envValues)

      // The escape hatch the docs point at has to actually work, or the
      // advice is empty: declaring it makes the value part of the key.
      const declared = await resolveInputs({
        ...base,
        inputs: { files: ['src/**'], env: ['NODE_OPTIONS'] },
        envSource: { NODE_OPTIONS: '-r ./instrument.js' },
      })
      expect(declared.envValues).toEqual([['NODE_OPTIONS', '-r ./instrument.js']])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('every var that can change a task\u2019s OUTPUT is forwarded, and named in the docs', () => {
    // Forwarding is the half that must not regress: dropping NODE_OPTIONS
    // would break a CI that raises the heap, and dropping LC_ALL would change
    // collation for anything shelling out to `sort`. The docs name exactly
    // these three groups as the hazard, so the code and the prose are pinned
    // to the same list.
    const source = {
      NODE_OPTIONS: '--max-old-space-size=8192',
      LC_ALL: 'C',
      LANG: 'en_US.UTF-8',
      CI: 'true',
      FORCE_COLOR: '1',
      TERM: 'xterm-256color',
    }
    const env = buildIsolatedEnv({ passThrough: [], define: {}, source })
    for (const [name, value] of Object.entries(source)) {
      expect({ name, value: env[name] }).toEqual({ name, value })
    }
  })

  it('an unrelated host var is NOT forwarded \u2014 the allowlist is a real boundary', () => {
    // The control. If everything leaked through, "not hashed" would be a
    // determinism disaster rather than a considered trade.
    const env = buildIsolatedEnv({
      passThrough: [],
      define: {},
      source: { PS1: '\\u@\\h', AWS_SECRET_ACCESS_KEY: 'shh', PATH: '/usr/bin' },
    })
    expect(env.PS1).toBeUndefined()
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined()
    expect(env.PATH).toBe('/usr/bin')
  })
})

// turborepo#8802, #10353: strict env mode dropped TMPDIR / TMP / TEMP, so a
// task's temp files landed somewhere the host never pointed it, and a
// variable the task set for its own children was filtered too.
describe('what a task sees of the temp directory, end to end', () => {
  it('TMPDIR, TMP and TEMP reach the task unchanged, and what the task exports reaches its children', async () => {
    const root = await makeWorkspace({ prefix: 'vx-env-tmp-' })
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'vx-env-tmp-host-'))
    const saved = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP }
    try {
      const dir = await addProject(root, 'app', {
        config: `
          export default {
            tasks: {
              probe: {
                exec: {
                  command: "node -e 'const os = require(\\"os\\"); process.stdout.write(JSON.stringify([os.tmpdir(), process.env.TMP, process.env.TEMP]))' > seen.json && export INNER=set-by-task && sh -c 'printf %s \\"$INNER\\"' > inner.txt",
                },
              },
            },
          }
        `,
      })
      process.env.TMPDIR = tmp
      process.env.TMP = `${tmp}/tmp`
      process.env.TEMP = `${tmp}/temp`
      const quiet = { status() {}, taskStdout() {}, taskStderr() {}, taskComplete() {} }
      const r = await run({ cwd: root, tasks: ['probe'], log: quiet })
      expect(r.ok).toBe(true)
      expect(JSON.parse(await Bun.file(path.join(dir, 'seen.json')).text())).toEqual([
        tmp,
        `${tmp}/tmp`,
        `${tmp}/temp`,
      ])
      expect(await Bun.file(path.join(dir, 'inner.txt')).text()).toBe('set-by-task')
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
      await rm(root, { recursive: true, force: true })
      await rm(tmp, { recursive: true, force: true })
    }
  })
})
