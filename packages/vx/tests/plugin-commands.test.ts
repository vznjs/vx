// `VxPlugin.commands` — verbs a plugin adds to the CLI. Driven through the
// real dispatcher (`cli/index.ts run`) from inside a workspace whose
// vx.workspace.mjs declares the plugin inline.
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { run as cli } from '../src/cli/index.js'
import { localWorkspaceSource } from './helpers/local-workspace.js'

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

const HELLO = `{
  name: 'org/hello',
  commands: {
    hello: {
      description: 'says hi',
      run(argv, ctx) {
        globalThis.__vxCmd = { argv: [...argv], root: ctx.workspaceRoot, cacheDir: ctx.cacheDir }
        return 7
      },
    },
    version: { description: 'never runs — core owns this verb', run() { globalThis.__vxCmd = 'shadowed'; return 9 } },
  },
}`

describe('plugin commands', () => {
  it('a plugin verb runs with its argv and a workspace context, and its exit code is the result', async () => {
    await Bun.write(path.join(root, 'vx.workspace.mjs'), localWorkspaceSource([HELLO]))
    const code = await cli(['hello', 'world', '--flag'])
    expect(code).toBe(7)
    expect((globalThis as { __vxCmd?: unknown }).__vxCmd).toEqual({
      argv: ['world', '--flag'],
      root,
      cacheDir: path.join(root, '.vx', 'cache'),
    })
    expect(err.join('')).not.toContain('unknown command')
  })

  it("core's verbs win — a plugin naming `version` never runs", async () => {
    await Bun.write(path.join(root, 'vx.workspace.mjs'), localWorkspaceSource([HELLO]))
    expect(await cli(['version'])).toBe(0)
    expect(out.join('')).toMatch(/^vx \d/)
    expect((globalThis as { __vxCmd?: unknown }).__vxCmd).toBeUndefined()
  })

  it('an unknown verb is still unknown, with the help text', async () => {
    await Bun.write(path.join(root, 'vx.workspace.mjs'), localWorkspaceSource([HELLO]))
    expect(await cli(['nope'])).toBe(1)
    expect(err.join('')).toContain('unknown command: nope')
  })

  it('vx help lists plugin verbs with their description and plugin', async () => {
    await Bun.write(path.join(root, 'vx.workspace.mjs'), localWorkspaceSource([HELLO]))
    expect(await cli(['help'])).toBe(0)
    const text = out.join('')
    expect(text).toContain('Plugin commands:')
    expect(text).toContain('vx hello')
    expect(text).toContain('says hi (org/hello)')
  })

  it('outside a workspace the verb is unknown, not an error about workspaces', async () => {
    const bare = await mkdtemp(path.join(os.tmpdir(), 'vx-bare-'))
    try {
      process.chdir(bare)
      expect(await cli(['hello'])).toBe(1)
      expect(err.join('')).toContain('unknown command: hello')
    } finally {
      process.chdir(root)
      await rm(bare, { recursive: true, force: true })
    }
  })

  it('a malformed commands entry is refused by the loader, naming it', async () => {
    await Bun.write(
      path.join(root, 'vx.workspace.mjs'),
      localWorkspaceSource([`{ name: 'org/bad', commands: { hello: { run() { return 0 } } } }`]),
    )
    await expect(cli(['hello'])).rejects.toThrow(/plugins\[0\]\.commands\.hello/)
  })
})
