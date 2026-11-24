// Every test file in this repo is run by some task.
//
// A skip at least prints itself. A file no task names prints nothing: the
// gate is `vx pipeline queue`, and a suite it never launches is green by
// omission. Three of the commands that launch suites here look only at the
// TOP level of a `tests/` directory — the shard dealer `readdirSync`s it,
// the unsafe task globs `./tests/*.unsafe.test.ts`, and vx-reapi loops over
// `tests/*.test.ts` — so a suite written one directory down
// (`tests/reapi/wire.test.ts`) would be launched by nothing at all, in the
// package whose own suite is its `test` task.
//
// The commands are read from the configs themselves rather than restated,
// so a package that changes how it launches its tests is measured by what
// it now does.
//
// `.unsafe`: it reads every package, which the cross-project law forbids a
// sandboxed task.

import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import { testFiles } from '../scripts/test-shard.js'

const repo = path.resolve(import.meta.dir, '..', '..', '..')
const packagesDir = path.join(repo, 'packages')

interface TaskLike {
  exec?: { command?: string }
}
interface ConfigLike {
  tasks?: Record<string, TaskLike>
}

/** Every `*.test.ts` under `dir`, at any depth, as a POSIX path from it. */
function suitesUnder(dir: string, prefix = ''): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix === '' ? e.name : `${prefix}/${e.name}`
    if (e.isDirectory()) out.push(...suitesUnder(path.join(dir, e.name), rel))
    else if (e.name.endsWith('.test.ts')) out.push(rel)
  }
  return out
}

/**
 * What one `test`-family command launches, as a predicate over a suite path
 * relative to the package. A bare `bun test` (no path argument) is Bun's own
 * recursive discovery, so it takes everything; a command naming globs takes
 * what they match; the shard dealer's set is the dealer's own function.
 */
function launchedBy(command: string): (suite: string) => boolean {
  if (/\bscripts\/test-shard\.ts\b/.test(command)) {
    const suite = /\s--unsafe\b/.test(command) ? 'unsafe' : 'safe'
    const platform = /\s--platform\b/.test(command)
    const dealt = new Set(testFiles(suite, platform).map((f) => `tests/${f}`))
    return (suite) => dealt.has(suite)
  }
  const globs = [
    ...command.matchAll(/(?:^|[\s"'(])\.?\/?((?:[\w.*-]+\/)*[\w.*-]+\.test\.ts)/g),
  ].map((m) => new Bun.Glob(m[1]!))
  if (globs.length > 0) return (suite) => globs.some((g) => g.match(suite))
  if (/\bbun test\b/.test(command)) return () => true
  return () => false
}

const packages = readdirSync(packagesDir, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .filter((name) => {
    try {
      readdirSync(path.join(packagesDir, name, 'tests'))
      return true
    } catch {
      return false
    }
  })
  .sort()

describe('every test file is launched by a task', () => {
  it('reads real packages with real suites — the pin is not vacuous', () => {
    expect(packages.length).toBeGreaterThan(5)
    expect(packages).toContain('vx')
    expect(suitesUnder(path.join(packagesDir, 'vx', 'tests')).length).toBeGreaterThan(100)
  })

  it('no suite in any package is launched by nothing', async () => {
    const orphans: string[] = []
    for (const name of packages) {
      const dir = path.join(packagesDir, name)
      const config = (await import(path.join(dir, 'vx.config.ts'))) as { default: ConfigLike }
      const commands = Object.entries(config.default.tasks ?? {})
        .filter(([task]) => task === 'test' || task.startsWith('test.'))
        .map(([, task]) => task.exec?.command)
        .filter((c): c is string => typeof c === 'string')
      expect({ pkg: name, launchers: commands.length > 0 }).toEqual({ pkg: name, launchers: true })
      const takes = commands.map(launchedBy)
      for (const suite of suitesUnder(path.join(dir, 'tests'))) {
        if (!takes.some((take) => take(`tests/${suite}`))) orphans.push(`${name}: tests/${suite}`)
      }
    }
    expect(orphans).toEqual([])
  })

  // With every passing row printed, the failing row's error sat 300
  // lines up in a 9,500-line job log, past what a log reader fetches,
  // and item 948 went red three times with no cause on record (M-1).
  // `--only-failures` keeps the error near the end.
  it('every task that launches bun test prints only its failures', async () => {
    const launchers: string[] = []
    const verbose: string[] = []
    for (const name of packages) {
      const config = (await import(path.join(packagesDir, name, 'vx.config.ts'))) as {
        default: ConfigLike
      }
      for (const [task, t] of Object.entries(config.default.tasks ?? {})) {
        const command = t.exec?.command
        if (command === undefined || !/\bbun test\b/.test(command)) continue
        launchers.push(`${name}#${task}`)
        if (!/\bbun test --only-failures\b/.test(command)) verbose.push(`${name}#${task}`)
      }
    }
    expect(launchers).toContain('vx#test.bun.shard-1')
    expect(launchers).toContain('vx#test.bun.unsafe.shard-1')
    expect(launchers).toContain('vx-reapi#test.bun.shard-1')
    expect(verbose).toEqual([])
  })

  // Bun's 5 s default is a wall budget: a vx-migrate test that spawns vx
  // four times passed it on a packed DTE worker (2026-11-05), as a core
  // one did before the core shards took 30 s (#4198). Speed is asserted
  // elsewhere; the timeout only catches a hang.
  it('every task that launches bun test gives a test 30 s or more', async () => {
    const privateDir = path.join(repo, 'private')
    const dirs = [
      ...packages.map((name) => path.join(packagesDir, name)),
      ...readdirSync(privateDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => path.join(privateDir, e.name))
        .filter((dir) => Bun.file(path.join(dir, 'vx.config.ts')).size > 0),
    ]
    const short: string[] = []
    for (const dir of dirs) {
      const name = path.relative(repo, dir)
      const config = (await import(path.join(dir, 'vx.config.ts'))) as {
        default: ConfigLike
      }
      for (const [task, t] of Object.entries(config.default.tasks ?? {})) {
        const command = t.exec?.command
        if (command === undefined || !/\bbun test\b/.test(command)) continue
        const ms = Number(/--timeout[= ](\d+)/.exec(command)?.[1] ?? 5_000)
        if (ms < 30_000) short.push(`${name}#${task}`)
      }
    }
    expect(short).toEqual([])
  })

  // A test's own timeout argument overrides the flag: 17 tests ran on 3
  // to 8 s of wall that way (2026-11-05), and a Mac worker that stalled
  // ~20 s failed one held to 20 s (2026-11-06). A line-shape check missed
  // `{ timeout: N }`, hooks, an indented `const`, and a `},` / `N,` / `)`
  // whose body held a brace in a string (10 tests, 2026-11-24), so this
  // reads the calls themselves: strings and comments blanked, brackets matched.
  it('no test, hook or setDefaultTimeout sets a timeout under 30 s', () => {
    const short: string[] = []
    for (const top of ['packages', 'private']) {
      for (const file of new Bun.Glob('*/tests/**/*.test.ts').scanSync(path.join(repo, top))) {
        const full = path.join(repo, top, file)
        for (const line of shortTimeouts(full)) short.push(`${top}/${file}:${line}`)
      }
    }
    expect(short).toEqual([])
  }, 30_000)

  it('the timeout scan sees each form a test file sets one in', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'vx-timeout-law-'))
    try {
      writeFileSync(
        path.join(dir, 'helper.ts'),
        'export const SLOW = 60_000\nexport const QUICK = 9_000\n',
      )
      const f = path.join(dir, 'x.test.ts')
      writeFileSync(
        f,
        [
          "import { QUICK, SLOW as LONG } from './helper.js'",
          'const SHORT = 20_000',
          "it('a', () => { const s = '{'; }, 10_000)", // 3
          "it('b', () => {}, { timeout: 5_000 })", // 4
          'beforeAll(() => {}, SHORT)', // 5
          'setDefaultTimeout(1_000)', // 6
          "it.each([[1]])('c %s', () => {}, QUICK)", // 7
          "it('d', () => {}, LONG)",
          "it('e', () => { setTimeout(() => {}, 5) })",
          '// it(x, y, 1)',
          "const s = 'it(a, b, 1)'",
          "describe('f', () => { test('g', async () => {}, 30_000) })",
        ].join('\n'),
      )
      expect(shortTimeouts(f)).toEqual([3, 4, 5, 6, 7])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

const FLOOR_MS = 30_000
const CALLS = /\b(it|test|describe|beforeAll|afterAll|beforeEach|afterEach|setDefaultTimeout)\b/g

/** `text` with every string, template and comment blanked to spaces, lengths kept. */
function blanked(text: string): string {
  const out = text.split('')
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' '
  }
  let prev = '('
  for (let i = 0; i < text.length;) {
    const c = text[i]!
    if (c === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i)
      const to = end === -1 ? text.length : end
      blank(i, to)
      i = to
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      const to = end === -1 ? text.length : end + 2
      blank(i, to)
      i = to
    } else if (c === '"' || c === "'" || c === '`' || (c === '/' && /[(,=:[!&|?{};]/.test(prev))) {
      let j = i + 1
      let cls = false
      while (j < text.length) {
        const d = text[j]!
        if (d === '\\') j += 2
        // A `/` read as a regex that is division ends at the line, not the file.
        else if ((c === '/' || c === "'" || c === '"') && d === '\n') break
        else {
          if (c === '/' && d === '[') cls = true
          else if (c === '/' && d === ']') cls = false
          else if (d === c && !cls) break
          j++
        }
      }
      blank(i, j + 1)
      i = j + 1
      prev = 'a'
    } else {
      if (!/\s/.test(c)) prev = c
      i++
    }
  }
  return out.join('')
}

/** The index of the bracket closing the one at `open`, in blanked text. */
function closing(text: string, open: number): number {
  let depth = 0
  for (let i = open; i < text.length; i++) {
    const c = text[i]!
    if (c === '(' || c === '[' || c === '{') depth++
    else if ((c === ')' || c === ']' || c === '}') && --depth === 0) return i
  }
  return text.length
}

/** The top-level arguments of the call whose `(` is at `open`. */
function argsOf(text: string, open: number): string[] {
  const close = closing(text, open)
  const out: string[] = []
  let from = open + 1
  for (let i = open + 1; i < close; i++) {
    const c = text[i]!
    if (c === '(' || c === '[' || c === '{') i = closing(text, i)
    else if (c === ',') {
      out.push(text.slice(from, i))
      from = i + 1
    }
  }
  out.push(text.slice(from, close))
  // A blanked string argument is blank, not absent; a trailing comma adds nothing.
  const args = out.map((a) => a.trim())
  if (args.length > 0 && args[args.length - 1] === '') args.pop()
  return args
}

/** The ms an argument names: a number, a const of the file or one a relative import exports, `{ timeout }`. */
function msOf(arg: string, text: string, file: string): number {
  const literal = /^([\d_]+)$/.exec(arg)
  if (literal) return Number(literal[1]!.replaceAll('_', ''))
  const option = /^\{[^{}]*\btimeout\s*:\s*([\w$]+)/.exec(arg)
  if (option) return msOf(option[1]!, text, file)
  if (!/^[A-Za-z_$][\w$]*$/.test(arg)) return Infinity
  const own = new RegExp(`\\bconst ${arg}\\s*=\\s*([\\d_]+)\\s*$`, 'm').exec(text)
  if (own) return Number(own[1]!.replaceAll('_', ''))
  for (const im of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*'(\.[^']+)'/g)) {
    const named = im[1]!.split(',').map((x) => x.trim().split(/\s+as\s+/))
    const hit = named.find((n) => n[n.length - 1] === arg)
    if (hit === undefined) continue
    const source = path.resolve(path.dirname(file), im[2]!.replace(/\.js$/, '.ts'))
    let src: string
    try {
      src = readFileSync(source, 'utf8')
    } catch {
      return Infinity
    }
    const e = new RegExp(`export const ${hit[0]}\\s*=\\s*([\\d_]+)\\s*$`, 'm').exec(src)
    return e ? Number(e[1]!.replaceAll('_', '')) : Infinity
  }
  return Infinity
}

/** The lines of `file` whose test, hook or `setDefaultTimeout` names a timeout under 30 s. */
function shortTimeouts(file: string): number[] {
  const raw = readFileSync(file, 'utf8')
  const text = blanked(raw)
  const lines: number[] = []
  for (const m of text.matchAll(CALLS)) {
    if (m.index > 0 && /[\w$.]/.test(text[m.index - 1]!)) continue
    let i = m.index + m[0].length
    // it.skip(…), it.each(rows)(…), test.if(cond)(…).
    for (;;) {
      const mod = /^\s*\.\s*\w+\s*/.exec(text.slice(i, i + 40))
      if (mod === null) break
      i += mod[0].length
      if (text[i] === '(' && /\b(each|if|skipIf|todoIf)\b/.test(mod[0])) i = closing(text, i) + 1
      while (/\s/.test(text[i] ?? '')) i++
    }
    while (/\s/.test(text[i] ?? '')) i++
    if (text[i] !== '(') continue
    const args = argsOf(text, i)
    const want = m[0] === 'setDefaultTimeout' ? 1 : /^(before|after)/.test(m[0]) ? 2 : 3
    if (args.length < want) continue
    if (msOf(args[args.length - 1]!, raw, file) < FLOOR_MS)
      lines.push(raw.slice(0, m.index).split('\n').length)
  }
  return lines
}
