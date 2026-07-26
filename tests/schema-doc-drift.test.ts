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
import { loadProjectConfig, validateProjectConfig } from '../src/workspace/project-loader.js'

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
  ['description must be a string', () => validated({ tasks: { b: { ...ok, description: 42 } } })],
]

/**
 * The Symptom column of the FIRST table under `## Schema validation errors` —
 * the per-task one. Later sections carry their own tables (workspace discovery,
 * `defineWorkspace`); those are a separate surface and out of scope here, so
 * the scan stops at the end of this table rather than running to EOF.
 */
async function documentedRows(): Promise<string[]> {
  const doc = await Bun.file(new URL('../docs/schema.md', import.meta.url).pathname).text()
  const section = doc.slice(doc.indexOf('## Schema validation errors'))
  const rows: string[] = []
  for (const line of section.split('\n')) {
    if (line.startsWith('| `')) {
      rows.push(normalize(line.slice(1, line.indexOf('|', 1)).trim()))
      continue
    }
    // Past the header/separator, the first non-row line ends the table.
    if (rows.length > 0) break
  }
  return rows
}

describe('docs/schema.md task-validation table matches the loader', () => {
  it('documents exactly the symptoms pinned here — no more, no fewer', async () => {
    // Both directions at once: an undocumented case, or a documented row with
    // nothing provoking it, fails and names itself.
    const documented = await documentedRows()
    expect(documented.length).toBeGreaterThan(0)
    expect([...documented].sort()).toEqual(CASES.map(([row]) => row).sort())
  })

  for (const [row, trigger] of CASES) {
    it(`emits the documented symptom: ${row}`, async () => {
      const message = await trigger()
      expect(message).not.toBeNull()
      // A row may carry <placeholders> for the part that varies by config;
      // every literal segment around them must still appear.
      for (const segment of row.split(/<[^>]+>/)) {
        const literal = segment.trim()
        if (literal.length > 0) expect(normalize(message ?? '')).toContain(literal)
      }
    })
  }

  it('the unknown-field error names the key AND what that level accepts', () => {
    // The value of rejecting unknown keys is that the message is actionable —
    // a bare "unknown field" leaves a user guessing which spelling was right.
    const message = validated({
      tasks: { b: { ...ok, cache: { inputs: { files: [], workspaceFile: [] }, outputs: {} } } },
    })
    expect(message).toContain('workspaceFile')
    expect(message).toContain('workspaceFiles')
  })
})
