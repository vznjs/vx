// `vx completions <shell>`: the verbs and every flag of each, from the same
// help text `vx <verb> --help` prints — one source, so a flag cannot be
// documented and not completed.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import { completionScript, completionsCmd, verbFlags } from '../src/cli/completions.js'
import { documentedFlags, CORE_VERBS, WATCH_REFUSED_FLAGS } from '../src/cli/help.js'
import { parseRunArgs } from '../src/cli/run.js'
import { run } from '../src/cli/index.js'
import { watchRefusal } from '../src/cli/watch.js'
import { PARSE } from './helpers/cli-parsers.js'

const VERBS = [...CORE_VERBS, 'mcp']

describe('verbFlags', () => {
  it('reads every documented run flag, and the flags of the other verbs, from the help cut', () => {
    const runFlags = verbFlags('run')
    for (const f of documentedFlags('run')) expect(runFlags).toContain(f)
    expect(verbFlags('cache')).toEqual(
      expect.arrayContaining(['--older-than', '--max-size', '--dry-run', '--cache-dir']),
    )
    expect(verbFlags('last')).toEqual(expect.arrayContaining(['--list', '--format', '--cache-dir']))
    expect(verbFlags('cache')).not.toContain('--concurrency')
    // Every verb completes --help.
    for (const v of CORE_VERBS) expect(verbFlags(v)).toContain('--help')
  })
})

// A flag's argv as its parser takes it: the value a value flag needs, none
// for a bare one. A flag missing here fails the rows below by name.
const ARGV: Readonly<Record<string, readonly string[]>> = {
  '--all': [],
  '--filter': ['x'],
  '--affected': [],
  '--concurrency': ['2'],
  '--exclude-dependencies': [],
  '--no-cache': [],
  '--force': [],
  '--cache': ['local:rw'],
  '--cache-dir': ['d'],
  '--retry': ['1'],
  '--timeout': ['10'],
  '--continue': [],
  '--frozen': [],
  '--output-logs': ['full'],
  '--download': ['all'],
  '--verbosity': ['1'],
  '--dry': [],
  '--graph': [],
  '--summarize': [],
  '--profile': [],
  '--report': [],
  '--report-file': ['r.md'],
  '--tag': ['k=v'],
  '--older-than': ['1d'],
  '--max-size': ['1G'],
  '--dry-run': [],
  '--check': [],
  '--mjs': [],
  '--plugin': ['key'],
  '--format': ['json'],
  '--run': ['id'],
  '--list': [],
  '--failed': [],
}

describe('verbFlags is what each verb accepts', () => {
  it('completes no flag the verb refuses', () => {
    // `vx watch` completed exactly `--dry --graph --summarize --profile`, the
    // four its help line says it refuses; `show` offered `--run --list`,
    // `lock` `--frozen`, `run` `--check` — all read from prose that names
    // another verb's flag (2026-09-27).
    const refused: string[] = []
    for (const [verb, parse] of Object.entries(PARSE)) {
      for (const flag of verbFlags(verb)) {
        if (flag === '--help') continue
        const argv = ARGV[flag]
        if (argv === undefined) {
          refused.push(`${verb} ${flag}: no argv for it in this table`)
          continue
        }
        // A cache prune needs a policy; anything but that is the flag's own verdict.
        const extra = verb === 'cache' && flag !== '--older-than' ? ['--max-size', '1G'] : []
        const error = parse([flag, ...argv, ...extra])
        if (error !== null) refused.push(`${verb} ${flag}: ${error}`)
      }
    }
    expect(refused).toEqual([])
  })

  it("completes every flag the verb's parser names", () => {
    // The parser's flags are its source's quoted `'--x'` literals (the form
    // every verb matches on), plus `--cache-dir` where it takes the shared
    // parser; each must complete.
    const missing: string[] = []
    const file: Record<string, string> = { watch: 'run' }
    for (const verb of Object.keys(PARSE)) {
      const src = readFileSync(
        path.join(import.meta.dir, '..', 'src', 'cli', `${file[verb] ?? verb}.ts`),
        'utf8',
      )
      const named = new Set(Array.from(src.matchAll(/'(--[a-z][a-z-]*)=?'/g), (m) => m[1]!))
      if (src.includes('parseCacheDirFlag(args')) named.add('--cache-dir')
      if (verb === 'watch') for (const f of WATCH_REFUSED_FLAGS) named.delete(f)
      expect(named.size).toBeGreaterThan(0)
      for (const f of named) if (!verbFlags(verb).includes(f)) missing.push(`${verb} ${f}`)
    }
    expect(missing).toEqual([])
  })

  it("watch refuses exactly WATCH_REFUSED_FLAGS among run's flags", () => {
    const refusedByWatch = documentedFlags('run')
      .filter((f) => {
        const parsed = parseRunArgs(['build', f, ...(ARGV[f] ?? [])])
        expect(parsed.error).toBeUndefined()
        return watchRefusal(parsed) !== null
      })
      .sort()
    expect(refusedByWatch).toEqual([...WATCH_REFUSED_FLAGS].sort())
  })

  it('a flag another verb names in passing is never suggested to run', () => {
    // `--frozen`'s help line says "pair with vx lock --check".
    expect(parseRunArgs(['build', '--chek']).error).toBe(
      'unknown flag: --chek (see `vx run --help`)',
    )
  })
})

describe('completionScript', () => {
  it('bash: names every verb and every run flag, and parses', async () => {
    const script = completionScript('bash', VERBS)
    for (const v of VERBS) expect(script).toContain(v)
    for (const f of documentedFlags('run')) expect(script).toContain(f)
    expect(script).toContain('complete -F _vx vx')
    const proc = Bun.spawn(['bash', '-n'], {
      stdin: new Blob([script]),
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(await proc.exited).toBe(0)
  })

  it('zsh and fish: names every verb and the run flags', () => {
    const zsh = completionScript('zsh', VERBS)
    expect(zsh.startsWith('#compdef vx')).toBe(true)
    const fish = completionScript('fish', VERBS)
    expect(fish).toContain('complete -c vx')
    for (const v of VERBS) {
      expect(zsh).toContain(v)
      expect(fish).toContain(`-a ${v}`)
    }
    for (const f of documentedFlags('run')) {
      expect(zsh).toContain(f)
      expect(fish).toContain(`-l ${f.slice(2)}`)
    }
  })
})

describe('vx completions (dispatch)', () => {
  it('prints the script for a known shell and refuses an unknown one, naming the three', async () => {
    let out = ''
    let err = ''
    const so = process.stdout.write.bind(process.stdout)
    const se = process.stderr.write.bind(process.stderr)
    process.stdout.write = ((chunk: string | Uint8Array) => {
      out += String(chunk)
      return true
    }) as typeof process.stdout.write
    process.stderr.write = ((chunk: string | Uint8Array) => {
      err += String(chunk)
      return true
    }) as typeof process.stderr.write
    try {
      expect(await run(['completions', 'bash'])).toBe(0)
      expect(out).toContain('complete -F _vx vx')
      expect(await run(['completions', 'powershell'])).toBe(1)
      expect(err).toMatch(/bash, zsh or fish/)
      expect(await run(['completions'])).toBe(1)
    } finally {
      process.stdout.write = so
      process.stderr.write = se
    }
  })
})

// What the bash script DOES, run in bash: each call sources the script, sets
// the words typed, calls `_vx` and prints what it offers. Two calls in one
// shell show a stale COMPREPLY, which `COMPREPLY` being global makes real.
describe('the bash script, run', () => {
  const quote = (w: string) => `'${w.replaceAll("'", "'\\''")}'`
  async function offers(
    script: string,
    ...calls: Array<{ words: string[]; cword: number }>
  ): Promise<string[]> {
    const body = calls
      .map((c) => `COMP_WORDS=(${c.words.map(quote).join(' ')}); COMP_CWORD=${c.cword}; _vx`)
      .join('\n')
    const proc = Bun.spawn(
      ['bash', '-c', `${script}\n${body}\nprintf '%s\\n' "\${COMPREPLY[@]}"`],
      {
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    const out = await new Response(proc.stdout).text()
    expect(await proc.exited).toBe(0)
    return out.split('\n').filter(Boolean)
  }
  const script = completionScript('bash', ['run', 'cache', 'completions', 'mcp'])

  it('the first word offers the verbs that match what is typed', async () => {
    expect(await offers(script, { words: ['vx', 'c'], cword: 1 })).toEqual(['cache', 'completions'])
  })

  it('after a verb: its subcommands and choices, and a plugin verb only --help', async () => {
    expect(await offers(script, { words: ['vx', 'cache', 'p'], cword: 2 })).toEqual(['prune'])
    expect(await offers(script, { words: ['vx', 'completions', ''], cword: 2 })).toEqual([
      'bash',
      'zsh',
      'fish',
      '--help',
    ])
    expect(await offers(script, { words: ['vx', 'mcp', ''], cword: 2 })).toEqual(['--help'])
  })

  it('an unknown verb offers nothing, even after a call that offered something', async () => {
    expect(
      await offers(
        script,
        { words: ['vx', 'cache', 'p'], cword: 2 },
        { words: ['vx', 'nope', ''], cword: 2 },
      ),
    ).toEqual([])
  })
})

describe('zsh', () => {
  it('offers the verbs as separate words', () => {
    expect(completionScript('zsh', ['run', 'cache']).split('\n')).toContain(
      '    compadd -- run cache',
    )
  })
})

describe('completionsCmd', () => {
  async function capture(
    args: string[],
    plugins: string[],
  ): Promise<{ code: number; out: string; err: string }> {
    let out = ''
    let err = ''
    const so = process.stdout.write.bind(process.stdout)
    const se = process.stderr.write.bind(process.stderr)
    process.stdout.write = ((c: string | Uint8Array) => (
      (out += String(c)),
      true
    )) as typeof process.stdout.write
    process.stderr.write = ((c: string | Uint8Array) => (
      (err += String(c)),
      true
    )) as typeof process.stderr.write
    try {
      return { code: await completionsCmd(args, plugins), out, err }
    } finally {
      process.stdout.write = so
      process.stderr.write = se
    }
  }

  it('offers every core verb, help and version last, then the plugin verbs', async () => {
    const { code, out } = await capture(['zsh'], ['mcp'])
    expect(code).toBe(0)
    const verbs = out
      .split('\n')
      .find((l) => l.startsWith('    compadd -- '))!
      .slice(15)
      .split(' ')
    expect(verbs.slice(-3)).toEqual(['help', 'version', 'mcp'])
    expect(new Set(verbs)).toEqual(new Set([...CORE_VERBS, 'mcp']))
  })

  it('refuses a second shell, and names a bad one only when it was the one word', async () => {
    const two = await capture(['bash', 'zsh'], [])
    expect(two.code).toBe(1)
    expect(two.err).not.toContain('(got')
    const bad = await capture(['tcsh'], [])
    expect(bad.err).toContain('(got tcsh)')
  })
})
