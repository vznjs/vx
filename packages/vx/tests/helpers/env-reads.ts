// The `VX_*` variables core's source reads: the `process.env` reads
// themselves, not a list a test could agree with. Shared by
// env-doc-drift (the doc) and contract-cli-surface (the record).
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { expect } from 'bun:test'

const pkg = path.resolve(import.meta.dir, '..', '..')

/** Every `.ts` under `src`, walked — a sandboxed shard has no git to ask (darwin CI, 2026-09-23). */
function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...sourceFiles(p))
    else if (e.name.endsWith('.ts')) out.push(p)
  }
  return out
}

export function readInSource(): Set<string> {
  const sources = sourceFiles(path.join(pkg, 'src')).map((f) => readFileSync(f, 'utf8'))
  // A read through a named constant (`process.env[VX_RUN_TASK_ENV]`,
  // exec/env.ts) is a read of the name the constant holds.
  const constants = new Map<string, string>()
  for (const src of sources)
    for (const m of src.matchAll(/const (\w+_ENV) = '(VX_[A-Z0-9_]+)'/g))
      constants.set(m[1]!, m[2]!)
  const names = new Set<string>()
  for (const src of sources) {
    // `Bun.env` is the other spelling; core reads none through it today
    // (exec/sandbox-runtime.ts says why), and a negative is a claim about
    // every spelling (item 618).
    for (const m of src.matchAll(/(?:process|Bun)\.env(?:\.|\[')(VX_[A-Z0-9_]+)/g)) names.add(m[1]!)
    for (const m of src.matchAll(/(?:process|Bun)\.env\[(\w+_ENV)\]/g)) {
      const name = constants.get(m[1]!)
      expect({ constant: m[1], resolved: name !== undefined }).toEqual({
        constant: m[1],
        resolved: true,
      })
      names.add(name!)
    }
  }
  return names
}
