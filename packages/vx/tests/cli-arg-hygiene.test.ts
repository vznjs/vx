// Argument-parsing hygiene for `vx run` / `vx watch` / `vx cache clean`.
//
// Every case here pins a defect where the parser accepted an input and
// then did something OTHER than what it said: a no-op that read as
// "caching off", a value shape `Number()` silently reinterpreted, a
// flag a subcommand cannot honor, or a `0` that would delete the whole
// cache. Each pin is paired with a CONTROL asserting the neighbouring
// legal form still parses, so a fix can't over-reject.

import { afterEach, beforeEach, describe, expect, it, vi } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { parseRunArgs } from '../src/cli/run.js'
import { parseConcurrency } from '../src/settings.js'
import { parseDuration, parsePruneArgs, parseSize } from '../src/cli/cache.js'
import { run } from './helpers/cli.js'

describe('--cache-policy spec validation', () => {
  it('rejects an empty spec instead of silently leaving caching FULL', () => {
    // `--cache-policy=` parsed to zero segments, applied nothing, and left all
    // four axes on — the opposite of what someone typing it means.
    const eq = parseRunArgs(['build', '--cache-policy='])
    expect(eq.error).toMatch(/--cache-policy/)
    expect(eq.error).toMatch(/needs a spec/)

    // Same hole through the space form (an empty shell variable).
    const spaced = parseRunArgs(['build', '--cache-policy', ''])
    expect(spaced.error).toMatch(/needs a spec/)

    // A spec of nothing but separators is equally empty.
    expect(parseRunArgs(['build', '--cache-policy=,,']).error).toMatch(/needs a spec/)
  })

  it('a WHITESPACE spec is empty too, and a trailing comma is not', () => {
    // The row above covers `--cache-policy=`, the space FORM and `,,`. Two edges
    // sit either side of those and were held by neither.
    //
    // An unquoted shell variable does not always expand to nothing — it can
    // expand to a space, which is the same intent and must get the same
    // refusal. The trim is the only thing that says so.
    expect(parseRunArgs(['build', '--cache-policy= ']).error).toMatch(/needs a spec/)
    expect(parseRunArgs(['build', '--cache-policy', ' ']).error).toMatch(/needs a spec/)
    expect(parseRunArgs(['build', '--cache-policy=local:r, ']).error).toBeUndefined()

    // And the refusal asks whether ANY segment carries something, not
    // whether EVERY one does: a trailing comma is sloppy, not empty, and
    // rejecting it would turn a working spec into an error.
    const trailing = parseRunArgs(['build', '--cache-policy=local:r,'])
    expect(trailing.error).toBeUndefined()
    expect(trailing.cache).toEqual({
      localRead: true,
      localWrite: false,
      remoteRead: true,
      remoteWrite: true,
    })
  })

  it('naming the remote layer is not the same as ASKING for a remote axis', () => {
    // `remoteRequested` exists for one warning: "--cache-policy named the remote
    // cache, but no cache plugin supplies one". `remote:` is the spelling
    // that turns the remote layer OFF, so it must NOT arm that warning —
    // otherwise the user who explicitly disabled remote caching is told
    // they asked for it. The Turbo-parity row that covers the warning uses
    // an `r` spec, so it only ever proved the positive direction.
    expect(parseRunArgs(['build', '--cache-policy=remote:']).remoteRequested ?? false).toBe(false)
    expect(parseRunArgs(['build', '--cache-policy=local:r,remote:']).remoteRequested ?? false).toBe(
      false,
    )
    expect(parseRunArgs(['build', '--cache-policy=local:rw']).remoteRequested ?? false).toBe(false)
    // The controls: an axis actually asked for, either way round.
    expect(parseRunArgs(['build', '--cache-policy=remote:r']).remoteRequested).toBe(
      '--cache-policy',
    )
    expect(parseRunArgs(['build', '--cache-policy=remote:rw']).remoteRequested).toBe(
      '--cache-policy',
    )
  })

  it('still accepts a layer with EMPTY flags — that means "layer off"', () => {
    const r = parseRunArgs(['build', '--cache-policy=local:'])
    expect(r.error).toBeUndefined()
    expect(r.cache).toEqual({
      localRead: false,
      localWrite: false,
      remoteRead: true,
      remoteWrite: true,
    })
  })

  it('still accepts ordinary specs', () => {
    expect(parseRunArgs(['build', '--cache-policy=local:r']).cache).toEqual({
      localRead: true,
      localWrite: false,
      remoteRead: true,
      remoteWrite: true,
    })
    expect(parseRunArgs(['build', '--cache-policy', 'local:,remote:rw']).cache).toEqual({
      localRead: false,
      localWrite: false,
      remoteRead: true,
      remoteWrite: true,
    })
  })
})

describe('optional-value artifact flags treat an empty = as "no value"', () => {
  it('--profile= falls back to the default path instead of resolving to cwd', () => {
    // `--profile=` resolved to '' → path.resolve(cwd, '') → the cwd
    // DIRECTORY → EISDIR at write time, after the whole run.
    expect(parseRunArgs(['build', '--profile=']).profile).toBe('profile.json')
    expect(parseRunArgs(['build', '--profile']).profile).toBe('profile.json')
    expect(parseRunArgs(['build', '--profile=trace.json']).profile).toBe('trace.json')
  })
})

describe('vx watch rejects flags it cannot honor', () => {
  let stderr: string
  const origCwd = process.cwd()
  let tmp: string

  beforeEach(async () => {
    stderr = ''
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderr += String(chunk)
      return true
    })
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    // Park cwd outside any workspace: the rejection under test happens
    // before any filesystem work, so this is irrelevant when the guard
    // is present — it only stops an UNGUARDED build from reaching the
    // real watch loop and hanging the run.
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'vx-watch-guard-'))
    process.chdir(tmp)
  })

  afterEach(async () => {
    process.chdir(origCwd)
    vi.restoreAllMocks()
    await fs.rm(tmp, { recursive: true, force: true })
  })

  it('rejects --verbosity above 0', async () => {
    expect(await run(['watch', 'build', '--verbosity', '2'])).toBe(1)
    expect(stderr).toContain('is not supported in watch mode')
    expect(stderr).toContain('--verbosity')
  })

  it("names --poll as vx watch's when vx run is given it", () => {
    // The edit-distance hint offered `--all`, a different flag.
    expect(parseRunArgs(['build', '--poll']).error).toBe(
      'unknown flag: --poll (a vx watch flag: vx watch --poll <task>)',
    )
    expect(parseRunArgs(['build', '--poll'], 'watch').poll).toBe(true)
  })

  it('still parses --verbosity for vx run', () => {
    expect(parseRunArgs(['build', '--verbosity', '2']).verbosity).toBe(2)
  })
})

describe('numeric flags take a plain decimal integer only', () => {
  it('--concurrency rejects hex / fraction / exponent / padded / signed forms', () => {
    for (const v of ['0x10', '2.7', '1e3', ' 4 ', '+4', '4abc']) {
      expect(parseRunArgs(['build', '--concurrency', v]).error).toMatch(/--concurrency must be/)
    }
    expect(parseRunArgs(['build', '--concurrency', '4']).settings['run.concurrency']).toBe(4)
  })

  it('--concurrency <n>% is that share of the CPUs, never below 1', () => {
    expect(parseConcurrency('50%', 8)).toBe(4)
    expect(parseConcurrency('25%', 2)).toBe(1)
    expect(parseConcurrency('200%', 4)).toBe(8)
    expect(parseConcurrency('33%', 4)).toBe(1)
    for (const v of ['0%', '%', '50 %', '0x10%', '1.5%', '-50%'])
      expect(parseConcurrency(v, 8)).toBeNull()
    const cpus = Math.max(1, navigator.hardwareConcurrency)
    expect(parseRunArgs(['build', '--concurrency', '100%']).settings['run.concurrency']).toBe(cpus)
    expect(parseRunArgs(['build', '--concurrency=50%']).settings['run.concurrency']).toBe(
      Math.max(1, Math.round(cpus / 2)),
    )
  })

  it('--timeout rejects the same forms and values past 2^53', () => {
    for (const v of ['0x10', '1e3', '2.5', ' 5 ', '+5']) {
      expect(parseRunArgs([`--timeout=${v}`, 'build']).error).toMatch(/--timeout must be/)
    }
    // Silently became 9007199254740992 — a different number than typed.
    expect(parseRunArgs(['--timeout=9007199254740993ms', 'build']).error).toMatch(
      /--timeout must be/,
    )
    expect(parseRunArgs(['--timeout=5000ms', 'build']).settings['run.timeout']).toBe(5000)
    expect(parseRunArgs(['--timeout', '250ms', 'build']).settings['run.timeout']).toBe(250)
  })

  it('--retries rejects the same forms', () => {
    for (const v of ['0x3', '1e2', '1.5', ' 2 ']) {
      expect(parseRunArgs([`--retries=${v}`, 'build']).error).toMatch(/--retries must be/)
    }
    expect(parseRunArgs(['--retries=2', 'build']).settings['run.retries']).toBe(2)
    expect(parseRunArgs(['--retries=0', 'build']).settings['run.retries']).toBe(0)
  })

  it('--verbosity rejects the same forms', () => {
    for (const v of ['0x2', '1e1', '1.5', ' 1 ']) {
      expect(parseRunArgs(['build', '--verbosity', v]).error).toMatch(/--verbosity must be/)
    }
    expect(parseRunArgs(['build', '--verbosity', '2']).verbosity).toBe(2)
    expect(parseRunArgs(['build', '--verbosity', '0']).verbosity).toBe(0)
  })
})

describe('vx cache clean value parsing', () => {
  it('parses duration units case-insensitively, like sizes always have', () => {
    expect(parseDuration('30D')).toBe(parseDuration('30d'))
    expect(parseDuration('5MS')).toBe(parseDuration('5ms'))
    expect(parseDuration('2H')).toBe(parseDuration('2h'))
    expect(parseDuration('30S')).toBe(parseDuration('30s'))
    // The control the asymmetry was measured against.
    expect(parseSize('1GB')).toBe(parseSize('1gb'))
  })

  // `M` is a month to systemd and minutes to `m`: `--older-than 1M` read
  // as 1 minute empties the cache of someone who meant a month.
  it('refuses M, a month to some tools, minutes only as m', () => {
    expect(parseDuration('1M')).toBeNull()
    expect(parsePruneArgs(['--older-than', '1M']).error).toMatch(/--older-than/)
    expect(parseDuration('1m')).toBe(60_000)
  })

  it('rejects a duration whose digits cannot round-trip', () => {
    expect(parseDuration('99999999999999999999d')).toBeNull()
    expect(parseDuration('30y')).toBeNull()
  })

  it('accepts the = form for both flags, like every sibling flag', () => {
    const older = parsePruneArgs(['--older-than=30d'])
    expect(older.error).toBeUndefined()
    expect(older.olderThanMs).toBeDefined()

    const size = parsePruneArgs(['--max-size=1gb'])
    expect(size.error).toBeUndefined()
    expect(size.maxBytes).toBe(1024 ** 3)

    // Space form unchanged.
    expect(parsePruneArgs(['--max-size', '1gb']).maxBytes).toBe(1024 ** 3)
    expect(parsePruneArgs(['--older-than', '30D']).error).toBeUndefined()
  })

  it('--dry rides along either policy flag and alone is a clear', () => {
    expect(parsePruneArgs(['--older-than=30d', '--dry']).dry).toBe(true)
    expect(parsePruneArgs(['--dry', '--max-size', '1G']).dry).toBe(true)
    expect(parsePruneArgs(['--older-than=30d']).dry).toBeUndefined()
    expect(parsePruneArgs(['--dry']).error).toBeUndefined()
    // One name for a rehearsal on every verb: vx run and vx init spell it --dry.
    expect(parsePruneArgs(['--dry-run']).error).toContain('unknown flag: --dry-run')
    expect(parsePruneArgs(['--older-than=30d', '--cache-dir', 'x']).cacheDir).toBe('x')
    expect(parsePruneArgs(['--cache-dir=x', '--max-size=1G']).cacheDir).toBe('x')
    expect(parsePruneArgs(['--older-than=30d', '--cache-dir']).error).toMatch(/requires a path/)
    expect(parsePruneArgs(['--cache-dir', '--older-than=30d']).error).toMatch(/got flag/)
  })

  it('--format takes pretty or json, in either spelling', () => {
    expect(parsePruneArgs(['--max-size=1G', '--format', 'json']).format).toBe('json')
    expect(parsePruneArgs(['--format=pretty', '--max-size=1G']).format).toBe('pretty')
    expect(parsePruneArgs(['--max-size=1G']).format).toBeUndefined()
    const seeHelp = ' (see `vx cache --help`)'
    expect(parsePruneArgs(['--max-size=1G', '--format', 'xml']).error).toBe(
      `--format must be pretty or json (got xml)${seeHelp}`,
    )
    expect(parsePruneArgs(['--max-size=1G', '--format']).error).toBe(
      `--format requires a value: pretty or json${seeHelp}`,
    )
  })

  it('rejects an empty = value rather than reading it as "prune nothing"', () => {
    // Must read as a missing VALUE, not as the unknown-argument error the
    // = form produced before it was recognised at all.
    expect(parsePruneArgs(['--older-than=']).error).toMatch(/requires a value/)
    expect(parsePruneArgs(['--max-size=']).error).toMatch(/requires a value/)
  })

  it('refuses a zero bound that would evict the ENTIRE cache', () => {
    expect(parsePruneArgs(['--max-size', '0']).error).toMatch(/every entry/)
    expect(parsePruneArgs(['--max-size=0']).error).toMatch(/every entry/)
    expect(parsePruneArgs(['--older-than', '0d']).error).toMatch(/every entry/)
    expect(parsePruneArgs(['--older-than=0s']).error).toMatch(/every entry/)

    // The smallest meaningful bounds still parse.
    expect(parsePruneArgs(['--max-size', '1B']).maxBytes).toBe(1)
    expect(parsePruneArgs(['--older-than', '1s']).error).toBeUndefined()
  })
})

describe('value flags accept the = form', () => {
  it('--filter=', () => {
    const r = parseRunArgs(['build', '--filter=@scope/*', '--filter', 'other'])
    expect(r.error).toBeUndefined()
    expect(r.filters).toEqual(['@scope/*', 'other'])
    expect(r.tasks).toEqual(['build'])
    expect(parseRunArgs(['build', '--filter=']).error).toMatch(/--filter/)
  })

  it('--concurrency=', () => {
    expect(parseRunArgs(['build', '--concurrency=4']).settings['run.concurrency']).toBe(4)
    expect(parseRunArgs(['build', '--concurrency=']).error).toMatch(
      /--concurrency requires a value/,
    )
  })

  it('--output-logs=', () => {
    expect(parseRunArgs(['build', '--output-logs=none']).settings['run.outputLogs']).toBe('none')
    expect(parseRunArgs(['build', '--output-logs=errors-only']).settings['run.outputLogs']).toBe(
      'errors-only',
    )
    expect(parseRunArgs(['build', '--output-logs=loud']).error).toBe(
      "--output-logs must be one of 'full', 'errors-only', 'hash-only', 'none' (got loud)",
    )
    expect(parseRunArgs(['build', '--output-logs=']).error).toBe(
      "--output-logs requires a value: one of 'full', 'errors-only', 'hash-only', 'none'",
    )
    expect(parseRunArgs(['build', '--output-logs']).error).toBe(
      "--output-logs requires a value: one of 'full', 'errors-only', 'hash-only', 'none'",
    )
  })

  it('--cache-download= and --continue= echo the bad value', () => {
    expect(parseRunArgs(['build', '--cache-download=some']).error).toBe(
      "--cache-download must be one of 'all', 'toplevel', 'none' (got some)",
    )
    expect(parseRunArgs(['build', '--cache-download']).error).toBe(
      "--cache-download requires a value: one of 'all', 'toplevel', 'none'",
    )
    expect(parseRunArgs(['build', '--cache-download=']).error).toBe(
      "--cache-download requires a value: one of 'all', 'toplevel', 'none'",
    )
    expect(parseRunArgs(['build', '--continue=sometimes']).error).toBe(
      '--continue must be never, deps-ok, or always (got sometimes)',
    )
    expect(parseRunArgs(['build', '--continue=']).error).toBe(
      '--continue= requires a mode: never, deps-ok, or always',
    )
  })

  it('--verbosity=', () => {
    expect(parseRunArgs(['build', '--verbosity=2']).verbosity).toBe(2)
    expect(parseRunArgs(['build', '--verbosity=']).error).toBe(
      '--verbosity requires a value: a non-negative integer',
    )
  })

  it('leaves the =-ONLY flags =-only — a space form would eat the task name', () => {
    // Each of these is valid BARE, so `vx run --affected build` already
    // means "run build, affected scope". Accepting a space value would
    // silently retarget an invocation that works today.
    const affected = parseRunArgs(['--affected', 'build'])
    expect(affected.affected).toBe('')
    expect(affected.tasks).toEqual(['build'])

    const profile = parseRunArgs(['--profile', 'build'])
    expect(profile.profile).toBe('profile.json')
    expect(profile.tasks).toEqual(['build'])
  })
})

describe('--output-logs hash-only', () => {
  it('parses in both spellings and rejects a typo with the full mode list', () => {
    expect(parseRunArgs(['build', '--output-logs', 'hash-only']).settings['run.outputLogs']).toBe(
      'hash-only',
    )
    expect(parseRunArgs(['build', '--output-logs=hash-only']).settings['run.outputLogs']).toBe(
      'hash-only',
    )
    expect(parseRunArgs(['build', '--output-logs', 'hashonly']).error).toMatch(
      /one of 'full', 'errors-only', 'hash-only', 'none'/,
    )
  })
})

describe('a refused value says what the flag takes (E-36)', () => {
  it('--concurrency, --verbosity and --dry= name their accepted forms', () => {
    expect(
      [['--concurrency', '0'], ['--verbosity', 'high'], ['--dry=yaml']].map(
        (flag) => parseRunArgs(['build', ...flag]).error,
      ),
    ).toEqual([
      "--concurrency must be a positive integer, or a share of the cores like '50%' (got 0)",
      '--verbosity must be a non-negative integer (got high)',
      '--dry must be pretty or json (got yaml)',
    ])
  })
})

describe('a task argument with a control character is refused by name', () => {
  // `vx run $'build\n'` said "no projects declare task(s): build" with the
  // newline printed raw, then "Did you mean build?": the one fault, a
  // byte no task name holds, went unsaid.
  it('names the byte escaped, in a bare and an anchored task', () => {
    expect(parseRunArgs(['build\n']).error).toBe(
      'task "build\\n" holds a control character, which no task name may hold — retype it',
    )
    expect(parseRunArgs(['app#lint\x01']).error).toBe(
      'task "app#lint\\u0001" holds a control character, which no task name may hold — retype it',
    )
    expect(parseRunArgs(['watch\t'], 'watch').error).toBe(
      'task "watch\\t" holds a control character, which no task name may hold — retype it',
    )
  })

  it('a forwarded argument may hold one (control)', () => {
    expect(parseRunArgs(['build', '--', 'a\nb'])).toMatchObject({
      tasks: ['build'],
      forwardArgs: ['a\nb'],
    })
    expect(parseRunArgs(['build:prod', 'app#e2e']).error).toBeUndefined()
  })
})

describe('--profile names a file, checked before the run', () => {
  let stderr: string
  const origCwd = process.cwd()
  let tmp: string

  beforeEach(async () => {
    stderr = ''
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderr += String(chunk)
      return true
    })
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'vx-profile-'))
    process.chdir(tmp)
  })

  afterEach(async () => {
    process.chdir(origCwd)
    vi.restoreAllMocks()
    await fs.rm(tmp, { recursive: true, force: true })
  })

  // A directory died with EISDIR at write time, after the whole run.
  it('refuses a directory', async () => {
    await fs.mkdir(path.join(tmp, 'out'))
    expect(await run(['run', 'build', '--profile=out'])).toBe(1)
    expect(stderr).toContain(
      '--profile: out is a directory — name a file, e.g. --profile=out/profile.json',
    )
  })

  it('a file in an existing directory goes on to the run (control)', async () => {
    // No workspace here: the run's own refusal, thrown, is the next fault.
    const thrown = await run(['run', 'build', '--profile=p.json']).catch((e: Error) => e.message)
    expect(thrown).toContain('.vx/workspace.ts')
    expect(stderr).not.toContain('--profile:')
  })
})

describe('a string value flag does not swallow the next flag', () => {
  it('--branch <flag> is refused, as vx last --branch refuses it', () => {
    // `vx run build --branch $EMPTY --dry` ran the build for real, recorded
    // under a branch named `--dry`.
    for (const verb of ['run', 'watch'] as const) {
      expect(parseRunArgs(['build', '--branch', '--dry'], verb).error).toBe(
        '--branch requires a value (got flag --dry; a value that starts with - needs --branch=--dry)',
      )
    }
    expect(parseRunArgs(['build', '--branch=-x']).settings['run.branch']).toBe('-x')
    expect(parseRunArgs(['build', '--branch', 'main']).settings['run.branch']).toBe('main')
  })
})
