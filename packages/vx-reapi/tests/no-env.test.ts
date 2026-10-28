// Every setting is an option: the plugin reads no environment variable.
// A fallback env var was a second, hidden way to set each option, and it
// switched remote execution on (`VX_REAPI_EXECUTE=1`) with no config change
// to review. `.vx/workspace.ts` names the value: `endpoint:
// process.env.REAPI_ENDPOINT`.
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { expect, it } from 'bun:test'

const src = path.resolve(import.meta.dir, '..', 'src')

function sources(dir: string): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...sources(p))
    else if (e.name.endsWith('.ts')) out.push(p)
  }
  return out
}

/** A source without its comments: one may name an env var it does not read. */
const code = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

it('reads no environment variable', () => {
  const reads = sources(src).flatMap((f) =>
    [
      ...code(readFileSync(f, 'utf8')).matchAll(/(?:process|Bun)\.env\b(?:\.|\[')?([A-Z0-9_]*)/g),
    ].map((m) => `${path.relative(src, f)}: ${m[0]}`),
  )
  expect(reads).toEqual([])
})
