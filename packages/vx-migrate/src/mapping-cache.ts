// A plugin's mapping, kept under the cache dir and keyed on everything it
// reads. Both adoption plugins mapped every package of the workspace on
// every run, when a run asks for a few: nx() ~55 ms cold on refine (206
// projects), turbo() ~43 ms on astro (553). A hit costs the key's reads
// and one JSON parse.
//
// The key is the plugin's own list of what its mapping read, plus this
// package's sources and the core helpers the mappers call: a new
// `@vzn/vx-migrate` or `@vzn/vx` maps afresh.

import { statSync } from 'node:fs'
import { mkdir, rename } from 'node:fs/promises'
import path from 'node:path'
import { foldScriptHooks, isLiteralPattern, outputsOverlap, VERSION } from '@vzn/vx'
import type { Gaps } from './plugin-gaps.js'

/** What the stage uses of a mapping: tags and tasks per package name, and the gaps to report once. */
export interface AdoptionMapping {
  readonly byName: ReadonlyMap<
    string,
    {
      readonly tags?: readonly string[]
      readonly tasks: readonly {
        readonly name: string
        readonly task: Record<string, unknown> | null
      }[]
    }
  >
  readonly gaps: Gaps
}

let code: Promise<string> | undefined

/** This package's sources (by size and mtime) and the core helpers the mappers call, once per process. */
export function codeId(): Promise<string> {
  code ??= (async () => {
    const parts: string[] = [
      VERSION,
      ...[foldScriptHooks, isLiteralPattern, outputsOverlap].map(String),
    ]
    const files: string[] = []
    for await (const f of new Bun.Glob('**/*.{ts,cjs}').scan(import.meta.dir)) files.push(f)
    files.sort()
    // Size and mtime, not bytes: reading the 650 kB of sources cost ~10 ms
    // on every run, more than the mapping hit it guards saves on a small
    // repo (solid, 2026-10-22). An edit moves both.
    for (const f of files) {
      const s = statSync(path.join(import.meta.dir, f))
      parts.push(f, `${s.size}:${s.mtimeMs}`)
    }
    return hex(parts.join('\0'))
  })()
  return code
}

function hex(s: string): string {
  return Bun.hash.xxHash3(s).toString(16).padStart(16, '0')
}

interface Held {
  readonly key: string
  readonly byName: [
    string,
    {
      tags?: readonly string[]
      tasks: { name: string; task: Record<string, unknown> | null }[]
    },
  ][]
  readonly notes: string[]
  readonly todos: [string, string[]][]
  readonly live: string[]
}

/** `map()`, or the mapping it returned last under the same `parts`. */
export async function cachedMapping(
  cacheDir: string,
  name: string,
  parts: readonly string[],
  map: () => Promise<AdoptionMapping>,
): Promise<AdoptionMapping> {
  const file = path.join(cacheDir, `vx-migrate-${name}-mapping.json`)
  const reading = Bun.file(file)
    .json()
    .catch(() => null) as Promise<Held | null>
  const key = hex([await codeId(), ...parts].join('\0'))
  const held = await reading
  if (held?.key === key) {
    return {
      byName: new Map(held.byName),
      gaps: { notes: held.notes, todos: new Map(held.todos), live: held.live },
    }
  }
  const mapping = await map()
  const out: Held = {
    key,
    byName: [...mapping.byName].map(([name, p]) => [
      name,
      {
        ...(p.tags !== undefined ? { tags: p.tags } : {}),
        tasks: p.tasks.map((t) => ({ name: t.name, task: t.task })),
      },
    ]),
    notes: [...mapping.gaps.notes],
    todos: [...mapping.gaps.todos].map(([todo, ids]) => [todo, [...ids]]),
    live: [...mapping.gaps.live],
  }
  // Best-effort, and whole or absent: a reader never sees half a file, and
  // a cache dir it cannot write costs the next run a mapping, not the run.
  const tmp = `${file}.${process.pid}.tmp`
  await mkdir(cacheDir, { recursive: true })
    .then(() => Bun.write(tmp, JSON.stringify(out)))
    .then(() => rename(tmp, file))
    .catch(() => {})
  return mapping
}
