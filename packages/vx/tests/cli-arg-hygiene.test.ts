// Argument-parsing hygiene for `vx run` / `vx watch` / `vx cache prune`.
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
import { parseDuration, parsePruneArgs, parseRunArgs, parseSize, run } from '../src/cli/index.js'

describe('--cache spec validation', () => {
  it('rejects an empty spec instead of silently leaving caching FULL', () => {
    // `--cache=` parsed to zero segments, applied nothing, and left all
    // four axes on — the opposite of what someone typing it means.
    const eq = parseRunArgs(['build', '--cache='])
    expect(eq.error).toMatch(/--cache/)
    expect(eq.error).toMatch(/needs a spec/)

    // Same hole through the space form (an empty shell variable).
    const spaced = parseRunArgs(['build', '--cache', ''])
    expect(spaced.error).toMatch(/needs a spec/)

    // A spec of nothing but separators is equally empty.
    expect(parseRunArgs(['build', '--cache=,,']).error).toMatch(/needs a spec/)
  })

  it('still accepts a layer with EMPTY flags — that means "layer off"', () => {
    const r = parseRunArgs(['build', '--cache=local:'])
    expect(r.error).toBeUndefined()
    expect(r.cache).toEqual({
      localRead: false,
      localWrite: false,
      remoteRead: true,
      remoteWrite: true,
    })
  })

  it('still accepts ordinary specs', () => {
    expect(parseRunArgs(['build', '--cache=local:r']).cache).toEqual({
      localRead: true,
      localWrite: false,
      remoteRead: true,
      remoteWrite: true,
    })
    expect(parseRunArgs(['build', '--cache', 'local:,remote:rw']).cache).toEqual({
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

  it('--summarize= keeps degrading to its default (unchanged)', () => {
    // '' is summarize's documented default sentinel (<cacheDir>/runs/<id>.json).
    expect(parseRunArgs(['build', '--summarize=']).summarize).toBe('')
    expect(parseRunArgs(['build', '--summarize']).summarize).toBe('')
    expect(parseRunArgs(['build', '--summarize=out.json']).summarize).toBe('out.json')
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

  it('rejects --report (a watch loop has no single run to report)', async () => {
    expect(await run(['watch', 'build', '--report=markdown'])).toBe(1)
    expect(stderr).toContain('are not supported in watch mode')
    expect(stderr).toContain('--report')
  })

  // Same reasoning as --report, plus a sharper one: a watch loop would append
  // one report per cycle, growing the file without bound.
  it('rejects --report-file', async () => {
    expect(await run(['watch', 'build', '--report-file=out.md'])).toBe(1)
    expect(stderr).toContain('--report-file')
  })

  it('rejects --verbosity above 0', async () => {
    expect(await run(['watch', 'build', '--verbosity', '2'])).toBe(1)
    expect(stderr).toContain('are not supported in watch mode')
    expect(stderr).toContain('--verbosity')
  })

  it('still parses all three flags for vx run', () => {
    expect(parseRunArgs(['build', '--report=markdown']).report).toBe('markdown')
    expect(parseRunArgs(['build', '--report-file=out.md']).reportFile).toBe('out.md')
    expect(parseRunArgs(['build', '--verbosity', '2']).verbosity).toBe(2)
  })
})

describe('numeric flags take a plain decimal integer only', () => {
  it('--concurrency rejects hex / fraction / exponent / padded / signed forms', () => {
    for (const v of ['0x10', '2.7', '1e3', ' 4 ', '+4', '4abc', '']) {
      expect(parseRunArgs(['build', '--concurrency', v]).error).toMatch(/invalid concurrency/)
    }
    expect(parseRunArgs(['build', '--concurrency', '4']).concurrency).toBe(4)
  })

  it('--timeout rejects the same forms and values past 2^53', () => {
    for (const v of ['0x10', '1e3', '2.5', ' 5 ', '+5']) {
      expect(parseRunArgs([`--timeout=${v}`, 'build']).error).toMatch(/--timeout must be/)
    }
    // Silently became 9007199254740992 — a different number than typed.
    expect(parseRunArgs(['--timeout=9007199254740993', 'build']).error).toMatch(/--timeout must be/)
    expect(parseRunArgs(['--timeout=5000', 'build']).timeout).toBe(5000)
    expect(parseRunArgs(['--timeout', '250', 'build']).timeout).toBe(250)
  })

  it('--retry rejects the same forms', () => {
    for (const v of ['0x3', '1e2', '1.5', ' 2 ']) {
      expect(parseRunArgs([`--retry=${v}`, 'build']).error).toMatch(/--retry must be/)
    }
    expect(parseRunArgs(['--retry=2', 'build']).retries).toBe(2)
    expect(parseRunArgs(['--retry=0', 'build']).retries).toBe(0)
  })

  it('--verbosity rejects the same forms', () => {
    for (const v of ['0x2', '1e1', '1.5', ' 1 ']) {
      expect(parseRunArgs(['build', '--verbosity', v]).error).toMatch(/invalid verbosity/)
    }
    expect(parseRunArgs(['build', '--verbosity', '2']).verbosity).toBe(2)
    expect(parseRunArgs(['build', '--verbosity', '0']).verbosity).toBe(0)
  })

  it('--memory keeps its size-string forms (parsed by parseSize, already strict)', () => {
    expect(parseRunArgs(['--memory=512MB', 'build']).memory).toBe(512 * 1024 * 1024)
    expect(parseRunArgs(['--memory', '2G', 'build']).memory).toBe(2 * 1024 ** 3)
    expect(parseRunArgs(['--memory=0x1000', 'build']).error).toMatch(/--memory must be/)
  })
})

describe('vx cache prune value parsing', () => {
  it('parses duration units case-insensitively, like sizes always have', () => {
    expect(parseDuration('30D')).toBe(parseDuration('30d'))
    expect(parseDuration('5M')).toBe(parseDuration('5m'))
    expect(parseDuration('2H')).toBe(parseDuration('2h'))
    expect(parseDuration('30S')).toBe(parseDuration('30s'))
    // The control the asymmetry was measured against.
    expect(parseSize('1GB')).toBe(parseSize('1gb'))
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
    expect(parsePruneArgs(['--max-size', '1']).maxBytes).toBe(1)
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
    expect(parseRunArgs(['build', '--concurrency=4']).concurrency).toBe(4)
    expect(parseRunArgs(['build', '--concurrency=']).error).toMatch(/invalid concurrency/)
  })

  it('--output-logs=', () => {
    expect(parseRunArgs(['build', '--output-logs=none']).outputLogs).toBe('none')
    expect(parseRunArgs(['build', '--output-logs=errors-only']).outputLogs).toBe('errors-only')
    expect(parseRunArgs(['build', '--output-logs=loud']).error).toMatch(/--output-logs must be/)
    expect(parseRunArgs(['build', '--output-logs=']).error).toMatch(/--output-logs must be/)
  })

  it('--verbosity=', () => {
    expect(parseRunArgs(['build', '--verbosity=2']).verbosity).toBe(2)
    expect(parseRunArgs(['build', '--verbosity=']).error).toMatch(/invalid verbosity/)
  })

  it('leaves the =-ONLY flags =-only — a space form would eat the task name', () => {
    // Each of these is valid BARE, so `vx run --affected build` already
    // means "run build, affected scope". Accepting a space value would
    // silently retarget an invocation that works today.
    const affected = parseRunArgs(['--affected', 'build'])
    expect(affected.affected).toBe('')
    expect(affected.tasks).toEqual(['build'])

    const verify = parseRunArgs(['--verify', 'build'])
    expect(verify.verify).toEqual({ determinism: true, inputs: false, fingerprint: true })
    expect(verify.tasks).toEqual(['build'])

    const summarize = parseRunArgs(['--summarize', 'build'])
    expect(summarize.summarize).toBe('')
    expect(summarize.tasks).toEqual(['build'])

    const report = parseRunArgs(['--report', 'build'])
    expect(report.report).toBe('markdown')
    expect(report.tasks).toEqual(['build'])
  })
})

describe('--output-logs hash-only', () => {
  it('parses in both spellings and rejects a typo with the full mode list', () => {
    expect(parseRunArgs(['build', '--output-logs', 'hash-only']).outputLogs).toBe('hash-only')
    expect(parseRunArgs(['build', '--output-logs=hash-only']).outputLogs).toBe('hash-only')
    expect(parseRunArgs(['build', '--output-logs', 'hashonly']).error).toMatch(
      /full, errors-only, hash-only, or none/,
    )
  })
})
