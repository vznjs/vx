// `vx help` and `vx completions` list plugin verbs, and finding them
// imported the orchestrator (~50 ms of a 70 ms `vx help`) even where no
// workspace file exists to declare a plugin. A shell sources
// `vx completions` at every start. Without a `.vx/workspace.*` the lookup
// now skips that import; with one it loads as before.

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'

const SRC = path.resolve(import.meta.dir, '..', 'src')
const TIMEOUT = 30_000

let dir = ''
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'vx-help-lazy-'))
  await writeFile(path.join(dir, 'package.json'), '{"name":"w"}\n')
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** The help lines, and whether the orchestrator's index was imported for them. */
async function helpLines(): Promise<{ lines: string[]; orchestrator: boolean }> {
  const script = path.join(dir, 'probe.ts')
  await writeFile(
    script,
    `let loaded = false
Bun.plugin({
  setup(b) {
    b.onLoad({ filter: /[\\\\/]orchestrator[\\\\/]index\\.ts$/ }, async (a) => {
      loaded = true
      return { contents: await Bun.file(a.path).text(), loader: 'ts' }
    })
  },
})
const { pluginCommandHelp } = await import(${JSON.stringify(path.join(SRC, 'cli', 'plugin-commands.ts'))})
const lines = await pluginCommandHelp(${JSON.stringify(dir)})
console.log(JSON.stringify({ lines, orchestrator: loaded }))
`,
  )
  const p = Bun.spawnSync({ cmd: [process.execPath, script], cwd: dir })
  expect(p.stderr.toString()).toBe('')
  return JSON.parse(p.stdout.toString())
}

it(
  'no workspace file: no plugin verbs, and the orchestrator is not imported',
  async () => {
    expect(await helpLines()).toEqual({ lines: [], orchestrator: false })
  },
  TIMEOUT,
)

it(
  'a workspace file: loaded as before (control)',
  async () => {
    await Bun.write(path.join(dir, '.vx/workspace.mjs'), 'export default {}\n')
    expect(await helpLines()).toEqual({ lines: [], orchestrator: true })
  },
  TIMEOUT,
)

// Core help is written at 80 columns; a plugin verb's entry wrapped at 88,
// so `vx --help` ran wider than a terminal of 80.
it(
  "a plugin verb's long description wraps at 80 columns, as core's entries do",
  async () => {
    await Bun.write(path.join(dir, 'p/package.json'), '{"name":"p"}\n')
    await Bun.write(
      path.join(dir, 'p/index.mjs'),
      `import { definePlugin } from ${JSON.stringify(path.join(SRC, 'index.ts'))}
export default definePlugin(import.meta, { commands: { deploy: { description: ${JSON.stringify(
        'Ship the build to every region the workspace names, then wait for each health check to pass before it says done.',
      )}, run: () => 0 } } })\n`,
    )
    await Bun.write(
      path.join(dir, '.vx/workspace.mjs'),
      "import p from '../p/index.mjs'\nexport default { plugins: [p] }\n",
    )
    const { lines } = await helpLines()
    expect(lines.length).toBeGreaterThan(1)
    expect(lines.filter((l) => l.length > 80)).toEqual([])
  },
  TIMEOUT,
)
