// `VxPlugin.commands` — verbs a plugin adds to the CLI. Driven through the
// real dispatcher (`cli/index.ts run`) from inside a workspace whose
// .vx/workspace.mjs declares the plugin inline.
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { run as cli } from './helpers/cli.js'
import { pluginVerbs } from '../src/cli/plugin-commands.js'
import { localWorkspaceSource } from './helpers/local-workspace.js'
import { pluginSource } from './helpers/plugin.js'
import { xxh3hex } from '../src/util/index.js'
import { noticed } from './helpers/notice.js'

let root: string
let prevCwd: string
let out: string[]
let err: string[]
let outSpy: ReturnType<typeof spyOn>
let errSpy: ReturnType<typeof spyOn>

beforeEach(async () => {
  // realpath'd: `process.cwd()` answers the real path, and the context is
  // derived from the cwd.
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'vx-plugin-cmd-')))
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'ws', private: true }))
  await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
  prevCwd = process.cwd()
  process.chdir(root)
  out = []
  err = []
  outSpy = spyOn(process.stdout, 'write').mockImplementation(((chunk: string) => {
    out.push(String(chunk))
    return true
  }) as never)
  errSpy = spyOn(process.stderr, 'write').mockImplementation(((chunk: string) => {
    err.push(String(chunk))
    return true
  }) as never)
})
afterEach(async () => {
  outSpy.mockRestore()
  errSpy.mockRestore()
  process.chdir(prevCwd)
  await rm(root, { recursive: true, force: true })
  delete (globalThis as { __vxCmd?: unknown }).__vxCmd
})

const HELLO = pluginSource(
  'org/hello',
  `{ commands: {
    hello: {
      description: 'says hi',
      run(argv, ctx) {
        globalThis.__vxCmd = { argv: [...argv], root: ctx.workspaceRoot, cacheDir: ctx.cacheDir }
        return 7
      },
    },
  },
}`,
)

const SHADOW = pluginSource(
  'org/shadow',
  `{ commands: {
    version: { description: 'never runs — core owns this verb', run() { globalThis.__vxCmd = 'shadowed'; return 9 } },
  },
}`,
)

const TWICE = pluginSource(
  'org/twice',
  `{ commands: { hello: { description: 'also hi', run() { return 1 } } },
}`,
)

describe('plugin commands', () => {
  it('a plugin verb runs with its argv and a workspace context, and its exit code is the result', async () => {
    await Bun.write(path.join(root, '.vx/workspace.mjs'), localWorkspaceSource([HELLO]))
    const code = await cli(['hello', 'world', '--flag'])
    expect(code).toBe(7)
    expect((globalThis as { __vxCmd?: unknown }).__vxCmd).toEqual({
      argv: ['world', '--flag'],
      root,
      cacheDir: path.join(root, '.vx', 'cache'),
    })
    expect(err.join('')).not.toContain('unknown command')
  })

  it("a verb's ctx.cache reads the plugin's entries from the workspace's remote and never writes it", async () => {
    const box = globalThis as unknown as { __vxWire: Map<string, Uint8Array>; __vxCmd?: unknown }
    box.__vxWire = new Map([
      [xxh3hex('vx-plugin\0org/reader\0seed'), new TextEncoder().encode('kept')],
    ])
    await Bun.write(
      path.join(root, '.vx/workspace.mjs'),
      localWorkspaceSource([
        pluginSource(
          'org/wire',
          `{ cache: () => ({
              has: async (h) => globalThis.__vxWire.has(h),
              get: async (h) => globalThis.__vxWire.has(h) ? { body: new Blob([globalThis.__vxWire.get(h)]), durationMs: undefined } : null,
              put: async (h, b) => { globalThis.__vxWire.set(h, new Uint8Array(await b.arrayBuffer())) },
            }) }`,
        ),
        pluginSource(
          'org/reader',
          `{ commands: { read: { description: 'reads', async run(argv, ctx) {
               const got = await ctx.cache.get('seed')
               await ctx.cache.put('new', new TextEncoder().encode('n'))
               globalThis.__vxCmd = new TextDecoder().decode(got)
               return 0
             } } } }`,
        ),
      ]),
    )
    expect(await cli(['read'])).toBe(0)
    expect(box.__vxCmd).toBe('kept')
    expect(box.__vxWire.size).toBe(1)
  })

  // A remote that takes its token in `open` (turboCache's OIDC exchange)
  // answered nothing to a verb, so `vx dte agent` uploaded nowhere and its
  // run could not restore what it ran (2026-10-22).
  for (const ci of [true, false]) {
    it(`a verb's cache and artifacts open the workspace's remote first (CI ${ci})`, async () => {
      const box = globalThis as unknown as { __vxWire: Map<string, Uint8Array>; __vxCmd?: unknown }
      const seed = xxh3hex('vx-plugin\0org/saver\0seed')
      box.__vxWire = new Map([[seed, new TextEncoder().encode('kept')]])
      await Bun.write(
        path.join(root, '.vx/workspace.mjs'),
        localWorkspaceSource([
          pluginSource(
            'org/wire',
            `{ cache: () => {
              let token
              return {
                open: async () => { token = 't' },
                has: async (h) => token !== undefined && globalThis.__vxWire.has(h),
                get: async (h) => token !== undefined && globalThis.__vxWire.has(h) ? { body: new Blob([globalThis.__vxWire.get(h)]), durationMs: undefined } : null,
                put: async (h, b) => { if (token !== undefined) globalThis.__vxWire.set(h, new Uint8Array(await b.arrayBuffer())) },
              }
            } }`,
          ),
          pluginSource(
            'org/saver',
            `{ commands: { save: { description: 'saves', async run(argv, ctx) {
               await ctx.artifacts.save('00000000000000aa', {
                 id: 'app#build', projectDir: ctx.workspaceRoot, command: 'true',
                 outputs: { files: [], workspaceFiles: [] },
               }, { output: [{ text: 'ran', err: false }], durationMs: 1 })
               globalThis.__vxCmd = new TextDecoder().decode(await ctx.cache.get('seed'))
               return 0
             } } } }`,
          ),
        ]),
      )
      const was = process.env['CI']
      process.env['CI'] = String(ci)
      try {
        expect(await cli(['save'])).toBe(0)
      } finally {
        if (was === undefined) delete process.env['CI']
        else process.env['CI'] = was
      }
      expect(box.__vxCmd).toBe('kept')
      // Off CI a verb writes no remote, as a run does.
      expect(box.__vxWire.size).toBe(ci ? 2 : 1)
    })
  }

  // `vx <verb> --help` answers from core's reference for a CORE verb only: a
  // plugin verb owns its arguments, `--help` included (docs/cli.md). The
  // gate that says so could go with the suite green (E-10's sweep of the
  // dispatcher): `vx hello --help` would have printed core's reference and
  // never run the plugin.
  it('a plugin verb gets its own --help; a core verb gets the reference', async () => {
    await Bun.write(path.join(root, '.vx/workspace.mjs'), localWorkspaceSource([HELLO]))
    expect(await cli(['hello', '--help'])).toBe(7)
    expect((globalThis as { __vxCmd?: { argv: string[] } }).__vxCmd?.argv).toEqual(['--help'])
    expect(out.join('')).not.toContain('Usage:')
    // CONTROL: a core verb's --help is the reference cut, and exits 0.
    expect(await cli(['show', '--help'])).toBe(0)
    expect(out.join('')).toContain('Usage:\n  vx show')
  })

  // `process.exit(undefined)` is exit 0: a JS-authored verb that forgets its
  // return on a failure branch read as SUCCESS (probed 2026-09-03). The
  // contract is an exit code; a verb that cannot say fails, naming its owner.
  it('a verb that resolves nothing fails plainly instead of reading as success', async () => {
    await Bun.write(
      path.join(root, '.vx/workspace.mjs'),
      localWorkspaceSource([
        pluginSource(
          'org/forgetful',
          `{ commands: {
          noret: { description: 'forgets its return', async run() {} },
          ok: { description: 'control', async run() { return 0 } },
        } }`,
        ),
      ]),
    )
    await expect(cli(['noret'])).rejects.toThrow(
      "plugin 'org/forgetful': command 'noret' resolved undefined instead of an exit code (an integer 0–255)",
    )
    expect(await cli(['ok'])).toBe(0) // CONTROL: an integer passes through
  })

  // The OS keeps an exit status's low eight bits: `process.exitCode = 256`
  // exits 0 (probed on Bun 1.4.2), so a verb returning a count of 256
  // failures read as success, and -1 as 255.
  it('a verb that resolves an integer past a byte fails instead of wrapping', async () => {
    await Bun.write(
      path.join(root, '.vx/workspace.mjs'),
      localWorkspaceSource([
        pluginSource(
          'org/counts',
          `{ commands: {
          many: { description: 'returns a count', async run() { return 256 } },
          below: { description: 'negative', async run() { return -1 } },
          top: { description: 'control', async run() { return 255 } },
        } }`,
        ),
      ]),
    )
    await expect(cli(['many'])).rejects.toThrow(
      "plugin 'org/counts': command 'many' resolved 256 instead of an exit code (an integer 0–255)",
    )
    await expect(cli(['below'])).rejects.toThrow(
      "plugin 'org/counts': command 'below' resolved -1 instead of an exit code (an integer 0–255)",
    )
    expect(await cli(['top'])).toBe(255) // CONTROL: the top of the range passes through
  })

  it('a plugin naming a core verb is refused on every verb, not silently never run', async () => {
    // Core verbs are matched first, so such a verb could never run; it used
    // to load fine and sit dead. The refusal reaches `vx version` too — the
    // workspace load is where every verb meets the plugin list — and names
    // the plugin and the verb.
    await Bun.write(path.join(root, '.vx/workspace.mjs'), localWorkspaceSource([HELLO, SHADOW]))
    const refusal =
      "plugin 'org/shadow' declares command 'version', a core verb — core verbs cannot be shadowed"
    // A plugin verb: the lookup cannot finish, and says why.
    expect(await cli(['hello'])).toBe(1)
    expect(err.join('')).toContain(refusal)
    expect((globalThis as { __vxCmd?: unknown }).__vxCmd).toBeUndefined()
    // A core verb that loads the workspace: refused outright — `run`
    // included, which never goes through the CLI's own loader.
    await expect(cli(['show'])).rejects.toThrow(refusal)
    await expect(cli(['run', 'build', '--all'])).rejects.toThrow(refusal)
  })

  it('two plugins naming the same verb are refused, naming both', async () => {
    // First-declared used to win and the second was never heard of.
    await Bun.write(path.join(root, '.vx/workspace.mjs'), localWorkspaceSource([HELLO, TWICE]))
    const refusal =
      "plugins 'org/hello' and 'org/twice' both declare command 'hello' — a verb has one owner"
    expect(await cli(['hello'])).toBe(1)
    expect(err.join('')).toContain(refusal)
    await expect(cli(['show'])).rejects.toThrow(refusal)
  })

  it('two plugins of one package naming a verb are one owner: the first declared runs, help lists it once', async () => {
    // A package with one plugin per variant carries a verb on each; a
    // workspace declaring two was refused as two owners.
    const SECOND = pluginSource(
      'org/hello',
      `{ commands: { hello: { description: 'second hi', run() { return 8 } } } }`,
    )
    await Bun.write(path.join(root, '.vx/workspace.mjs'), localWorkspaceSource([HELLO, SECOND]))
    expect(await cli(['hello'])).toBe(7)
    expect(await cli(['help'])).toBe(0)
    expect(
      out
        .join('')
        .split('\n')
        .filter((l) => l.includes('vx hello')),
    ).toEqual(['  vx hello             says hi (org/hello)'])
  })

  it("vx help wraps a plugin verb's description under its column, as core's own lines", async () => {
    const LONG = pluginSource(
      'org/long',
      `{ commands: { long: { description: '${'word '.repeat(30).trim()}', run() { return 0 } } } }`,
    )
    await Bun.write(path.join(root, '.vx/workspace.mjs'), localWorkspaceSource([LONG]))
    expect(await cli(['help'])).toBe(0)
    const text = out.join('')
    const section = text.slice(text.indexOf('Plugin commands:\n')).split('\n').slice(1, -1)
    expect(section[0]).toStartWith('  vx long              word word')
    expect(section.length).toBeGreaterThan(1)
    for (const line of section) expect(line.length).toBeLessThanOrEqual(88)
    for (const line of section.slice(1)) expect(line).toMatch(/^ {23}\S/)
    expect(section.join(' ').replace(/\s+/g, ' ')).toContain('word word (org/long)')
  })

  it('an unknown verb is still unknown, and says where help is', async () => {
    await Bun.write(path.join(root, '.vx/workspace.mjs'), localWorkspaceSource([HELLO]))
    expect(await cli(['nope'])).toBe(1)
    expect(err.join('')).toContain('unknown command: nope')
    expect(err.join('')).toContain('see vx help')
    expect(err.join('')).not.toContain('Usage:')
  })

  it('a name Object.prototype holds is no plugin verb', async () => {
    // `plugin.commands[verb]` found the prototype's `toString`, and the
    // dispatcher called its missing `run`: a TypeError, said as the plugin's crash.
    await Bun.write(path.join(root, '.vx/workspace.mjs'), localWorkspaceSource([HELLO]))
    for (const verb of ['toString', 'constructor', '__proto__']) {
      err.length = 0
      expect(await cli([verb])).toBe(1)
      expect(err.join('')).toContain(`unknown command: ${verb}`)
    }
  })

  it('a typo of a PLUGIN verb gets the same "did you mean" a core verb gets', async () => {
    // The verbs this workspace's plugins declare are verbs here, and the
    // lookup that just failed already knows them: `vx helo` in a workspace
    // declaring `hello` read as a plain unknown command (2026-09-20).
    // `hllo`, not `helo`: the latter is one edit from the core verb `help`
    // AND one from `hello`, and a tie goes to whichever list is scanned
    // first — a test that turns on the order of two equal candidates
    // pins nothing.
    await Bun.write(path.join(root, '.vx/workspace.mjs'), localWorkspaceSource([HELLO]))
    expect(await cli(['hllo'])).toBe(1)
    expect(err.join('')).toContain('unknown command: hllo\n\n  see vx help\n\n  fix  hello')
  })

  it('a verb nothing declares says where a verb can come from, and what is declared here', async () => {
    await Bun.write(path.join(root, '.vx/workspace.mjs'), localWorkspaceSource([HELLO]))
    expect(await cli(['zzzzzzzz'])).toBe(1)
    expect(err.join('')).toContain("This workspace's plugins declare: hello\n")
    // The guess is the answer when there is one, so it stands alone.
    err.length = 0
    expect(await cli(['hllo'])).toBe(1)
    expect(err.join('')).not.toContain('plugins declare')
  })

  it('with no plugin verbs at all the note names the file that would declare one', async () => {
    await Bun.write(path.join(root, '.vx/workspace.mjs'), localWorkspaceSource([]))
    expect(await cli(['mcp'])).toBe(1)
    expect(err.join('')).toContain(
      'A plugin declared in .vx/workspace.ts can add verbs; no plugin here adds one\n',
    )
  })

  it('vx help lists plugin verbs with their description and plugin', async () => {
    await Bun.write(path.join(root, '.vx/workspace.mjs'), localWorkspaceSource([HELLO]))
    expect(await cli(['help'])).toBe(0)
    const text = out.join('')
    expect(text).toContain('Plugin commands:')
    expect(text).toContain('vx hello')
    expect(text).toContain('says hi (org/hello)')
    // A plugin verb is a verb here: `vx help hello` is `vx hello --help`,
    // as `vx help run` is `vx run --help`, and `vx help helloo` guesses it.
    out.length = 0
    expect(await cli(['help', 'hello'])).toBe(7)
    expect((globalThis as { __vxCmd?: { argv: string[] } }).__vxCmd?.argv).toEqual(['--help'])
    expect(out.join('')).not.toContain('Plugin commands:')
    err.length = 0
    expect(await cli(['help', 'helloo'])).toBe(1)
    expect(err.join('')).toBe(
      noticed('vx help: unknown command: helloo. Did you mean hello? (see `vx help`)\n'),
    )
  })

  it('a verb only a later plugin declares is found past the ones before it', async () => {
    const OTHER = pluginSource(
      'org/other',
      `{ commands: { other: { description: 'not hello', run() { return 3 } } } }`,
    )
    await Bun.write(path.join(root, '.vx/workspace.mjs'), localWorkspaceSource([OTHER, HELLO]))
    expect(await cli(['hello'])).toBe(7)
  })

  it('two plugins declaring one verb is refused at load, so no verb has two owners', async () => {
    // The help list and the dispatcher lean on this: neither dedups.
    const SHADOW = pluginSource(
      'org/shadow',
      `{ commands: { hello: { description: 'shadowed', run() { return 9 } } } }`,
    )
    await Bun.write(path.join(root, '.vx/workspace.mjs'), localWorkspaceSource([HELLO, SHADOW]))
    expect(await cli(['hello'])).toBe(1)
    expect(err.join('')).toContain(
      "plugins 'org/hello' and 'org/shadow' both declare command 'hello' — a verb has one owner",
    )
  })

  it("a plugin verb's warnings reach stderr, one line each", async () => {
    await Bun.write(
      path.join(root, '.vx/workspace.mjs'),
      localWorkspaceSource([
        pluginSource(
          'org/warner',
          `{ commands: { warn: { description: 'warns', run(argv, ctx) { ctx.warn('careful'); return 0 } } } }`,
        ),
      ]),
    )
    expect(await cli(['warn'])).toBe(0)
    expect(err).toEqual(['careful\n'])
  })

  it('the help line pads the verb to one column', async () => {
    await Bun.write(path.join(root, '.vx/workspace.mjs'), localWorkspaceSource([HELLO]))
    expect(await cli(['help'])).toBe(0)
    expect(out.join('').split('\n')).toContain(`  vx ${'hello'.padEnd(17)} says hi (org/hello)`)
  })

  it('outside a workspace the verb is unknown, not an error about workspaces', async () => {
    const bare = await mkdtemp(path.join(os.tmpdir(), 'vx-bare-'))
    try {
      process.chdir(bare)
      expect(await cli(['hello'])).toBe(1)
      expect(err.join('')).toContain('unknown command: hello')
      // A word no core verb is near gets the note, and it says there is no
      // workspace here rather than claiming one declares nothing.
      err.length = 0
      expect(await cli(['zzzzzzzz'])).toBe(1)
      expect(err.join('')).toContain(
        'A plugin declared in .vx/workspace.ts can add verbs; there is no workspace here\n',
      )
    } finally {
      process.chdir(root)
      await rm(bare, { recursive: true, force: true })
    }
  })

  it('a malformed commands entry is refused by the loader, and the refusal is what the verb reports', async () => {
    await Bun.write(
      path.join(root, '.vx/workspace.mjs'),
      localWorkspaceSource([
        pluginSource('org/bad', `{ commands: { hello: { run() { return 0 } } } }`),
      ]),
    )
    expect(await cli(['hello'])).toBe(1)
    const text = err.join('')
    expect(text).toContain('unknown command: hello')
    expect(text).toMatch(/plugins\[1\]\.commands\.hello/)
    // The load error's message, not its class name in front of it.
    expect(text).toContain(
      `(plugin verbs could not be looked up: .vx/workspace failed to load: ${root}/.vx/workspace.mjs: `,
    )
  })
})

describe('a broken workspace file', () => {
  it('reports the unknown verb AND why plugin verbs could not be looked up', async () => {
    await Bun.write(
      path.join(root, '.vx/workspace.mjs'),
      'export default { plugins: [ this is not javascript\n',
    )
    expect(await cli(['nope'])).toBe(1)
    const text = err.join('')
    expect(text).toContain('unknown command: nope')
    expect(text).toContain('plugin verbs could not be looked up')
    expect(text).toContain('.vx/workspace')
    // Nothing to offer: a broken file declares no verbs to hint at.
    expect(await pluginVerbs(root)).toEqual([])
  })
})

// bin.ts is the one consumer of `isUserError` no in-process test reaches: it
// is the entry, and `process.exit` ends the caller. Driven as a subprocess.
// The plugin's error class is defined INLINE and merely named `UserError` —
// what a plugin importing `@vzn/vx` from node_modules looks like to a
// compiled vx (a different class object). Reproduced through the real binary
// on 2026-09-03: it printed `vx: UserError: …` with a stack.
describe('bin.ts prints a foreign-copy UserError as one line', () => {
  const bin = path.resolve(import.meta.dir, 'helpers/vx-locked.ts')
  function spawn(verb: string): { code: number | null; err: string } {
    const p = Bun.spawnSync({
      cmd: [process.execPath, bin, verb],
      cwd: root,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    return { code: p.exitCode, err: p.stderr.toString() }
  }
  const PLUGIN = pluginSource(
    'org/foreign',
    `{ commands: {
      refuse: { description: 'throws a class merely NAMED UserError', run() {
        class ForeignUserError extends Error { constructor(m) { super(m); this.name = 'UserError' } }
        throw new ForeignUserError('bad flag --x')
      } },
      crash: { description: 'throws a plain Error', run() { throw new Error('kaboom') } },
    },
  }`,
  )

  it('a class named UserError from another copy prints the message only, exit 1', async () => {
    await Bun.write(path.join(root, '.vx/workspace.mjs'), localWorkspaceSource([PLUGIN]))
    const r = spawn('refuse')
    expect(r.code).toBe(1)
    expect(r.err).toBe('✗ vx refuse  bad flag --x\n')
  })

  it('a plain Error names the plugin and verb in one line, as other stages do (E-25)', async () => {
    await Bun.write(path.join(root, '.vx/workspace.mjs'), localWorkspaceSource([PLUGIN]))
    const r = spawn('crash')
    expect(r.code).toBe(1)
    expect(r.err).toBe("✗ vx crash  plugin 'org/foreign' failed in command 'crash': kaboom\n")
  })
})
