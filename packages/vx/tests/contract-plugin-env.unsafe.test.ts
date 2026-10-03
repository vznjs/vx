// The environment variables each first-party plugin reads are configured
// in CI, not in a config file: a workflow sets `VX_REAPI_ENDPOINT`,
// `OTEL_EXPORTER_OTLP_ENDPOINT`, `GITHUB_TOKEN` or `TURBO_TOKEN`, and a
// release that renamed one would drop the remote or the exporter with no
// config change to review. Core's `VX_*` reads are held by
// contract-cli-surface; nothing held the plugins'. The record is
// `tests/contract/plugin-env.txt`, one `<package> <NAME>` line per read,
// found in each package's source (the reads themselves, not a list), and
// the break law reads it by lost lines.
//
// `.unsafe`: it reads other packages, which a sandboxed task cannot.
//
// Regenerate after a deliberate change, then review the diff:
//   VX_UPDATE_CONTRACT=1 bun test tests/contract-plugin-env.unsafe.test.ts

import { expect, it } from 'bun:test'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const PACKAGES = path.resolve(import.meta.dir, '..', '..')
const RECORD = path.join(import.meta.dir, 'contract', 'plugin-env.txt')

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...sourceFiles(p))
    else if (/\.(ts|cjs|mjs|js)$/.test(e.name)) out.push(p)
  }
  return out
}

/**
 * The names a source reads from the environment: `process.env` / `Bun.env`
 * by name, and `env['NAME']` through the `env` a plugin takes (each
 * defaults to or is passed the process's). A write (`env['PORT'] = …`,
 * a task's env being built) is not a read; comments are not code.
 */
function envReads(source: string): Set<string> {
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('//'))
    .join('\n')
  const names = new Set<string>()
  const read =
    /(?:(?:process|Bun)\.env\.([A-Z][A-Z0-9_]*)(?![A-Z0-9_])|\benv\[['"]([A-Z][A-Z0-9_]*)['"]\])(?!\s*=[^=])/g
  for (const m of code.matchAll(read)) names.add(m[1] ?? m[2]!)
  // A read through a variable (`env[name]`, `process.env[envName]`) reads
  // the names the file hands it: a literal passed to a helper
  // (`off('OTEL_TRACES_EXPORTER')`, `read('concurrency', 'TURBO_CONCURRENCY')`)
  // and a name built from a template, recorded with `*` per placeholder
  // (`OTEL_EXPORTER_OTLP_*_PROTOCOL`). Both were missed, so renaming them
  // passed this record. A template pins its shape, not the words its
  // placeholders take.
  if (/\benv\[(?!['"])/.test(code)) {
    for (const m of code.matchAll(
      /\w\((?:[^()]*?,\s*)?['"]([A-Z][A-Z0-9]*_[A-Z0-9_]+)['"]\s*[,)]/g,
    ))
      names.add(m[1]!)
    for (const m of code.matchAll(/`([A-Z][A-Z0-9_]*(?:\$\{[^}]+\}[A-Z0-9_]*)+)`/g))
      names.add(m[1]!.replace(/\$\{[^}]+\}/g, '*'))
  }
  return names
}

function current(): string {
  const lines: string[] = []
  for (const dir of readdirSync(PACKAGES).sort()) {
    const manifest = path.join(PACKAGES, dir, 'package.json')
    if (dir === 'vx' || !existsSync(manifest)) continue
    const pkg = JSON.parse(readFileSync(manifest, 'utf8')) as { name: string; private?: boolean }
    if (pkg.private === true || !existsSync(path.join(PACKAGES, dir, 'src'))) continue
    const names = new Set<string>()
    for (const f of sourceFiles(path.join(PACKAGES, dir, 'src')))
      for (const n of envReads(readFileSync(f, 'utf8'))) names.add(n)
    for (const n of [...names].sort()) lines.push(`${pkg.name} ${n}`)
  }
  return lines.join('\n') + '\n'
}

const update = process.env['VX_UPDATE_CONTRACT'] === '1' && process.env['CI'] !== 'true'

it('the reader finds reads, and skips writes and comments', () => {
  const src = `
    const a = process.env.A_ONE ?? Bun.env['B_TWO']
    if (env['C_THREE'] === 'x') env['D_FOUR'] = '1'
    process.env.G_SEVEN = 'x'
    // process.env.E_FIVE
    /** env['F_SIX'] */
  `
  expect([...envReads(src)].sort()).toEqual(['A_ONE', 'B_TWO', 'C_THREE'])
  const indirect = `
    const off = (name) => env[name] === 'none'
    off('H_EIGHT')
    read('key', 'I_NINE')
    const k = \`J_\${signal.toUpperCase()}_TEN\`
    warn('K_ELEVEN is set')
    env['L_TWELVE'] = 'x'
  `
  expect([...envReads(indirect)].sort()).toEqual(['H_EIGHT', 'I_NINE', 'J_*_TEN'])
  // CONTROL: without a read through a variable, a literal is only a literal.
  expect([...envReads("read('key', 'I_NINE')")]).toEqual([])
})

it('the plugin packages read the environment tests/contract/plugin-env.txt records', () => {
  const live = current()
  if (update) writeFileSync(RECORD, live)
  expect(live.split('\n').length).toBeGreaterThan(20)
  expect(live).toBe(existsSync(RECORD) ? readFileSync(RECORD, 'utf8') : '')
})
