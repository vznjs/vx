// docs/schema.md shows most of its config as bare task entries
// (`test: { exec: …, cache: true }`), not whole `defineProject(` files, so
// config-corpus.unsafe.test.ts never loads them. One showed a cached task
// with no `outputs`, a config the loader refuses (2026-11-23). Each such
// sample is handed to the validator here: a task entry, a map of them, or
// an `exec` object. A sample with an elision (`…`) is a sketch, not a config.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'bun:test'
import { validateProjectConfig } from '../src/workspace/project-loader.js'

const DOC = readFileSync(path.join(import.meta.dir, '..', 'docs', 'schema.md'), 'utf8')
const TASK = new Set(['exec', 'inputs', 'outputs', 'dependsOn', 'cache', 'description'])
const EXEC = new Set([
  'command',
  'env',
  'timeout',
  'retries',
  'persistent',
  'interactive',
  'sandbox',
  'remote',
  'platforms',
  'worker',
])

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const within = (o: Obj, keys: Set<string>): boolean =>
  Object.keys(o).length > 0 && Object.keys(o).every((k) => keys.has(k))

const SCRATCH = mkdtempSync(path.join(os.tmpdir(), 'vx-schema-samples-'))
afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }))
let files = 0

/** A fence's object literal, evaluated as a module would, or undefined when it is not one. */
async function literal(body: string): Promise<Obj | undefined> {
  for (const src of [`({${body}})`, `(${body})`]) {
    const file = path.join(SCRATCH, `${files++}.ts`)
    writeFileSync(file, `export default ${src}\n`)
    try {
      const v: unknown = ((await import(file)) as { default: unknown }).default
      if (isObj(v)) return v
    } catch {}
  }
  return undefined
}

/** The project config a sample stands for, or undefined when it shows no task. */
function asConfig(o: Obj): Obj | undefined {
  if (within(o, TASK)) {
    // A fragment (`outputs: { … }` alone) is a part of some task.
    const fragment = !('exec' in o) && !('dependsOn' in o) && !('inputs' in o)
    return { tasks: { t: fragment ? { exec: { command: 'x' }, ...o } : o } }
  }
  if (Object.values(o).every((t) => isObj(t) && within(t, TASK))) return { tasks: o }
  if (within(o, EXEC)) return { tasks: { t: { exec: { command: 'x', ...o } } } }
  return undefined
}

async function samples(doc: string): Promise<Array<{ line: number; config: Obj }>> {
  const out: Array<{ line: number; config: Obj }> = []
  for (const m of doc.matchAll(/^```ts\n([\s\S]*?)^```/gm)) {
    const body = m[1]!
    if (/\b(import|interface|type|function)\b|=>|…/.test(body)) continue
    const o = await literal(body)
    const config = o === undefined ? undefined : asConfig(o)
    if (config !== undefined) out.push({ line: doc.slice(0, m.index).split('\n').length, config })
  }
  return out
}

function refusal(config: Obj): string | null {
  try {
    validateProjectConfig(config as never, '/ws/pkg/vx.config.ts')
    return null
  } catch (err) {
    return (err as Error).message.split('\n')[0]!
  }
}

describe('docs/schema.md task samples load', () => {
  it('reads task entries, task maps and exec objects, and skips sketches', async () => {
    const doc = [
      '```ts\nbuild: { exec: { command: "a" } }\n```',
      '```ts\na: { dependsOn: [] },\nb: { dependsOn: ["a"] },\n```',
      '```ts\nexec: { command: "a", timeout: "1m" }\n```',
      '```ts\noutputs: { files: ["dist/**"] }\n```',
      '```ts\nbuild: { exec: { command: "a" }, cache: true /* … */ }\n```',
      '```ts\ninterface A { x?: string }\n```',
    ].join('\n')
    expect((await samples(doc)).map((s) => Object.keys(s.config.tasks as Obj))).toEqual([
      ['build'],
      ['a', 'b'],
      ['t'],
      ['t'],
    ])
    expect(refusal({ tasks: { t: { exec: { command: 'x' }, cache: true } } })).not.toBeNull()
  })

  it('the validator accepts every one', async () => {
    const all = await samples(DOC)
    expect(all.length).toBeGreaterThan(15)
    const refused = all.flatMap(({ line, config }) => {
      const r = refusal(config)
      return r === null ? [] : [`schema.md:${line} ${r}`]
    })
    expect(refused).toEqual([])
  })
})
