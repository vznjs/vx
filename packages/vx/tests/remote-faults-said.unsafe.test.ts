// A remote's fault is at least a warning (2026-10-23). Vercel answered a
// batch query of 107 hashes with 400 "Too many hashes. Limit is 100.", the
// cache plugin read it as no answer, and DTE sized a run for every task with
// nothing said. In code that talks to a remote (a cache, an executor, the
// relay, a CI API), a handler that drops its error says it (a warn, a throw,
// `failed`, `unsent`) or names why it may stay quiet in a `// quiet:` comment
// at most three lines above. Unsafe: it reads other packages.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { expect, it } from 'bun:test'

const repo = path.resolve(import.meta.dir, '..', '..', '..')

const REMOTE = [
  /^packages\/vx\/src\/cache\/(?:remote-lane|layered-cache|plugin-cache)\.ts$/,
  /^packages\/vx\/src\/orchestrator\/task-artifacts\.ts$/,
  /^packages\/vx-migrate\/src\/(?:turbo-cache|nx-cache)\/.+\.ts$/,
  /^packages\/vx-migrate\/src\/remote-[^/]+\.ts$/,
  /^packages\/vx-reapi\/src\/.+\.ts$/,
  /^packages\/vx-dte\/src\/.+\.ts$/,
  /^packages\/vx-otel\/src\/.+\.ts$/,
  /^packages\/vx-ci\/src\/(?:checks|gitlab)\.ts$/,
  // The cache and history clients and every server: each talks to a remote.
  /^packages\/vx-(?:cache|history)\/src\/.+\.ts$/,
  /^packages\/vx-(?:cache|history|dte)-server\/src\/.+\.ts$/,
  /^packages\/vx-devtools\/src\/.+\.ts$/,
]
/** A handler that takes no error: it cannot say one. */
const DROPS = /\.catch\(\(\) =>|\bcatch \{/
const SAYS = /\bquiet:|\bwarn\w*\(|\bfailed\(|\bunsent\w*\(|\bonWarn\(|\bonError\(|\bthrow\b/

function remoteFiles(): string[] {
  const ls = Bun.spawnSync(['git', 'ls-files', '-z', 'packages'], { cwd: repo })
  return ls.stdout
    .toString()
    .split('\0')
    .filter((f) => REMOTE.some((r) => r.test(f)))
}

/** `file:line` of each handler that drops its error unsaid. */
function unsaid(file: string, text: string): string[] {
  const lines = text.split('\n')
  const out: string[] = []
  lines.forEach((line, i) => {
    if (!DROPS.test(line)) return
    const near = lines.slice(Math.max(0, i - 3), i + 3).join('\n')
    if (!SAYS.test(near)) out.push(`${file}:${i + 1}`)
  })
  return out
}

it('the law sees what it guards', () => {
  expect(remoteFiles().length).toBeGreaterThan(40)
  expect(unsaid('x.ts', 'const ok = await res.json().catch(() => null)')).toEqual(['x.ts:1'])
  expect(
    unsaid('x.ts', '// quiet: the status names it\nconst ok = await res.json().catch(() => null)'),
  ).toEqual([])
  expect(unsaid('x.ts', 'try {\n  a()\n} catch {\n  return null\n}')).toEqual(['x.ts:3'])
})

it('every remote fault a handler drops is said, or says why not', () => {
  const found = remoteFiles().flatMap((f) => unsaid(f, readFileSync(path.join(repo, f), 'utf8')))
  expect(found).toEqual([])
})
