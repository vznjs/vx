// docs/schema.md publishes a table of validation errors: the exact symptom a
// user sees, and what causes it. Nothing pinned that the loader still emits
// those strings, so the table could drift silently — and a docs table that
// lies is worse than no table, because a user greps it for the message they
// just got and concludes vx did something else.
//
// This has been a recurring class here: `docs/cli.md` promised `=` flag forms
// the parser rejected, and `docs/caching.md` claimed a hashing property that
// had become false. Both were found by reading, not by a test.
//
// The guard is driven BY THE TABLE: it parses the rows out of the markdown and
// requires every one to have a case below that provokes it. So a new row
// cannot land unpinned, and a removed row fails until its case goes too.

import { describe, expect, it } from 'bun:test'
import path from 'node:path'
import {
  loadProjectConfig,
  loadWorkspaceConfig,
  validateProjectConfig,
} from '../src/workspace/project-loader.js'
import { loadWorkspace } from '../src/workspace/workspace.js'

const CONFIG_PATH = '/ws/pkg/vx.config.ts'

/** Run the real validator and return the message, or null if it accepted. */
function validated(config: unknown): string | null {
  try {
    validateProjectConfig(config as never, CONFIG_PATH)
    return null
  } catch (err) {
    return (err as Error).message
  }
}

const ok = { exec: { command: 'x' } }

/**
 * The table renders each message inside a markdown code span, so the backticks
 * the real messages put around identifiers (`cache`, `exec`, `dependsOn`) are
 * dropped rather than escaped with the doubled-delimiter form. Compare with
 * them stripped: what drifts is the wording, not the punctuation.
 */
function normalize(s: string): string {
  return s.replaceAll('`', '')
}

/** [row as printed in docs/schema.md, something that provokes it] */
const CASES: Array<[string, () => string | null | Promise<string | null>]> = [
  [
    'did not export a default object',
    // Raised by the loader, not the validator — a config file whose default
    // export is not an object never reaches validation at all.
    async () => {
      const dir = path.join(process.env['TMPDIR'] ?? '/tmp', `vx-drift-${Bun.randomUUIDv7()}`)
      const file = path.join(dir, 'vx.config.ts')
      await Bun.write(file, 'export default 42\n')
      try {
        await loadProjectConfig(file)
        return null
      } catch (err) {
        return (err as Error).message
      }
    },
  ],
  ['tasks must be an object keyed by task name', () => validated({ tasks: [ok] })],
  ['<level> has unknown field "<key>"', () => validated({ tasks: { b: { ...ok, caches: {} } } })],
  ['tasks.<name> must be an object', () => validated({ tasks: { b: 'not-an-object' } })],
  [
    'exec must be an object with a command string',
    () => validated({ tasks: { b: { exec: 'build' } } }),
  ],
  [
    'exec.command must be a non-empty string',
    () => validated({ tasks: { b: { exec: { command: '' } } } }),
  ],
  [
    'exec.persistent must be an object (or omitted)',
    () => validated({ tasks: { b: { exec: { command: 'x', persistent: 'yes' } } } }),
  ],
  [
    'exec.persistent.readyWhen must be a string regex',
    () => validated({ tasks: { b: { exec: { command: 'x', persistent: { readyWhen: 42 } } } } }),
  ],
  [
    'cache is not allowed on a persistent task',
    () =>
      validated({
        tasks: {
          b: {
            exec: { command: 'x', persistent: {} },
            cache: { inputs: { files: [] }, outputs: { files: [] } },
          },
        },
      }),
  ],
  ['a task with no exec must declare dependsOn', () => validated({ tasks: { b: {} } })],
  [
    'cache requires exec',
    () =>
      validated({
        tasks: {
          b: { dependsOn: ['o'], cache: { inputs: { files: [] }, outputs: { files: [] } } },
        },
      }),
  ],
  [
    'dependsOn must be an array of strings',
    () => validated({ tasks: { b: { ...ok, dependsOn: 'build' } } }),
  ],
  [
    'cache.inputs is required when cache is set',
    () => validated({ tasks: { b: { ...ok, cache: { outputs: { files: [] } } } } }),
  ],
  [
    'cache.inputs.files must be an array',
    () =>
      validated({
        tasks: { b: { ...ok, cache: { inputs: { files: 'src/**' }, outputs: { files: [] } } } },
      }),
  ],
  [
    'cache.inputs.runtime must be an array of non-empty shell command strings',
    () =>
      validated({
        tasks: {
          b: { ...ok, cache: { inputs: { files: [], runtime: [''] }, outputs: { files: [] } } },
        },
      }),
  ],
  [
    'cache.inputs.workspaceRuntime must be an array of non-empty shell command strings',
    () =>
      validated({
        tasks: {
          b: {
            ...ok,
            cache: { inputs: { files: [], workspaceRuntime: [42] }, outputs: { files: [] } },
          },
        },
      }),
  ],
  [
    'cache.inputs.tasks must be an array of non-empty strings',
    () =>
      validated({
        tasks: {
          b: { ...ok, cache: { inputs: { files: [], tasks: '^build' }, outputs: { files: [] } } },
        },
      }),
  ],
  [
    'cache.outputs is required when cache is set',
    () => validated({ tasks: { b: { ...ok, cache: { inputs: { files: [] } } } } }),
  ],
  [
    'cache.outputs.files must be an array',
    () =>
      validated({
        tasks: { b: { ...ok, cache: { inputs: { files: [] }, outputs: { files: {} } } } },
      }),
  ],
  [
    // Both refusals below turn a config that silently selected NOTHING into a
    // loud error, so the message is what a user greps when their build starts
    // failing at load time.
    'cache.inputs.files: every entry is a negation, which selects NOTHING',
    () =>
      validated({
        tasks: {
          b: { ...ok, cache: { inputs: { files: ['!**/*.spec.ts'] }, outputs: { files: [] } } },
        },
      }),
  ],
  [
    'cache.outputs.files: negation is not supported',
    () =>
      validated({
        tasks: {
          b: { ...ok, cache: { inputs: { files: [] }, outputs: { files: ['!dist/x'] } } },
        },
      }),
  ],
  ['description must be a string', () => validated({ tasks: { b: { ...ok, description: 42 } } })],
]

/**
 * The Symptom column of the FIRST table at or after `anchor`. Each table gets
 * its own anchor rather than one scan to EOF, so a row can never be counted
 * against the wrong surface.
 */
async function documentedRows(anchor: string): Promise<string[]> {
  const doc = await Bun.file(new URL('../docs/schema.md', import.meta.url).pathname).text()
  const at = doc.indexOf(anchor)
  expect(at).toBeGreaterThan(-1)
  const rows: string[] = []
  for (const line of doc.slice(at).split('\n')) {
    if (line.startsWith('| `')) {
      rows.push(normalize(line.slice(1, line.indexOf('|', 1)).trim()))
      continue
    }
    // Past the header/separator, the first non-row line ends the table.
    if (rows.length > 0) break
  }
  return rows
}

/** Write `files` into a fresh temp dir and return its path. */
async function tempRoot(files: Record<string, string>): Promise<string> {
  const dir = path.join(process.env['TMPDIR'] ?? '/tmp', `vx-drift-${Bun.randomUUIDv7()}`)
  for (const [rel, content] of Object.entries(files)) await Bun.write(path.join(dir, rel), content)
  return dir
}

/** Run `fn` against a temp workspace and return the message, or null. */
async function failure(
  files: Record<string, string>,
  fn: (root: string) => Promise<unknown>,
): Promise<string | null> {
  try {
    await fn(await tempRoot(files))
    return null
  } catch (err) {
    return (err as Error).message
  }
}

const DISCOVERY_CASES: Array<[string, () => Promise<string | null>]> = [
  [
    'failed to parse <file>: <why>',
    () => failure({ 'pnpm-workspace.yaml': 'packages: [\n' }, loadWorkspace),
  ],
  [
    '<file>: packages must be an array of glob strings',
    () => failure({ 'pnpm-workspace.yaml': 'packages: "packages/*"\n' }, loadWorkspace),
  ],
  [
    '<file>: workspaces must be an array of glob strings',
    () => failure({ 'package.json': '{"name":"r","workspaces":[1]}' }, loadWorkspace),
  ],
  [
    '<file>: workspaces.packages must be an array of glob strings',
    () => failure({ 'package.json': '{"name":"r","workspaces":{"packages":"x"}}' }, loadWorkspace),
  ],
]

/** A `vx.workspace.ts` exporting `body`, loaded through the real loader. */
function workspaceConfig(body: string): () => Promise<string | null> {
  return () => failure({ 'vx.workspace.ts': `export default ${body}\n` }, loadWorkspaceConfig)
}

const WORKSPACE_CASES: Array<[string, () => Promise<string | null>]> = [
  ['concurrency must be a positive integer', workspaceConfig('{ concurrency: 0 }')],
  ['timeout must be a positive integer (milliseconds)', workspaceConfig('{ timeout: -1 }')],
  ['cacheDir must be a string', workspaceConfig('{ cacheDir: 42 }')],
  ['plugins must be an array of plugin objects', workspaceConfig('{ plugins: {} }')],
  ['plugins[<i>] must be an object', workspaceConfig('{ plugins: ["nope"] }')],
  ['plugins[<i>].name must be a non-empty string', workspaceConfig('{ plugins: [{ name: "" }] }')],
  [
    'plugins[<i>].<capability> must be a function',
    workspaceConfig('{ plugins: [{ name: "p", setup: 1 }] }'),
  ],
  [
    'plugins[<i>] must contribute at least one of setup/backend/cache/telemetry/eventSink',
    workspaceConfig('{ plugins: [{ name: "p" }] }'),
  ],
  ['predictive must be a boolean', workspaceConfig('{ predictive: "yes" }')],
]

/**
 * One table's worth of assertions: the documented set matches the pinned set
 * exactly, and each case really provokes its row.
 */
function pinTable(
  title: string,
  anchor: string,
  cases: Array<[string, () => string | null | Promise<string | null>]>,
): void {
  describe(title, () => {
    it('documents exactly the symptoms pinned here — no more, no fewer', async () => {
      // Both directions at once: an undocumented case, or a documented row with
      // nothing provoking it, fails and names itself.
      const documented = await documentedRows(anchor)
      expect(documented.length).toBeGreaterThan(0)
      expect([...documented].sort()).toEqual(cases.map(([row]) => row).sort())
    })

    for (const [row, trigger] of cases) {
      it(`emits the documented symptom: ${row}`, async () => {
        const message = await trigger()
        expect(message).not.toBeNull()
        // A row may carry <placeholders> for the part that varies by input;
        // every literal segment around them must still appear.
        for (const segment of row.split(/<[^>]+>/)) {
          const literal = segment.trim()
          if (literal.length > 0) expect(normalize(message ?? '')).toContain(literal)
        }
      })
    }
  })
}

pinTable(
  'docs/schema.md task-validation table matches the loader',
  '## Schema validation errors',
  CASES,
)
pinTable(
  'docs/schema.md workspace-discovery table matches the loader',
  'Workspace-discovery errors',
  DISCOVERY_CASES,
)
pinTable(
  'docs/schema.md workspace-config table matches the loader',
  'Workspace-config errors:',
  WORKSPACE_CASES,
)

describe('docs/schema.md unknown-field rejection', () => {
  it('names the key AND what that level accepts', () => {
    // The value of rejecting unknown keys is that the message is actionable —
    // a bare "unknown field" leaves a user guessing which spelling was right.
    const message = validated({
      tasks: { b: { ...ok, cache: { inputs: { files: [], workspaceFile: [] }, outputs: {} } } },
    })
    expect(message).toContain('workspaceFile')
    expect(message).toContain('workspaceFiles')
  })
})
