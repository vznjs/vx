// Every object level of a project config refuses a key it does not
// know, naming the level and what it accepts. One level — `exec.env` —
// had no such check until 2026-09-10: `env: { set: { A: 'b' } }` loaded
// and defined nothing, and the task ran without A under a green run. A
// walk over a full config injects an unknown key at each level, so a new
// level cannot ship without the check.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import { validateProjectConfig } from '../src/workspace/index.js'

type Config = Parameters<typeof validateProjectConfig>[0]

/** A config that uses every object level the schema has. */
function full(): Record<string, unknown> {
  return {
    tasks: {
      t: {
        description: 'd',
        dependsOn: ['^t'],
        exec: {
          command: 'true',
          env: { passThrough: ['CI'], define: { A: 'b' } },
          persistent: { readyWhen: 'ready' },
          sandbox: {
            allow: { read: ['x'] },
            deny: { network: ['example.com'] },
            ignore: { read: ['y'] },
            weakerWhenNested: true,
          },
        },
      },
      // A persistent task cannot carry `cache`, so the cache levels ride a
      // second task.
      c: {
        exec: { command: 'true' },
        cache: {
          inputs: { files: ['src/**'], env: ['A'] },
          outputs: { files: ['dist/**'] },
        },
      },
    },
  }
}

/** Every object node of `full()`, as a dotted path (tasks.t.exec.env …). */
function objectPaths(node: unknown, prefix: string, out: string[] = []): string[] {
  if (typeof node !== 'object' || node === null || Array.isArray(node)) return out
  out.push(prefix)
  for (const [k, v] of Object.entries(node)) objectPaths(v, prefix ? `${prefix}.${k}` : k, out)
  return out
}

function inject(config: Record<string, unknown>, dotted: string, key: string): void {
  let node: Record<string, unknown> = config
  for (const seg of dotted.split('.').filter(Boolean)) node = node[seg] as Record<string, unknown>
  node[key] = 1
}

describe('an unknown key is refused at every object level of a config', () => {
  // `define` maps names to values — any key is a name there, not a field.
  const valueMaps = new Set(['tasks', 'tasks.t.exec.env.define'])
  const levels = objectPaths(full(), '').filter((p) => !valueMaps.has(p))

  it('the walk covers every level the schema has', () => {
    expect(levels).toEqual([
      '',
      'tasks.t',
      'tasks.t.exec',
      'tasks.t.exec.env',
      'tasks.t.exec.persistent',
      'tasks.t.exec.sandbox',
      'tasks.t.exec.sandbox.allow',
      'tasks.t.exec.sandbox.deny',
      'tasks.t.exec.sandbox.ignore',
      'tasks.c',
      'tasks.c.exec',
      'tasks.c.cache',
      'tasks.c.cache.inputs',
      'tasks.c.cache.outputs',
    ])

    // The list above pins the FIXTURE — it says what `full()` builds, which
    // is not what the name claims. A level added to the SCHEMA and not to
    // `full()` would leave that list matching and the level unwalked, which
    // is the shape this file exists to prevent. So the claim is read from the
    // schema: every level it guards is an `assertKnownFields` call whose
    // `where` says where the level sits.
    const schema = readFileSync(
      path.resolve(import.meta.dir, '..', 'src', 'workspace', 'config-schema.ts'),
      'utf8',
    )
    const suffixes = [
      ...new Set(
        [...schema.matchAll(/assertKnownFields\([^,]+,\s*\w+,\s*`\$\{where\}([^`]*)`/g)].map(
          (m) => m[1]!,
        ),
      ),
    ]
    expect(suffixes.length).toBeGreaterThan(8)
    expect(suffixes.filter((suffix) => !levels.some((l) => l.endsWith(suffix)))).toEqual([])
    // The two levels whose `where` is a bare identifier rather than a
    // template: the config root, and a task under `tasks`.
    expect(levels).toContain('')
    expect(levels.some((l) => /^tasks\.[^.]+$/.test(l))).toBe(true)
  })

  it('the full config itself validates (the control)', () => {
    expect(() => validateProjectConfig(full() as Config, 'walk')).not.toThrow()
  })

  for (const level of levels) {
    it(`refuses an unknown key at ${level || 'the top'}, naming the level`, () => {
      const config = full()
      inject(config, level, 'zzUnknown')
      let message = ''
      try {
        validateProjectConfig(config as Config, 'walk')
      } catch (err) {
        message = (err as Error).message
      }
      const where = level ? `walk: ${level}` : 'walk'
      expect(message).toStartWith(`${where} has unknown field "zzUnknown" (allowed: `)
      expect(message).not.toContain('undefined')
    })
  }

  it('the env level names the spelling meant when there is one', () => {
    const config = full()
    inject(config, 'tasks.t.exec.env', 'passthrough')
    expect(() => validateProjectConfig(config as Config, 'walk')).toThrow(
      /exec\.env has unknown field "passthrough" \(allowed: define, passThrough\) — did you mean passThrough\?/,
    )
  })
})

describe('an array where an object is expected names the shape, not `unknown field "0"`', () => {
  const withCache = (cache: unknown): Config =>
    ({ tasks: { c: { exec: { command: 'true' }, cache } } }) as unknown as Config

  it('`cache.outputs: [...]` (the Turbo spelling) says what it must be and what was meant', () => {
    expect(() =>
      validateProjectConfig(
        withCache({ inputs: { files: ['src/**'] }, outputs: ['dist/**'] }),
        'f',
      ),
    ).toThrow(
      'f: tasks.c.cache.outputs must be an object (fields: files, workspaceFiles), not an array — did you mean `{ files: [...] }`?',
    )
  })

  it('`cache.inputs: [...]` the same', () => {
    expect(() =>
      validateProjectConfig(withCache({ inputs: ['src/**'], outputs: { files: [] } }), 'f'),
    ).toThrow(
      /tasks\.c\.cache\.inputs must be an object \(fields: .*\), not an array — did you mean `\{ files: \[\.\.\.\] \}`\?/,
    )
  })

  it('a level with no `files` field names its fields and no spelling', () => {
    expect(() =>
      validateProjectConfig({ tasks: { t: { exec: ['true'] } } } as unknown as Config, 'f'),
    ).toThrow(/tasks\.t\.exec must be an object \(fields: command, .*\), not an array$/)
  })

  it('control: the object spelling validates', () => {
    expect(() =>
      validateProjectConfig(
        withCache({ inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] } }),
        'f',
      ),
    ).not.toThrow()
  })
})
