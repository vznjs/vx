// The Worker that re-evaluates a config's whole IMPORT CLOSURE.
//
// `tests/config-staleness.test.ts` covers this from ABOVE — through
// `loadProjectConfig`, where the first/repeat split lives. This file drives
// `evaluateConfigFresh` DIRECTLY, because the worker is a boundary and every
// boundary property it claims is load-bearing somewhere else:
//
//   * the config crosses as JSON, and `hashTaskConfig` derives the cache key
//     from `JSON.stringify(config)` — so any byte the hop adds, drops or
//     reorders silently changes every cache key (the argument for landing this
//     mechanism with NO CACHE_VERSION bump);
//   * `exec.command` is handed to a shell, so a mangled string runs a
//     DIFFERENT command;
//   * a non-object default must come back as `null` rather than throwing,
//     because the caller owns that error text so it reads identically
//     whichever path produced it;
//   * nothing may leave a caller awaiting forever — `vx watch` has no
//     run-level timeout, so an unsettled await is a permanent hang.
//
// Two defects are pinned here rather than fixed (see the comments at each):
// a rejected evaluation leaves its deadline timer armed, and a deliberately
// huge `VX_CONFIG_WORKER_TIMEOUT_MS` becomes an INSTANT deadline.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  beginEvalRound,
  configEvalWorkerCount,
  evaluateConfigFresh,
} from '../src/workspace/config-eval.js'
import { loadProjectConfig, loadWorkspaceConfig } from '../src/workspace/project-loader.js'
import type { ProjectConfig } from '../src/config.js'

const BUDGET_ENV = 'VX_CONFIG_WORKER_TIMEOUT_MS'

let root: string
let seq = 0
let savedBudget: string | undefined

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vx-config-eval-'))
  savedBudget = process.env[BUDGET_ENV]
})

afterEach(async () => {
  // A leaked budget would change every later config load in this process —
  // `bun test` runs the whole suite in ONE process.
  if (savedBudget === undefined) delete process.env[BUDGET_ENV]
  else process.env[BUDGET_ENV] = savedBudget
  await rm(root, { recursive: true, force: true })
})

/** Write a uniquely-named config module and return its absolute path. */
async function write(body: string): Promise<string> {
  const file = path.join(root, `cfg.${seq++}.mjs`)
  await writeFile(file, body)
  return file
}

/** Settle to a plain string so a hang shows up as a comparison, never a throw. */
async function settle(p: Promise<unknown>): Promise<string> {
  return await p.then(
    (v) => `RESOLVED ${JSON.stringify(v)}`,
    (e: unknown) => `REJECTED ${(e as Error).message}`,
  )
}

/**
 * A wedged worker must never outlast the call — assert against a ceiling so a
 * regression reports "HUNG" instead of running out the file's test timeout with
 * no clue which await never settled.
 */
async function settleOrHang(p: Promise<unknown>, ceilingMs: number): Promise<string> {
  return await Promise.race([settle(p), Bun.sleep(ceilingMs).then(() => 'HUNG')])
}

describe('evaluateConfigFresh: what crosses back', () => {
  it('returns the default export, JSON round-tripped', async () => {
    const file = await write(
      `export default { tasks: { build: { exec: { command: 'echo hi' }, dependsOn: ['^build'] } } }\n`,
    )
    expect(await evaluateConfigFresh(file)).toEqual({
      tasks: { build: { exec: { command: 'echo hi' }, dependsOn: ['^build'] } },
    })
  })

  // The contract is `null`, NOT a throw: `loadProjectConfig` runs
  // `assertDefaultObject` on whatever it gets, so both load paths produce the
  // one "did not export a default object" message. A guard that let any of
  // these through as a VALUE would hand the loader a number/function to
  // validate — and a function passes `!mod`, so `export default defineProject`
  // (a real authoring slip) would need a second rejection site.
  const NON_OBJECTS: ReadonlyArray<readonly [string, string]> = [
    ['a number', 'export default 42\n'],
    ['a string', 'export default "echo hi"\n'],
    ['a boolean', 'export default true\n'],
    ['null', 'export default null\n'],
    ['undefined', 'export default undefined\n'],
    ['no default export at all', 'export const tasks = {}\n'],
  ]

  for (const [label, body] of NON_OBJECTS) {
    it(`answers null when the config default-exports ${label}`, async () => {
      expect(await evaluateConfigFresh(await write(body))).toBeNull()
    })
  }

  it('answers a function, not null, when the config default-exports one (D-110)', async () => {
    // So the loader's refusal says it is a function, as the in-process path's does.
    expect(
      typeof (await evaluateConfigFresh(
        await write('export default function defineProject() {}\n'),
      )),
    ).toBe('function')
  })

  it('passes an array default export through instead of judging it', async () => {
    // Deliberately NOT null: `typeof [] === 'object'`, so the in-process path
    // hands the loader an array too. Whether an array is a valid config is the
    // loader's call; this layer diverging would make the two paths disagree.
    expect(await evaluateConfigFresh(await write('export default [1, {a: 2}]\n'))).toEqual([
      1,
      { a: 2 },
    ])
  })

  it('preserves exotic command strings byte-for-byte', async () => {
    // `exec.command` is executed by a shell. A byte lost or re-encoded at the
    // JSON hop runs a DIFFERENT command than the one on disk — and, because
    // the resolved config feeds the cache key, caches the result under a key
    // derived from text nobody wrote.
    const exotic = {
      emoji: 'echo "🚀 ünïcødé 中文"',
      newline: 'echo a\necho b',
      quotes: `echo "it's \\"quoted\\""`,
      backslash: 'echo C:\\path\\to',
      nul: 'echo a\u0000b',
      loneSurrogate: 'lone\ud800surrogate',
      tab: 'a\tb',
    }
    const file = await write(`export default ${JSON.stringify(exotic)}\n`)
    expect(await evaluateConfigFresh(file)).toEqual(exotic)
  })

  it('preserves key order, which is what keeps the hop hash-neutral', async () => {
    // `hashTaskConfig` hashes `JSON.stringify(config)`, and JSON.stringify
    // emits keys in insertion order — so a worker that rebuilt the object with
    // sorted (or otherwise reordered) keys would change EVERY cache key of
    // every repeat load while every value still compared equal.
    const file = await write(`export default { z: 1, a: 2, m: 3, nested: { y: 1, b: 2 } }\n`)
    expect(JSON.stringify(await evaluateConfigFresh(file))).toBe(
      '{"z":1,"a":2,"m":3,"nested":{"y":1,"b":2}}',
    )
  })

  it('resolves a relative config path before handing it to the worker', async () => {
    // The worker is an inline `data:` URL, which has no base to resolve a
    // relative specifier against — so without the `path.resolve` this rejects
    // with "Cannot find module". Callers reach here via discovery paths that
    // are usually absolute; "usually" is not a contract.
    const abs = await write(`export default { tasks: { a: { exec: { command: 'x' } } } }\n`)
    const rel = path.relative(process.cwd(), abs)
    expect(path.isAbsolute(rel)).toBe(false)
    expect(await evaluateConfigFresh(rel)).toEqual({ tasks: { a: { exec: { command: 'x' } } } })
  })

  it('…and a relative path that does NOT climb to the root reaches the same file', async () => {
    // The row above builds its path with `path.relative` from the test's
    // cwd to a temp dir, which comes out as `../../../../tmp/…`. Posted
    // to the worker WITHOUT `path.resolve`, that shape still lands on the
    // right file: the worker's base is the inline `data:` URL, one
    // segment deep, so four `..` climb past it to `/` and the rest of the
    // path reads correctly from there. The row therefore passes with the
    // resolve deleted — it states the contract its comment names and
    // cannot witness it.
    //
    // A path with no `..` in it is the shape that separates them. Here
    // the process cwd IS the fixture root for the length of the call, so
    // `./cfg.N.mjs` has nowhere to climb from and resolves against
    // `data:text/javascript,%0Ase…` instead, failing with a path the user
    // never typed. `process.chdir` is process-wide, so it is restored in
    // a `finally`; bun runs the tests in a file, and the files in a
    // shard, one after another, so nothing else is mid-await while it is
    // in effect.
    const abs = await write(`export default { tasks: { b: { exec: { command: 'y' } } } }\n`)
    const cwd = process.cwd()
    try {
      process.chdir(path.dirname(abs))
      const dotted = `./${path.basename(abs)}`
      expect(dotted.includes('..')).toBe(false)
      expect(await evaluateConfigFresh(dotted)).toEqual({
        tasks: { b: { exec: { command: 'y' } } },
      })
    } finally {
      process.chdir(cwd)
    }
  })
})

describe('evaluateConfigFresh: import-closure freshness', () => {
  it('observes a preset edited since the last evaluation', async () => {
    // The bug this whole mechanism exists for. Only the PRESET changes — the
    // config's own bytes are untouched, which is exactly what the loader's
    // content-hash bust cannot see, because Bun keys an evaluated module on
    // its RESOLVED specifier and `./preset.mjs` resolves the same every time.
    const preset = path.join(root, 'preset.mjs')
    await writeFile(preset, `export const COMMAND = 'echo v1'\n`)
    const config = await write(
      `import { COMMAND } from './preset.mjs'\n` +
        `export default { tasks: { build: { exec: { command: COMMAND } } } }\n`,
    )

    expect(await evaluateConfigFresh(config)).toEqual({
      tasks: { build: { exec: { command: 'echo v1' } } },
    })

    await writeFile(preset, `export const COMMAND = 'echo v2'\n`)

    expect(await evaluateConfigFresh(config)).toEqual({
      tasks: { build: { exec: { command: 'echo v2' } } },
    })
  })

  it('evaluates a shared preset ONCE per round, and again in the next round', async () => {
    // Both halves of the round contract, measured by a side effect the preset
    // performs on evaluation:
    //   once per round  — the worker is SHARED, so two configs importing one
    //                     preset see it evaluated once, exactly as a fresh
    //                     `vx run` process would (a worker per call would
    //                     double it, and double every preset side effect);
    //   again next round — the worker is RETIRED when the round drains, so the
    //                     next watch cycle starts from an empty registry. If it
    //                     were kept alive, the staleness bug comes straight
    //                     back for every config already imported.
    const log = path.join(root, 'evals.log')
    await writeFile(
      path.join(root, 'preset.mjs'),
      `import { appendFileSync } from 'node:fs'\n` +
        `appendFileSync(${JSON.stringify(log)}, 'x')\n` +
        `export const C = 'v1'\n`,
    )
    const a = await write(
      `import { C } from './preset.mjs'\nexport default { tasks: { a: { c: C } } }\n`,
    )
    const b = await write(
      `import { C } from './preset.mjs'\nexport default { tasks: { b: { c: C } } }\n`,
    )

    const evaluations = async (): Promise<number> => {
      const f = Bun.file(log)
      return (await f.exists()) ? (await f.text()).length : 0
    }

    const before = configEvalWorkerCount()
    await Promise.all([evaluateConfigFresh(a), evaluateConfigFresh(b)])
    expect(await evaluations()).toBe(1)
    expect(configEvalWorkerCount()).toBe(before + 1)

    await Promise.all([evaluateConfigFresh(a), evaluateConfigFresh(b)])
    expect(await evaluations()).toBe(2)
    expect(configEvalWorkerCount()).toBe(before + 2)
  })
})

describe('evaluateConfigFresh: the environment (D-61)', () => {
  it("evaluates against the parent's process.env as it is now, not the startup one", async () => {
    // A Worker starts with the process's startup environment. A config that
    // reads a variable the process set since saw it on the in-process first
    // load and not on any worker load, so an embedder's second run() derived
    // another key (lead from L). The variable is one no startup env holds.
    const key = 'VX_D61_ENV_PROBE'
    // A new file per call: a round evaluates each module once (the shared
    // preset rule above), so re-reading one path would answer from the first.
    const command = async (): Promise<unknown> => {
      const config = await write(
        `export default { tasks: { t: { exec: { command: 'echo ' + (process.env.${key} ?? 'unset') } } } }\n`,
      )
      return ((await evaluateConfigFresh(config)) as ProjectConfig).tasks?.['t']?.exec?.command
    }
    // One round, as a run holds one across its config loads: the worker
    // outlives each evaluation, so a variable the parent deletes must leave
    // the worker's env too.
    const end = beginEvalRound()
    try {
      process.env[key] = 'one'
      expect(await command()).toBe('echo one')
      process.env[key] = 'two'
      expect(await command()).toBe('echo two')
      delete process.env[key]
      expect(await command()).toBe('echo unset')
      expect(configEvalWorkerCount()).toBeGreaterThan(0)
    } finally {
      end()
      delete process.env[key]
    }
  })
})

describe('a config that calls process.exit (D-65)', () => {
  const EXITING =
    "process.exit(0)\nexport default { tasks: { t: { exec: { command: 'true' } } } }\n"
  const REFUSAL = 'process.exit(0) in a config: a config exports its object; it cannot end the run'

  it('is refused by the worker at once, not at the deadline', async () => {
    // The exit ended the worker unheard; the load waited out its budget.
    process.env[BUDGET_ENV] = '5000'
    const file = await write(EXITING)
    const end = beginEvalRound()
    const t0 = performance.now()
    try {
      const got = await evaluateConfigFresh(file).then(
        () => 'resolved',
        (e: Error) => e.message,
      )
      expect({ got, fast: performance.now() - t0 < 2_000 }).toEqual({ got: REFUSAL, fast: true })
    } finally {
      end()
    }
  })

  it('is refused on the first load, in process, and vx lives on with its own exit', async () => {
    // A child: without the guard the exit ends the process that loads it,
    // and a test runner that exits 0 is a silent pass. `exit(0)` was a
    // green `vx run` that ran nothing and printed nothing.
    // Two loads at once: the guard is counted, so neither the first to
    // leave nor the last to enter gives the exit back early. `slow` is still
    // evaluating when `file` enters and leaves, and exits after that.
    const file = await write(EXITING)
    const slow = await write('await new Promise((r) => setTimeout(r, 300))\n' + EXITING)
    const driver = path.join(root, 'first-load.ts')
    await writeFile(
      driver,
      `import { loadProjectConfig } from ${JSON.stringify(path.resolve(import.meta.dir, '../src/workspace/project-loader.ts'))}\n` +
        `const own = process.exit\n` +
        `const got = await Promise.all([${JSON.stringify(slow)}, ${JSON.stringify(file)}].map((f) =>\n` +
        `  loadProjectConfig(f).then(() => 'loaded', (e) => e.message)))\n` +
        `console.error(JSON.stringify({ got, restored: process.exit === own }))\n` +
        `process.exit(3)\n`,
    )
    const p = Bun.spawn({ cmd: [process.execPath, driver], stdout: 'pipe', stderr: 'pipe' })
    const [code, err] = await Promise.all([p.exited, new Response(p.stderr).text()])
    expect({ code, err }).toEqual({
      code: 3,
      err: JSON.stringify({ got: [REFUSAL, REFUSAL], restored: true }) + '\n',
    })
  }, 20_000)
})

describe('a first load that never settles (D-66)', () => {
  it('fails at the budget, naming the config, and gives process.exit back', async () => {
    // In process there was no deadline: a top-level await that never
    // settled while a timer held the loop open hung `vx run` silently.
    // A child, which exits itself: the config's timer outlives the load.
    const file = await write(
      'await new Promise(() => { setInterval(() => {}, 1000) })\nexport default { tasks: {} }\n',
    )
    const driver = path.join(root, 'never-settles.ts')
    await writeFile(
      driver,
      `import { loadProjectConfig } from ${JSON.stringify(path.resolve(import.meta.dir, '../src/workspace/project-loader.ts'))}\n` +
        `const own = process.exit\n` +
        `const got = await loadProjectConfig(${JSON.stringify(file)}).then(() => 'loaded', (e) => e.message)\n` +
        `console.error(JSON.stringify({ got, restored: process.exit === own }))\n` +
        `process.exit(3)\n`,
    )
    const p = Bun.spawn({
      cmd: [process.execPath, driver],
      env: { ...process.env, [BUDGET_ENV]: '300' },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const killer = setTimeout(() => p.kill('SIGKILL'), 8_000)
    const [code, err] = await Promise.all([p.exited, new Response(p.stderr).text()])
    clearTimeout(killer)
    expect({ code, err }).toEqual({
      code: 3,
      err:
        JSON.stringify({
          got: `Project config ${file} did not finish evaluating within 300ms (VX_CONFIG_WORKER_TIMEOUT_MS)`,
          restored: true,
        }) + '\n',
    })
  }, 20_000)
})

describe('evaluateConfigFresh: what a config prints (D-64)', () => {
  it("goes to stderr on every route, never the parent's stdout", async () => {
    // A repeat load evaluates here, and `vx mcp`'s redirect covers only the
    // parent thread: the second tool call's config output landed between two
    // JSON-RPC responses. A child process, so its fd 1 is readable.
    const config = await write(
      "console.log('from console.log')\nconsole.info('from console.info')\n" +
        "process.stdout.write('from stdout.write\\n')\n" +
        "await Bun.write(Bun.stdout, 'from Bun.write\\n')\n" +
        "const w = Bun.stdout.writer(); w.write('from a writer\\n'); await w.flush()\n" +
        "export default { tasks: { t: { exec: { command: 'true' } } } }\n",
    )
    const driver = path.join(root, 'driver.ts')
    await writeFile(
      driver,
      `import { beginEvalRound, evaluateConfigFresh } from ${JSON.stringify(path.resolve(import.meta.dir, '../src/workspace/config-eval.ts'))}\n` +
        `const end = beginEvalRound()\n` +
        `const c = await evaluateConfigFresh(${JSON.stringify(config)})\n` +
        `end()\n` +
        `process.stderr.write('config ' + JSON.stringify(c) + '\\n')\n`,
    )
    const p = Bun.spawn({ cmd: [process.execPath, driver], stdout: 'pipe', stderr: 'pipe' })
    const [code, out, err] = await Promise.all([
      p.exited,
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
    ])
    expect({ code, out, err }).toEqual({
      code: 0,
      out: '',
      err:
        'from console.log\nfrom console.info\nfrom stdout.write\nfrom Bun.write\nfrom a writer\n' +
        'config {"tasks":{"t":{"exec":{"command":"true"}}}}\n',
    })
  }, 20_000)
})

describe('a first load in process: what a config prints', () => {
  it("goes to stderr, never the verb's stdout, and every route is put back", async () => {
    // `vx show --format json` evaluates in process, and a config's
    // `console.log` came out ahead of the JSON on stdout.
    const prints =
      "console.log('log')\nprocess.stdout.write('write\\n')\n" +
      "await Bun.write(Bun.stdout, 'bun\\n')\n" +
      "const w = Bun.stdout.writer(); w.write('writer\\n'); await w.flush()\n"
    const config = await write(
      prints + "export default { tasks: { t: { exec: { command: 'true' } } } }\n",
    )
    const ws = path.join(root, 'ws')
    await mkdir(ws)
    await writeFile(path.join(ws, 'vx.workspace.mjs'), prints + 'export default {}\n')
    const driver = path.join(root, 'first-load.ts')
    await writeFile(
      driver,
      `import { loadProjectConfigs, loadWorkspaceConfig } from ${JSON.stringify(path.resolve(import.meta.dir, '../src/workspace/project-loader.ts'))}\n` +
        `const routes = () => [process.stdout.write, Bun.write, Bun.stdout.writer, console]\n` +
        `const before = routes()\n` +
        `await loadWorkspaceConfig(${JSON.stringify(ws)})\n` +
        `await loadProjectConfigs([${JSON.stringify(config)}])\n` +
        `const back = routes().every((r, i) => r === before[i])\n` +
        `process.stdout.write('back ' + back + '\\n')\n`,
    )
    const p = Bun.spawn({ cmd: [process.execPath, driver], stdout: 'pipe', stderr: 'pipe' })
    const [code, out, err] = await Promise.all([
      p.exited,
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
    ])
    expect({ code, out, err }).toEqual({
      code: 0,
      out: 'back true\n',
      err: 'log\nwrite\nbun\nwriter\n'.repeat(2),
    })
  }, 20_000)

  it('rounds that overlap all load, and the last one out puts the routes back', async () => {
    // `--affected`'s per-file sweep loads each config in a round of its own:
    // a second redirect installed over the first moved `Bun.write` under the
    // first round's snapshot, every load was refused, and the out-of-order
    // undos left stdout on stderr.
    const configs = await Promise.all(
      ['a', 'b', 'c'].map(async (name) => {
        const dir = path.join(root, name)
        await mkdir(dir)
        const file = path.join(dir, 'vx.config.mjs')
        await writeFile(
          file,
          "await Bun.sleep(5)\nconsole.log('log')\n" +
            "export default { tasks: { t: { exec: { command: 'true' } } } }\n",
        )
        return file
      }),
    )
    const driver = path.join(root, 'overlap.ts')
    await writeFile(
      driver,
      `import { loadProjectConfigs } from ${JSON.stringify(path.resolve(import.meta.dir, '../src/workspace/project-loader.ts'))}\n` +
        `const routes = () => [process.stdout.write, Bun.write, Bun.stdout.writer, console]\n` +
        `const before = routes()\n` +
        `const loaded = await Promise.allSettled(${JSON.stringify(configs)}.map((c) => loadProjectConfigs([c])))\n` +
        `const back = routes().every((r, i) => r === before[i])\n` +
        `process.stdout.write(loaded.map((r) => r.status).join(' ') + ' back ' + back + '\\n')\n`,
    )
    const p = Bun.spawn({ cmd: [process.execPath, driver], stdout: 'pipe', stderr: 'pipe' })
    const [code, out, err] = await Promise.all([
      p.exited,
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
    ])
    expect({ code, out, err }).toEqual({
      code: 0,
      out: 'fulfilled fulfilled fulfilled back true\n',
      err: 'log\n'.repeat(3),
    })
  }, 20_000)
})

describe('evaluateConfigFresh: errors cross the boundary', () => {
  // Each case below rejects from inside the WORKER. A rejection clears its own
  // deadline in the `finally`, so nothing is left armed to drain — these used
  // to need an afterEach that slept out the orphaned timer. The budget also
  // covers a fresh worker's spawn: at 250 ms a loaded CI runner fired it first
  // in the mixed round. If it ever fires, the assertions below name it rather
  // than passing for the wrong reason.
  const BUDGET = 4000

  beforeEach(() => {
    process.env[BUDGET_ENV] = String(BUDGET)
  })

  it('rebuilds the thrown error with its name, message and the config in the stack', async () => {
    // Name and stack are what make a broken config debuggable. The worker hop
    // hands back three strings; dropping the `err.name`/`err.stack` assignment
    // would silently rename every config error to "Error" and point its stack
    // at config-eval.ts, i.e. at vx rather than at the user's file.
    const file = await write(
      `class PresetError extends Error { name = 'PresetError' }\n` +
        `throw new PresetError('preset is not configured')\n`,
    )
    const err = await evaluateConfigFresh(file).then(
      () => new Error('NO THROW'),
      (e: unknown) => e as Error,
    )
    expect(err.name).toBe('PresetError')
    expect(err.message).toBe('preset is not configured')
    expect(err.stack).toContain(path.basename(file))
  })

  it("forwards a transpile error's position, which its message does not carry", async () => {
    // `BuildMessage` says only `Expected "}" but found end of file`; the file,
    // line and column live in `position`, which the loader turns into the
    // location the user opens. The three-string relay dropped it.
    const file = await write('const a = 1\nconst b = 2\nexport default { tasks: ] }\n')
    type Positioned = Error & { position?: { file?: string; line?: number } }
    const err: Positioned = await evaluateConfigFresh(file).then(
      () => new Error('NO THROW'),
      (e: unknown) => e as Positioned,
    )
    expect(err.name).toBe('BuildMessage')
    expect(err.position?.file).toBe(file)
    expect(err.position?.line).toBe(3)
  })

  it('reports the same name and message an in-process import would', async () => {
    // The repeat path must not change what a user sees for a config that
    // throws — the only difference between the two paths should be WHERE the
    // module was evaluated.
    const body = `throw new TypeError('cannot read config from undefined')\n`
    const viaWorker = await evaluateConfigFresh(await write(body)).then(
      () => null,
      (e: unknown) => e as Error,
    )
    const viaImport = await import(await write(body)).then(
      () => null,
      (e: unknown) => e as Error,
    )
    expect(viaWorker).not.toBeNull()
    expect(viaImport).not.toBeNull()
    expect([viaWorker?.name, viaWorker?.message]).toEqual([viaImport?.name, viaImport?.message])
    expect(viaWorker?.name).toBe('TypeError')
  })

  it("rejects with the trap's own message when reading the config throws, instead of hanging", async () => {
    // The worker reads every value before it replies (the JSON-data walk,
    // then `JSON.stringify`), so a throwing read throws there. It must be
    // caught and travel back as an error: an uncaught one posts no reply at
    // all and leaves the caller waiting out the full deadline. (A cyclic
    // config and a bigint, the two throws this row held before item 701,
    // and a getter, since D-67, are now refused by name on both paths —
    // below. A proxy's trap still throws in the walk.)
    const body = `export default new Proxy({ tasks: {} }, { getOwnPropertyDescriptor() { throw new Error('trap says no') } })\n`
    expect(await settleOrHang(evaluateConfigFresh(await write(body)), 5000)).toBe(
      'REJECTED trap says no',
    )
  })

  it('names the config file when it cannot be read', async () => {
    // A config deleted mid-session (branch switch, rename) during `vx watch`.
    // The message must point at the file; the path is the only actionable part.
    const file = await write('export default {}\n')
    await rm(file)
    const outcome = await settleOrHang(evaluateConfigFresh(file), 5000)
    expect(outcome).toMatch(/^REJECTED/)
    expect(outcome).toContain(path.basename(file))
  })

  it('settles a mixed round without stranding the sibling or leaking the worker', async () => {
    // One broken config among many is the ordinary watch-cycle shape. The
    // sibling must still resolve, and — the part that matters most — the
    // worker must still be retired: `inFlight--` lives in a `finally`, and if
    // it did not, a single throwing config would pin the counter above zero
    // forever, keep the worker (and its stale registry) alive for the rest of
    // the session, and bring the staleness bug straight back.
    const boom = await write(`throw new Error('kaboom')\n`)
    const good = await write(`export default { tasks: { ok: {} } }\n`)

    const before = configEvalWorkerCount()
    const [bad, fine] = await Promise.all([
      settleOrHang(evaluateConfigFresh(boom), 5000),
      settleOrHang(evaluateConfigFresh(good), 5000),
    ])
    expect(bad).toBe('REJECTED kaboom')
    expect(fine).toBe('RESOLVED {"tasks":{"ok":{}}}')
    expect(configEvalWorkerCount()).toBe(before + 1)

    // The retirement is what this proves: a NEW worker, i.e. a fresh registry.
    await evaluateConfigFresh(good)
    expect(configEvalWorkerCount()).toBe(before + 2)
  })
})

describe('validation stays in the parent process', () => {
  it('reports an identical UserError from the first and the repeat load', async () => {
    // The reason validation was left in `loadProjectConfig` instead of moving
    // into the worker: no error text is marshalled, so a malformed config
    // reads the same on cycle 1 and cycle 9 of a watch session. Name, message
    // and the stack's first line are compared — modulo the config path, which
    // is necessarily different between the two files.
    const bad =
      `export default { tasks: { build: {\n` +
      `  exec: { command: 'echo hi' },\n` +
      `  cache: { inputs: { files: ['src/**'], workspaceFile: ['x'] }, outputs: { files: ['o'] } },\n` +
      `} } }\n`

    const firstFile = await write(bad)
    const firstErr = await loadProjectConfig(firstFile).then(
      () => new Error('NO THROW'),
      (e: unknown) => e as Error,
    )

    // Reaching the repeat path is exactly a watch cycle: load a good config,
    // then break it.
    const repeatFile = await write(
      `export default { tasks: { build: { exec: { command: 'x' } } } }\n`,
    )
    await loadProjectConfig(repeatFile)
    await writeFile(repeatFile, bad)
    const repeatErr = await loadProjectConfig(repeatFile).then(
      () => new Error('NO THROW'),
      (e: unknown) => e as Error,
    )

    const scrub = (s: string, file: string): string => s.split(file).join('<CONFIG>')
    expect(firstErr.message).toMatch(/cache\.inputs has unknown field "workspaceFile"/)
    expect(scrub(repeatErr.message, repeatFile)).toBe(scrub(firstErr.message, firstFile))
    expect(repeatErr.name).toBe(firstErr.name)
    expect(repeatErr.name).toBe('UserError')

    // The `.stack` first line is deliberately NOT compared. It looks like a
    // free third signal, but it pins the RUNTIME rather than vx: under memory
    // pressure JSC hands back a truncated `"Error"` where it normally returns
    // `"UserError: <message>"`, so the two paths disagree for a reason that
    // has nothing to do with either of them. Reproduced by running this file
    // against the memory suite — roughly one run in six, and it redded CI once
    // before it was understood.
    //
    // Nothing is lost: `name` and `message` ARE vx's own data, and they carry
    // the whole contract this test exists for — a malformed config reads the
    // same on cycle 1 and cycle 9 of a watch session.
  })

  it('reads a Promise default export the same on the first and the repeat load (D-5)', async () => {
    // The first load's async return flattens the Promise; the worker read
    // it raw and refused it as "an instance of Promise" on cycle 2 of a watch.
    const body = `export default Promise.resolve({ tasks: { build: { exec: { command: 'x' } } } })\n`
    const file = await write(body)
    const first = await loadProjectConfig(file)
    const repeat = await loadProjectConfig(file)
    expect(first).toEqual({ tasks: { build: { exec: { command: 'x' } } } })
    expect(repeat).toEqual(first)
    // Control: a Promise of no object is refused on the repeat load as on the first.
    await writeFile(file, 'export default Promise.resolve(42)\n')
    await expect(loadProjectConfig(file)).rejects.toThrow(/did not export a default object/)
  })

  it('refuses a workspace Promise default of no object, as a project one is (D-6)', async () => {
    // Checked only before the await: `null` crashed the validator with a
    // TypeError stack, `42` loaded as a workspace with no config.
    const file = path.join(root, 'vx.workspace.mjs')
    for (const value of ['null', '42']) {
      await writeFile(file, `export default Promise.resolve(${value})\n`)
      const err = await loadWorkspaceConfig(root).then(
        () => new Error('NO THROW'),
        (e: unknown) => e as Error,
      )
      expect(err.name).toBe('UserError')
      expect(err.message).toBe(`Workspace config at ${file} did not export a default object`)
    }
    // Control: a Promise of an object loads.
    await writeFile(file, 'export default Promise.resolve({ concurrency: 2 })\n')
    expect(await loadWorkspaceConfig(root)).toEqual({ concurrency: 2 })
  })

  it('only rejects a typo whose value JSON drops on the FIRST load', async () => {
    // KNOWN DIVERGENCE, pinned rather than fixed. Unknown-field rejection walks
    // `Object.keys`, and `JSON.stringify` drops keys whose value is `undefined`
    // — so `workspaceFile: undefined` is a hard error in-process and invisible
    // through the worker. Benign for the cache key (an undefined value hashes
    // as absent either way, so there is no stale hit), but it does mean a
    // config can fail cycle 1 of `vx watch` and pass cycle 2 unchanged.
    const bad =
      `export default { tasks: { build: {\n` +
      `  exec: { command: 'echo hi' },\n` +
      `  cache: { inputs: { files: ['src/**'], workspaceFile: undefined }, outputs: { files: ['o'] } },\n` +
      `} } }\n`

    const firstFile = await write(bad)
    await expect(loadProjectConfig(firstFile)).rejects.toThrow(/unknown field "workspaceFile"/)

    const repeatFile = await write(
      `export default { tasks: { build: { exec: { command: 'x' } } } }\n`,
    )
    await loadProjectConfig(repeatFile)
    await writeFile(repeatFile, bad)
    const config = await loadProjectConfig(repeatFile)
    expect(config.tasks?.build?.cache?.inputs).toEqual({ files: ['src/**'] })
  })
})

describe('the evaluation deadline', () => {
  const HANG = 'await new Promise(() => {})\nexport default {}\n'

  it('rejects a wedged worker instead of awaiting it forever, then recovers', async () => {
    // Nothing else bounds this await — there is no run-level timeout — so a
    // worker the OS kills under memory pressure, or one that simply never
    // replies, would stall `vx watch` permanently on a cycle that normally
    // takes milliseconds. Driving the budget down asserts the real rejection
    // instead of the existence of a constant; without the deadline this test
    // does not fail, it HANGS, which is the point.
    process.env[BUDGET_ENV] = '250'
    const wedged = await settleOrHang(evaluateConfigFresh(await write(HANG)), 5000)
    expect(wedged).toBe('REJECTED config worker did not answer within 250ms')

    // Recovery is the other half: the timeout path nulls the worker handle, so
    // the next cycle builds a fresh one. If it did not, one hiccup would wedge
    // every later config load for the life of the process. Its budget is
    // generous: 250 ms also had to cover the fresh worker's spawn, which a
    // loaded macOS runner missed (PR #1503, #1738). A kept wedged worker
    // still fails it, rejected at 4000 ms or held past 5000.
    process.env[BUDGET_ENV] = '4000'
    const after = await settleOrHang(
      evaluateConfigFresh(await write('export default { tasks: { ok: {} } }\n')),
      5000,
    )
    expect(after).toBe('RESOLVED {"tasks":{"ok":{}}}')
  }, 15_000)

  it('a deadline inside a held round retires the wedged worker, so the next config loads (D-17)', async () => {
    // A round held open across sequential loads (item 694) keeps its
    // worker; a busy loop blocks that worker's thread, so kept after the
    // deadline it would time out every later config in the round.
    process.env[BUDGET_ENV] = '250'
    const end = beginEvalRound()
    try {
      const busy = await settleOrHang(evaluateConfigFresh(await write('while (true) {}\n')), 5000)
      expect(busy).toBe('REJECTED config worker did not answer within 250ms')
      // The next load spawns a fresh worker, which a 250 ms budget does not
      // cover on a loaded box (A-51's shape; M-13). A kept wedged worker
      // still fails it, rejected at 4000 ms or held past 5000.
      process.env[BUDGET_ENV] = '4000'
      const next = await settleOrHang(
        evaluateConfigFresh(await write('export default { tasks: { ok: {} } }\n')),
        5000,
      )
      expect(next).toBe('RESOLVED {"tasks":{"ok":{}}}')
    } finally {
      end()
    }
  }, 15_000)

  it('an uncaught throw in the worker rejects at once, naming it, not at the deadline (D-17)', async () => {
    // A throw from a config's microtask escapes the evaluation's try and
    // reaches the worker's `error` event; unheard, the load waited out the
    // budget and said only that the worker did not answer.
    process.env[BUDGET_ENV] = '10000'
    const file = await write(
      "queueMicrotask(() => { throw new Error('micro boom') })\nexport default {}\n",
    )
    const out = await settleOrHang(evaluateConfigFresh(file), 5000)
    expect(out.startsWith('REJECTED config worker failed:')).toBe(true)
    expect(out).toContain('micro boom')
  }, 15_000)

  it('rejects the whole wedged round at the FIRST deadline, not each at its own', async () => {
    // A watch cycle loads its configs concurrently and they share one worker,
    // so terminating that worker makes every sibling unanswerable — they must
    // be rejected then and there rather than left pending until their own
    // deadlines elapse (a single unsettled promise inside `Promise.all` hangs
    // the cycle exactly as the no-deadline case did).
    //
    // The message is the proof: the second call's own budget is a minute, so
    // only the first call's 200 ms deadline can reject it inside the ceiling,
    // and the rejection names that budget. A 500 ms ceiling between the two
    // budgets raced a loaded box's late 200 ms timer and read HUNG (D-94).
    process.env[BUDGET_ENV] = '200'
    const first = evaluateConfigFresh(await write(HANG))
    process.env[BUDGET_ENV] = '60000'
    const second = evaluateConfigFresh(await write(HANG))

    const outcomes = await Promise.all([settleOrHang(first, 5000), settleOrHang(second, 5000)])
    // Both name the budget of whichever call timed out FIRST — the sibling's
    // own minute never applied to it.
    for (const o of outcomes) expect(o).toBe('REJECTED config worker did not answer within 200ms')
  }, 15_000)

  const MALFORMED = ['abc', '', ' 250', '-5', '1e3', '25.0']

  for (const raw of MALFORMED) {
    it(`ignores a malformed budget ${JSON.stringify(raw)} instead of deadlining instantly`, async () => {
      // The digits-only guard is load-bearing: `Number('abc')` is NaN and
      // `setTimeout(fn, NaN)` fires on the next tick, so dropping the regex
      // would turn any typo in this env var into "every repeat config load
      // fails with a timeout" — including the empty-string case a shell
      // produces from `VX_CONFIG_WORKER_TIMEOUT_MS=$UNSET`.
      process.env[BUDGET_ENV] = raw
      const file = await write('export default { tasks: { ok: {} } }\n')
      expect(await settleOrHang(evaluateConfigFresh(file), 5000)).toBe(
        'RESOLVED {"tasks":{"ok":{}}}',
      )
    }, 15_000)
  }

  it('a budget of 0 falls back to the default instead of firing on the next tick (D-157)', async () => {
    // `0` deadlined every repeat load instantly ("did not answer within 0ms"),
    // so `vx watch` failed each cycle. It is out of range for a bound, as it is
    // for VX_KILL_GRACE_MS, and falls back like the timer-ceiling case below:
    // not "no deadline", which would let a wedged worker hang the watch loop.
    process.env[BUDGET_ENV] = '0'
    const file = await write('await Bun.sleep(400)\nexport default { tasks: { ok: {} } }\n')
    const outcome = await settleOrHang(evaluateConfigFresh(file), 5000)
    expect(outcome).toBe('RESOLVED {"tasks":{"ok":{}}}')
  }, 15_000)

  it('a budget past the timer ceiling falls back instead of firing at 1ms', async () => {
    // FIXED. Unbounded, `999999999999` overflowed the timer's 32-bit delay to
    // 1ms and then reported "did not answer within 999999999999ms" \u2014 a message
    // that cannot be true and points nowhere near the cause. Every repeat config
    // load failed, which breaks `vx watch`, the only path that reaches this.
    //
    // It falls back to the 30s default rather than clamping to ~24.8 days: this
    // is a BOUND on a worker that may be wedged, not a duration the caller is
    // choosing, so honouring the huge value would hang the watch loop forever.
    process.env[BUDGET_ENV] = '999999999999'
    const file = await write('await Bun.sleep(400)\nexport default { tasks: { ok: {} } }\n')
    const started = Date.now()
    const outcome = await settleOrHang(evaluateConfigFresh(file), 5000)
    // The ~400ms config now finishes, because the honest budget is 30s.
    expect(String(outcome)).not.toContain('did not answer within')
    expect(Date.now() - started).toBeGreaterThanOrEqual(300)
  }, 15_000)

  it('a REJECTED evaluation does not poison a later one', async () => {
    // `clearTimeout` used to sit after the `await` inside the try body, so it
    // was skipped whenever the evaluation REJECTED — leaving the timer armed
    // for its whole budget. When that orphan fired it ran `rejectAll()` and
    // terminated whatever worker was current AT THAT MOMENT, which by then
    // belonged to an unrelated, healthy round.
    //
    // The shape that matters: fix a typo during `vx watch` and the failed load
    // left a timer armed for the DEFAULT 30s; a cycle up to 30 seconds later
    // could die with "config worker did not answer within 30000ms" — naming a
    // budget nobody set for it, for a config that was fine.
    // No row here is a race against the clock. A held round spawns its worker
    // first, under a generous budget, so no budget below pays for a spawn (a
    // loaded macOS runner took over 1000 ms for one, M-10). The rejected load
    // gets a budget far past a warm import, so it rejects rather than timing
    // out. The healthy load then blocks on a release file, and the release
    // waits on a timer due AFTER the rejected load's own: timers fire in
    // deadline order, so an orphaned timer has fired, and terminated the
    // shared worker, before the healthy load can answer.
    const end = beginEvalRound()
    try {
      process.env[BUDGET_ENV] = '10000'
      const warm = await write('export default {}\n')
      expect(await settleOrHang(evaluateConfigFresh(warm), 12_000)).toBe('RESOLVED {}')

      const rejectedBudget = 3000
      process.env[BUDGET_ENV] = String(rejectedBudget)
      const broken = await write(`throw new Error('typo in preset')\n`)
      expect(await settleOrHang(evaluateConfigFresh(broken), 10_000)).toBe(
        'REJECTED typo in preset',
      )
      // Read once the load has settled, after its timer was armed: an
      // orphan is then due before the release however long the arming took
      // (a mark taken before the call let a slow arm fall past the release,
      // and the row passed with the orphan alive).
      const brokenSettled = Date.now()

      process.env[BUDGET_ENV] = '20000'
      const release = path.join(root, `release.${seq}`)
      const held = await write(
        `import { existsSync } from 'node:fs'\n` +
          `while (!existsSync(${JSON.stringify(release)})) await Bun.sleep(5)\n` +
          `export default { tasks: { ok: {} } }\n`,
      )
      const healthy = settleOrHang(evaluateConfigFresh(held), 25_000)
      await Bun.sleep(Math.max(0, brokenSettled + rejectedBudget + 50 - Date.now()))
      await writeFile(release, '')
      expect(await healthy).toBe('RESOLVED {"tasks":{"ok":{}}}')
    } finally {
      end()
    }
  }, 40_000)
})

describe('a config is JSON data, on every path (item 701)', () => {
  const JSON_DATA = '— a config must be JSON data, because the cache key folds its JSON'

  it('the same file is refused by the first load and by the repeat load, with one message', async () => {
    // The defect: the first load validated the live object and refused the
    // function ("must be a string"); the repeat load round-tripped through
    // JSON first, dropped it and accepted the config — `vx watch` accepted
    // what `vx run` refused.
    const file = await write(
      `export default { tasks: { build: { exec: { command: 'true' }, description: () => 'x' } } }\n`,
    )
    const message = `${file}: tasks.build.description is a function ${JSON_DATA}`
    expect(await settle(loadProjectConfig(file))).toBe(`REJECTED ${message}`)
    expect(await settle(loadProjectConfig(file))).toBe(`REJECTED ${message}`)
  })

  // Each kind of value JSON cannot carry: the module text, then the path
  // and what the message calls it. Several sit where the validator never
  // looks at the type (a whole `sandbox`, `persistent`, the `tasks` table),
  // so before item 701 they loaded on both paths and hashed as something
  // else.
  const KINDS: ReadonlyArray<readonly [string, string, string, string]> = [
    [
      'a function',
      `export default { tasks: { build: { exec: { command: 'true' }, description: () => 'x' } } }\n`,
      'tasks.build.description',
      'a function',
    ],
    [
      'a symbol',
      `export default { tasks: { build: { exec: { command: 'true' }, description: Symbol('x') } } }\n`,
      'tasks.build.description',
      'a symbol',
    ],
    [
      'a bigint',
      `export default { tasks: { build: { exec: { command: 'true', timeout: 1000n } } } }\n`,
      'tasks.build.exec.timeout',
      'a bigint',
    ],
    [
      'NaN',
      `export default { tasks: { build: { exec: { command: 'true', timeout: NaN } } } }\n`,
      'tasks.build.exec.timeout',
      'NaN',
    ],
    [
      'Infinity',
      `export default { tasks: { build: { exec: { command: 'true', timeout: Infinity } } } }\n`,
      'tasks.build.exec.timeout',
      'Infinity',
    ],
    [
      '-Infinity',
      `export default { tasks: { build: { exec: { command: 'true', retries: -Infinity } } } }\n`,
      'tasks.build.exec.retries',
      '-Infinity',
    ],
    [
      'undefined in an array',
      `export default { tasks: { build: { exec: { command: 'true' }, dependsOn: ['^build', undefined] } } }\n`,
      'tasks.build.dependsOn[1]',
      'undefined in an array, which JSON writes as null',
    ],
    [
      'a hole in an array',
      `export default { tasks: { build: { exec: { command: 'true' }, dependsOn: ['^build', , 'lint'] } } }\n`,
      'tasks.build.dependsOn[1]',
      'undefined in an array, which JSON writes as null',
    ],
    [
      'a Date',
      `export default { tasks: { build: { exec: { command: 'true', persistent: new Date(0) } } } }\n`,
      'tasks.build.exec.persistent',
      'an instance of Date',
    ],
    [
      'a Map',
      `export default { tasks: new Map([['build', { exec: { command: 'true' } }]]) }\n`,
      'tasks',
      'an instance of Map',
    ],
    [
      'a Set',
      `export default { tasks: { build: { exec: { command: 'true' }, dependsOn: new Set(['^build']) } } }\n`,
      'tasks.build.dependsOn',
      'an instance of Set',
    ],
    [
      'a RegExp',
      `export default { tasks: { dev: { exec: { command: 'true', persistent: { readyWhen: /ready/ } } } } }\n`,
      'tasks.dev.exec.persistent.readyWhen',
      'an instance of RegExp',
    ],
    [
      'a class instance',
      `class Sandbox { allow = { read: [] } }\nexport default { tasks: { build: { exec: { command: 'true', sandbox: new Sandbox() } } } }\n`,
      'tasks.build.exec.sandbox',
      'an instance of Sandbox',
    ],
    [
      'a cycle',
      `const config = { tasks: { build: { exec: { command: 'true' } } } }\nconfig.tasks.build.exec.env = { define: config }\nexport default config\n`,
      'tasks.build.exec.env.define',
      'a cyclic reference',
    ],
    [
      'a cycle through an array',
      `const deps = ['^build']\ndeps.push(deps)\nexport default { tasks: { build: { exec: { command: 'true' }, dependsOn: deps } } }\n`,
      'tasks.build.dependsOn[1]',
      'a cyclic reference',
    ],
    [
      'an instance of an anonymous class',
      `export default { tasks: { build: { exec: { command: 'true', sandbox: new (class {})() } } } }\n`,
      'tasks.build.exec.sandbox',
      'an object whose prototype is not Object.prototype',
    ],
    [
      'a default export that is not a plain object',
      `export default new Map()\n`,
      'the default export',
      'an instance of Map',
    ],
    // D-67: a getter is code. Read three times per load, it could answer
    // the key, the check and the command differently.
    [
      'a getter',
      `let n = 0\nexport default { tasks: { build: { exec: { get command() { return 'echo ' + ++n } } } } }\n`,
      'tasks.build.exec.command',
      'a getter',
    ],
    [
      'a getter that throws, never called',
      `export default { tasks: { build: { get exec() { throw new Error('called') } } } }\n`,
      'tasks.build.exec',
      'a getter',
    ],
    [
      'a setter with no getter',
      `export default { tasks: { build: { exec: { command: 'true' }, set description(v) {} } } }\n`,
      'tasks.build.description',
      'a setter',
    ],
  ]

  for (const [label, body, at, is] of KINDS) {
    it(`the first load (in-process) refuses ${label}`, async () => {
      const file = await write(body)
      expect(await settle(loadProjectConfig(file))).toBe(
        `REJECTED ${file}: ${at} is ${is} ${JSON_DATA}`,
      )
    })

    it(`the worker refuses ${label}, before its JSON round trip drops it`, async () => {
      const file = await write(body)
      expect(await settle(evaluateConfigFresh(file))).toBe(
        `REJECTED ${file}: ${at} is ${is} ${JSON_DATA}`,
      )
    })
  }

  // The controls: what JSON carries, or drops the way every path already
  // agrees on, loads on both paths as the same object.
  const FAITHFUL: ReadonlyArray<readonly [string, string, ProjectConfig]> = [
    [
      'an undefined property and a conditional spread',
      `const ci = false\nexport default { tasks: { build: { exec: { command: 'true', timeout: undefined, ...(ci ? { retries: 2 } : {}) }, description: undefined } } }\n`,
      { tasks: { build: { exec: { command: 'true' } } } },
    ],
    [
      // The shared object holds an array: a walk that pushed the array and
      // never popped it pops the object in its place, and the second visit
      // then reads a cycle that is not there.
      'one task object, holding an array, under two names: a DAG is data, not a cycle',
      `const task = { exec: { command: 'true' }, dependsOn: ['^build'] }\nexport default { tasks: { a: task, b: task } }\n`,
      {
        tasks: {
          a: { exec: { command: 'true' }, dependsOn: ['^build'] },
          b: { exec: { command: 'true' }, dependsOn: ['^build'] },
        },
      },
    ],
    [
      'a null-prototype object and one object shared by two tasks',
      `const exec = Object.assign(Object.create(null), { command: 'true' })\nexport default { tasks: { a: { exec }, b: { exec } } }\n`,
      { tasks: { a: { exec: { command: 'true' } }, b: { exec: { command: 'true' } } } },
    ],
  ]

  for (const [label, body, expected] of FAITHFUL) {
    it(`control: ${label} loads on both paths`, async () => {
      const file = await write(body)
      const first = await loadProjectConfig(file)
      const repeat = await loadProjectConfig(file)
      expect(JSON.parse(JSON.stringify(first))).toStrictEqual(expected)
      expect(repeat).toStrictEqual(expected)
    })
  }

  it('a faithful config crosses both paths with the same JSON, the bytes its key folds', async () => {
    // Why item 701 moves no cache key: the rule only refuses, so a config
    // that passes is the object it was, and `hashTaskConfig` folds its
    // `JSON.stringify`. The literal is what 107a8f8b (before the rule)
    // produced for this file on both paths.
    const file = await write(
      `const shared = ['src/**', 'package.json']\nexport default {\n  tasks: {\n    build: {\n      description: 'büild — "quoted"',\n      exec: { command: 'bun run build', timeout: 60000, env: { passThrough: ['HOME'], define: { MODE: 'prod' } } },\n      dependsOn: ['^build'],\n      cache: { inputs: { files: shared, env: ['API_URL'] }, outputs: { files: ['dist/**'] } },\n    },\n    ci: { dependsOn: ['build'], description: undefined },\n  },\n}\n`,
    )
    const json =
      '{"tasks":{"build":{"description":"büild — \\"quoted\\"","exec":{"command":"bun run build","timeout":60000,"env":{"passThrough":["HOME"],"define":{"MODE":"prod"}}},"dependsOn":["^build"],"cache":{"inputs":{"files":["src/**","package.json"],"env":["API_URL"]},"outputs":{"files":["dist/**"]}}},"ci":{"dependsOn":["build"]}}}'
    expect(JSON.stringify(await loadProjectConfig(file))).toBe(json)
    expect(JSON.stringify(await loadProjectConfig(file))).toBe(json)
  })
})
