// The environment variables each first-party plugin reads are configured
// in CI, not in a config file: a workflow sets
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
function uncommented(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('//'))
    .join('\n')
}

function envReads(source: string): Set<string> {
  const code = uncommented(source)
  const names = new Set<string>()
  const read =
    /\benv(?:\.([A-Z][A-Z0-9_]*)(?![A-Z0-9_])|\[['"]([A-Z][A-Z0-9_]*)['"]\])(?!\s*=[^=])/g
  for (const m of code.matchAll(read)) names.add(m[1] ?? m[2]!)
  // Through another name (`const vars = Bun.env`, then `vars.X_ON`).
  for (const m of code.matchAll(
    /\b(?:const|let|var)\s+(\w+)(?:\s*:[^=\n]+)?\s*=\s*(?:process|Bun)\.env\b(?!\s*[[.])/g,
  )) {
    if (m[1] === 'env') continue
    const alias = new RegExp(
      `\\b${m[1]}(?:\\.([A-Z][A-Z0-9_]*)(?![A-Z0-9_])|\\[['"]([A-Z][A-Z0-9_]*)['"]\\])(?!\\s*=[^=])`,
      'g',
    )
    for (const r of code.matchAll(alias)) names.add(r[1] ?? r[2]!)
  }
  // Destructured (`const { GITHUB_TOKEN: token, ...rest } = process.env`):
  // vx-dte read four names so that no record held (2026-11-24).
  for (const m of code.matchAll(
    /\b(?:const|let|var)\s*\{([^{}]*)\}\s*=\s*(?:process\.|Bun\.|this\.|\w+\.)?env\b(?!\s*\[)/g,
  ))
    for (const part of m[1]!.split(','))
      if (/^\s*[A-Z][A-Z0-9_]*\s*(?:[:=].*)?$/s.test(part))
        names.add(part.trim().split(/[\s:=]/)[0]!)
  // A read through a variable (`env[name]`, `process.env[envName]`) reads
  // the names the file hands it: a literal passed to a helper
  // (`off('OTEL_TRACES_EXPORTER')`, `read('concurrency', 'TURBO_CONCURRENCY')`)
  // and a name built from a template, recorded with `*` per placeholder
  // (`OTEL_EXPORTER_OTLP_*_PROTOCOL`). Both were missed, so renaming them
  // passed this record. A template pins its shape, not the words its
  // placeholders take.
  if (/\benv\[(?!['"])/.test(code)) {
    for (const m of code.matchAll(
      /(?<![.\w$])[A-Za-z_$][\w$]*\((?:[^()]*?,\s*)?['"]([A-Z][A-Z0-9]*_[A-Z0-9_]+)['"]\s*[,)]/g,
    ))
      names.add(m[1]!)
    for (const m of code.matchAll(/`([A-Z][A-Z0-9_]*(?:\$\{[^}]+\}[A-Z0-9_]*)+)`/g))
      names.add(m[1]!.replace(/\$\{[^}]+\}/g, '*'))
  }
  return names
}

/**
 * A package's reads: each file's, and the literals other files pass to a
 * helper exported by a file that reads `env[name]` through a variable
 * (`export const flag = (name) => env[name] === '1'`, called elsewhere as
 * `flag('X_ON')`), which a file-by-file read saw in neither file.
 */
function packageReads(sources: ReadonlyMap<string, string>): Set<string> {
  const names = new Set<string>()
  const helpers: string[] = []
  for (const source of sources.values()) {
    for (const n of envReads(source)) names.add(n)
    const code = uncommented(source)
    if (!/\benv\[(?!['"])/.test(code)) continue
    for (const m of code.matchAll(
      /\bexport\s+(?:async\s+)?(?:function\s+(\w+)|const\s+(\w+)\s*=)/g,
    ))
      helpers.push(m[1] ?? m[2]!)
  }
  if (helpers.length === 0) return names
  const call = new RegExp(
    `\\b(?:${helpers.join('|')})\\((?:[^()]*?,\\s*)?['"]([A-Z][A-Z0-9]*_[A-Z0-9_]+)['"]\\s*[,)]`,
    'g',
  )
  for (const source of sources.values())
    for (const m of uncommented(source).matchAll(call)) names.add(m[1]!)
  return names
}

function current(): string {
  const lines: string[] = []
  for (const dir of readdirSync(PACKAGES).sort()) {
    const manifest = path.join(PACKAGES, dir, 'package.json')
    if (dir === 'vx' || !existsSync(manifest)) continue
    const pkg = JSON.parse(readFileSync(manifest, 'utf8')) as { name: string; private?: boolean }
    if (pkg.private === true || !existsSync(path.join(PACKAGES, dir, 'src'))) continue
    const names = packageReads(
      new Map(
        sourceFiles(path.join(PACKAGES, dir, 'src')).map((f) => [f, readFileSync(f, 'utf8')]),
      ),
    )
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
    const t = this.env.M_THIRTEEN ?? env.N_FOURTEEN
    env.O_FIFTEEN = 'x'
    // process.env.E_FIVE
    /** env['F_SIX'] */
  `
  expect([...envReads(src)].sort()).toEqual([
    'A_ONE',
    'B_TWO',
    'C_THREE',
    'M_THIRTEEN',
    'N_FOURTEEN',
  ])
  const indirect = `
    const off = (name) => env[name] === 'none'
    off('H_EIGHT')
    read('key', 'I_NINE')
    const k = \`J_\${signal.toUpperCase()}_TEN\`
    warn('K_ELEVEN is set')
    env['L_TWELVE'] = 'x'
    if (err.code?.startsWith('ERR_PARSE_ARGS')) usage()
  `
  expect([...envReads(indirect)].sort()).toEqual(['H_EIGHT', 'I_NINE', 'J_*_TEN'])
  // A method's literal (`code.startsWith('ERR_PARSE_ARGS')`) is no helper's:
  // vx-cache-server's error check was recorded as a read (2026-11-24).
  // CONTROL: without a read through a variable, a literal is only a literal.
  expect([...envReads("read('key', 'I_NINE')")]).toEqual([])
  const destructured = `
    const { P_ONE: a, P_TWO, P_THREE = 'x', ...rest } = process.env
    let {
      Q_ONE: q,
    } = Bun.env
    const { R_ONE } = this.env
    const { s_lower } = process.env
    const { T_ONE } = options
    const vars = Bun.env
    if (vars.V_ONE || vars['V_TWO']) vars.V_THREE = 'x'
  `
  expect([...envReads(destructured)].sort()).toEqual([
    'P_ONE',
    'P_THREE',
    'P_TWO',
    'Q_ONE',
    'R_ONE',
    'V_ONE',
    'V_TWO',
  ])
  const helper = new Map([
    ['flag.ts', "export const flag = (name: string) => process.env[name] === '1'"],
    ['use.ts', "import { flag } from './flag.js'\nif (flag('U_ON')) go()\nother('W_NOT')"],
  ])
  expect([...packageReads(helper)].sort()).toEqual(['U_ON'])
})

it('the plugin packages read the environment tests/contract/plugin-env.txt records', () => {
  const live = current()
  if (update) writeFileSync(RECORD, live)
  expect(live.split('\n').length).toBeGreaterThan(20)
  expect(live).toBe(existsSync(RECORD) ? readFileSync(RECORD, 'utf8') : '')
})
