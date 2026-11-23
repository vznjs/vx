// M 2026-11-23 18:46 UTC: "Every field from all config should be
// documented and explained". Every field the validator accepts
// (tests/contract/config-schema.json) has its own entry in docs/schema.md,
// the config reference the site imports: a heading that names it, or a
// table row that names it and says something about it. A heading's path is
// its ancestors' joined, so `#### \`timeout\`` under `### \`exec\`` is
// `exec.timeout`.
//
// NOT_YET is the day's to-do (docs redo, 2026-11-24): it may only shrink.
// A field listed here that gains an entry fails too, so the list stays true.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { expect, it } from 'bun:test'

const DOC = readFileSync(path.join(import.meta.dir, '..', 'docs', 'schema.md'), 'utf8')
const RECORD = JSON.parse(
  readFileSync(path.join(import.meta.dir, 'contract', 'config-schema.json'), 'utf8'),
) as Record<'workspace' | 'project', { levels: Record<string, string[]> }>

const NOT_YET = new Set([
  'workspace:history',
  'workspace:lock',
  'workspace:pipelines',
  'workspace:plugins',
  'workspace:run',
  'workspace:run.logs',
  'workspace:run.rules',
  'workspace:run.secrets',
  'workspace:run.rules.dependencies',
  'workspace:cache.concurrency',
  'workspace:cache.store',
  'workspace:cache.upload',
  'workspace:pipelines.*.affected',
  'workspace:pipelines.*.branch',
  'workspace:pipelines.*.cacheConcurrencyDownload',
  'workspace:pipelines.*.cacheConcurrencyRestore',
  'workspace:pipelines.*.cacheConcurrencyUpload',
  'workspace:pipelines.*.cacheDir',
  'workspace:pipelines.*.cacheDownload',
  'workspace:pipelines.*.cachePolicy',
  'workspace:pipelines.*.concurrency',
  'workspace:pipelines.*.dry',
  'workspace:pipelines.*.env',
  'workspace:pipelines.*.excludeDependencies',
  'workspace:pipelines.*.failFast',
  'workspace:pipelines.*.filter',
  'workspace:pipelines.*.force',
  'workspace:pipelines.*.format',
  'workspace:pipelines.*.noCache',
  'workspace:pipelines.*.outputLogs',
  'workspace:pipelines.*.profile',
  'workspace:pipelines.*.retries',
  'workspace:pipelines.*.schedule',
  'workspace:pipelines.*.tasks',
  'workspace:pipelines.*.timeout',
  'workspace:pipelines.*.verbosity',
  'project:name',
  'project:tags',
  'project:exec.command',
  'project:exec.env',
  'project:exec.env.define',
  'project:exec.env.passThrough',
  'project:exec.env.secret',
  'project:exec.persistent.readyWhen',
  'project:exec.sandbox.allow',
  'project:exec.sandbox.deny',
  'project:exec.sandbox.hermetic',
  'project:exec.sandbox.ignore',
  'project:exec.sandbox.weakerNetworkIsolation',
  'project:exec.sandbox.weakerWhenNested',
  'project:exec.sandbox.allow.gitConfig',
  'project:exec.sandbox.allow.localBinding',
  'project:exec.sandbox.allow.machLookup',
  'project:exec.sandbox.allow.network',
  'project:exec.sandbox.allow.pty',
  'project:exec.sandbox.allow.read',
  'project:exec.sandbox.allow.systemInfo',
  'project:exec.sandbox.allow.unixSockets',
  'project:exec.sandbox.allow.write',
  'project:exec.sandbox.deny.network',
  'project:exec.sandbox.ignore.network',
  'project:exec.sandbox.ignore.read',
  'project:exec.sandbox.ignore.systemInfo',
  'project:exec.sandbox.ignore.write',
  'project:outputs.files',
])

const join = (base: string, name: string): string =>
  !base || name.startsWith(`${base}.`) ? name : `${base}.${name}`

/** Every field path the reference gives an entry. */
function entries(doc: string): Set<string> {
  const found = new Set<string>()
  let stack: Array<[depth: number, path: string]> = []
  let fence = false
  for (const line of doc.split('\n')) {
    if (line.startsWith('```')) fence = !fence
    if (fence || line.startsWith('```')) continue
    const h = /^(#+) (.*)/.exec(line)
    if (h) {
      const depth = h[1]!.length
      const name = /`([\w.*]+)`/.exec(h[2]!)?.[1]
      stack = stack.filter(([d]) => d < depth)
      const base = stack.at(-1)?.[1] ?? ''
      const p = name === undefined ? base : join(base, name)
      stack.push([depth, p])
      found.add(p)
      continue
    }
    const row = /^\|\s*`([\w.]+)`[^|]*\|\s*[^|\s-]/.exec(line)
    if (row) {
      found.add(join(stack.at(-1)?.[1] ?? '', row[1]!))
      found.add(row[1]!)
    }
  }
  return found
}

function fields(): string[] {
  const out: string[] = []
  for (const [config, { levels }] of Object.entries(RECORD))
    for (const [level, names] of Object.entries(levels)) {
      const prefix = level.replace(/^tasks\.\*\.?/, '')
      for (const f of names) out.push(`${config}:${prefix ? `${prefix}.${f}` : f}`)
    }
  return out
}

const explained = (field: string, found: Set<string>): boolean => {
  const p = field.slice(field.indexOf(':') + 1)
  return [...found].some((x) => x === p || x.endsWith(`.${p}`))
}

it('gives every config field an entry in the config reference', () => {
  const found = entries(DOC)
  const missing = fields().filter((f) => !explained(f, found) && !NOT_YET.has(f))
  expect(missing).toEqual([])
})

it('lists in NOT_YET only fields still without an entry', () => {
  const found = entries(DOC)
  const done = [...NOT_YET].filter((f) => explained(f, found) || !fields().includes(f))
  expect(done).toEqual([])
})
