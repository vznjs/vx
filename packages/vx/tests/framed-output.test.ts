import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  formatFrameClose,
  formatFrameOpen,
  formatPersistentList,
  formatTaskBlock,
  formatTaskExecutedLine,
  formatTaskHitLine,
  formatTaskSkippedLine,
  paintIdParts,
} from '../src/orchestrator/framed-output.js'
import type { TaskOutcome } from '../src/graph/scheduler.js'
import type { TaskNode } from '../src/graph/task-graph.js'

function node(id: string, command?: string): TaskNode {
  const sep = id.indexOf('#')
  return {
    id,
    projectName: sep >= 0 ? id.slice(0, sep) : id,
    taskName: sep >= 0 ? id.slice(sep + 1) : id,
    config: command ? { exec: { command } } : {},
  } as unknown as TaskNode
}

function persistentNode(id: string, command: string): TaskNode {
  const sep = id.indexOf('#')
  return {
    id,
    projectName: sep >= 0 ? id.slice(0, sep) : id,
    taskName: sep >= 0 ? id.slice(sep + 1) : id,
    config: { exec: { command, persistent: { readyWhen: 'Local' } } },
  } as unknown as TaskNode
}

function outcome(
  id: string,
  status: TaskOutcome['status'],
  extra: Partial<TaskOutcome> = {},
): TaskOutcome {
  return {
    node: { id } as TaskNode,
    status,
    exitCode: status === 'failed' ? 1 : 0,
    durationMs: 0,
    ...extra,
  }
}

describe('identity hues never read as an outcome', () => {
  // The module states this as a deliberate constraint: identity hues sit
  // "outside the status palette (green / red / yellow / cyan) so a task id
  // can never read as an outcome", and the task hue is "excluded from the
  // project palette so the two halves always read apart". Nothing held it —
  // painting TASK green, or a project hue red, left the whole repo green,
  // because every rendering row runs with colours off.
  //
  // So it is pinned as a LAW over the constants rather than as a behaviour:
  // the guarantee IS the disjointness, and asserting a rendered escape
  // sequence would pin the hue values themselves, which are free to change.
  const src = readFileSync(
    path.resolve(import.meta.dir, '..', 'src', 'orchestrator', 'framed-output.ts'),
    'utf8',
  )
  const hue = (name: string): string => {
    const m = new RegExp(`^const ${name} = '(#[0-9a-fA-F]{6})'`, 'm').exec(src)
    if (m === null) throw new Error(`no hue constant named ${name}`)
    return m[1]!.toLowerCase()
  }
  const projectPalette = (): string[] => {
    const block = /const PROJECT_PALETTE = \[([\s\S]*?)\] as const/.exec(src)
    if (block === null) throw new Error('no PROJECT_PALETTE block')
    return [...block[1]!.matchAll(/'(#[0-9a-fA-F]{6})'/g)].map((m) => m[1]!.toLowerCase())
  }

  it('the identity palette and the status palette share no hue', () => {
    const status = ['ACCENT', 'SUCCESS', 'WARN', 'ERROR', 'LOCAL', 'REMOTE'].map(hue)
    const identity = [...projectPalette(), hue('TASK')]
    // Non-vacuity: a regex that silently stopped matching would otherwise
    // pass by comparing two empty sets.
    expect(status.length).toBe(6)
    expect(identity.length).toBeGreaterThanOrEqual(7)
    expect(identity.filter((h) => status.includes(h))).toEqual([])
  })

  it('the task hue is excluded from the project palette, so the halves read apart', () => {
    const palette = projectPalette()
    expect(palette.length).toBeGreaterThanOrEqual(6)
    expect(palette).not.toContain(hue('TASK'))
  })
})

// turborepo#2564: a package's prefix colour changed between runs — handed
// out in the order packages happened to start. docs/cli.md promises "same
// project = same color in every run".
describe('a project hue is a function of its name', () => {
  const on = { enabled: true }
  const names = ['web', 'docs', '@scope/ui', 'api', 'lib']
  const painted = (order: readonly string[]): Record<string, string> => {
    const out: Record<string, string> = {}
    for (const n of order) out[n] = paintIdParts(n, n, 'build', on)
    return out
  }

  it('is the same escape in another process and in any discovery order', () => {
    const here = painted(names)
    expect(Object.values(here).every((s) => s.startsWith('\x1b[38;2;'))).toBe(true)
    expect(painted([...names].reverse())).toEqual(here)

    const module = path.resolve(import.meta.dir, '..', 'src', 'orchestrator', 'framed-output.ts')
    const script = `
      const { paintIdParts } = await import(${JSON.stringify(module)})
      const out = {}
      for (const n of ${JSON.stringify(['zzz', ...[...names].reverse()])}) out[n] = paintIdParts(n, n, 'build', { enabled: true })
      console.log(JSON.stringify(out))
    `
    const p = Bun.spawnSync([process.execPath, '-e', script], { stdout: 'pipe', stderr: 'pipe' })
    expect(p.exitCode).toBe(0)
    const there = JSON.parse(p.stdout.toString()) as Record<string, string>
    delete there['zzz']
    expect(there).toEqual(here)
  })
})

describe('the compact one-liners', () => {
  // docs/modules/framed-output.md showed `◌ <id> ── restored-local • <hash8>`,
  // a shape and a glyph nothing prints (item 312, 2026-09-16): the row is
  // glyph · time · status · cache · name, and the page's sample says so.
  const doc = readFileSync(
    path.resolve(import.meta.dir, '..', 'docs', 'modules', 'framed-output.md'),
    'utf8',
  )
  const cached = {
    ...node('@vzn/vx#lint', 'oxlint .'),
    config: { exec: { command: 'oxlint .' }, cache: {} },
  } as unknown as TaskNode

  it('a restored local hit is ⇢ · time · success · local · id', () => {
    const row = formatTaskHitLine(cached, {
      ...outcome('@vzn/vx#lint', 'cache-hit', {
        durationMs: 12,
        hash: 'abcdef0123456789',
        restored: true,
      }),
      node: cached,
    })
    expect(row).toMatch(/^ ⇢ +12ms success +local +@vzn\/vx#lint$/)
    expect(doc).toContain('// ` ⇢ <time> success local <id>` — quiet cache hit')
  })

  it('an executed cached task is ⏺ · time · success · miss · id', () => {
    const row = formatTaskExecutedLine(cached, {
      ...outcome('@vzn/vx#lint', 'success', { durationMs: 327, hash: 'abcdef0123456789' }),
      node: cached,
    })
    expect(row).toMatch(/^ ⏺\uFE0E +327ms success +miss +@vzn\/vx#lint$/)
    expect(doc).toContain('// ` ⏺ <time> success miss <id>` — broad-mode executed task')
  })

  it('the whole grid: glyph is the cache axis, the two words are the task axis', () => {
    // One guarantee instead of nine rows. Every member here moves exactly
    // one line — the failed word, the skipped word, a failed task's cache
    // cell, the remote fresh/restored pair, the remote glyph — and a row
    // per member would leave the rest of the grid unheld. A row that says
    // `success` for a task that FAILED is the worst of them: the run
    // reports the opposite of what happened.
    const uncached = node('@vzn/vx#fmt', 'oxfmt .')
    const row = (n: TaskNode, status: TaskOutcome['status'], extra: Partial<TaskOutcome> = {}) =>
      formatTaskExecutedLine(n, {
        ...outcome('@vzn/vx#x', status, { durationMs: 1234, ...extra }),
        node: n,
      })
    expect([
      row(cached, 'success'),
      row(uncached, 'success'),
      row(cached, 'failed'),
      row(uncached, 'failed'),
      row(cached, 'skipped'),
      row(cached, 'cache-hit', { restored: true }),
      row(cached, 'cache-hit', { restored: false }),
      row(cached, 'cache-hit-remote', { restored: true }),
      row(cached, 'cache-hit-remote', { restored: false }),
    ]).toEqual([
      ' ⏺\uFE0E   1.23s success miss     @vzn/vx#lint',
      ' ⏺\uFE0E   1.23s success no-cache @vzn/vx#fmt',
      ' ◼\uFE0E   1.23s failed  miss     @vzn/vx#lint',
      ' ◼\uFE0E   1.23s failed  no-cache @vzn/vx#fmt',
      ' ⊘   1.23s skipped          @vzn/vx#lint',
      ' ⇢   1.23s success local    @vzn/vx#lint',
      ' ►   1.23s success fresh    @vzn/vx#lint',
      ' ⇣   1.23s success remote   @vzn/vx#lint',
      ' ►   1.23s success fresh    @vzn/vx#lint',
    ])
  })

  it('a duration wider than the time column still renders, and does not throw', () => {
    // The left pad is `' '.repeat(TIME_COL - raw.length)`, clamped at 0.
    // Without the clamp a task running past ~2.8 hours makes that count
    // negative and `repeat` throws a RangeError — a successful run whose
    // REPORT takes the process down.
    const uncached = node('@vzn/vx#fmt', 'oxfmt .')
    expect(
      formatTaskExecutedLine(uncached, {
        ...outcome('@vzn/vx#fmt', 'success', { durationMs: 99_999_999 }),
        node: uncached,
      }),
    ).toBe(' ⏺\uFE0E 100000.00s success no-cache @vzn/vx#fmt')
  })

  it('with colour on the cache word is dim, and a blank cell emits nothing', () => {
    const on = { enabled: true }
    const painted = formatTaskExecutedLine(
      cached,
      { ...outcome('@vzn/vx#lint', 'success', { durationMs: 1234 }), node: cached },
      on,
    )
    // The dim code, not a hue: which colour `miss` takes is free to change,
    // that it is DIM is the claim (it is the quiet half of the row).
    expect(painted).toContain('\x1b[2mmiss\x1b[0m')
    // A skipped row has no cache word at all. An empty cell must emit no
    // escape, so the only empty dim pair in the line is the blank TIME
    // cell — two would mean the cache cell painted nothing, visibly
    // identical and wrong.
    const skipped = formatTaskSkippedLine(node('@vzn/vx#fmt', 'oxfmt .'), on)
    const emptyDim = '\x1b[2m\x1b[0m' // counted by split: a regex literal here trips no-control-regex
    expect(skipped.split(emptyDim).length - 1).toBe(1)
  })
})

describe('formatTaskBlock', () => {
  it('renders an executed task with command + stdout sections, content raw (no border)', () => {
    const out = formatTaskBlock(
      node('@vzn/vx#lint', 'oxlint .'),
      outcome('@vzn/vx#lint', 'success', { durationMs: 327, hash: 'abcdef0123456789' }),
      { stdout: 'Found 0 warnings and 0 errors.\nFinished in 327ms.\n' },
    )
    expect(out).toBe(
      '┌─ @vzn/vx#lint > success\n' +
        '\n' +
        '$ oxlint .\n' +
        '\n' +
        '├─ STDOUT ──────────────────────────────────────────────────\n' +
        '\n' +
        'Found 0 warnings and 0 errors.\n' +
        'Finished in 327ms.\n' +
        '\n' +
        '└─ @vzn/vx#lint ── (327ms) success\n',
    )
  })

  it('whitespace-only stdout renders no stdout section', () => {
    const out = formatTaskBlock(
      node('@vzn/vx#lint', 'oxlint .'),
      outcome('@vzn/vx#lint', 'success', { durationMs: 5 }),
      { stdout: '   \n\n' },
    )
    expect(out).toBe(
      '┌─ @vzn/vx#lint > success\n' +
        '\n' +
        '$ oxlint .\n' +
        '\n' +
        '└─ @vzn/vx#lint ── (5ms) success\n',
    )
  })

  it('local cache hit (restored) shows "restored-local" + stdout section, no command', () => {
    // durationMs here is the wallclock for clean+restore+log-replay,
    // measured by execute-task. Tiny but non-zero in the wild.
    //
    // `storedDurationMs` is what the ORIGINAL execution spent, and every
    // real restore carries it (hit-restore.ts sets it from the entry), so
    // the fixture carries it too: without it this frame could not tell the
    // two apart, and rendering the stored figure in the footer left the
    // whole repo green. It is not hypothetical — the footer's own comment
    // records `--report` summing these as "time saved" on the strength of
    // a comment that claimed the opposite of what the code did. A 1s task
    // restored in 9ms must read 9ms; the alternative is a cache hit
    // reporting the work it just avoided as work it did.
    const out = formatTaskBlock(
      node('@vzn/vx#lint', 'oxlint .'),
      outcome('@vzn/vx#lint', 'cache-hit', {
        durationMs: 12,
        storedDurationMs: 4310,
        hash: 'abcdef0123456789',
        restored: true,
      }),
      { stdout: 'Found 0 warnings and 0 errors.\n' },
    )
    expect(out).toBe(
      '┌─ @vzn/vx#lint > restored-local • abcdef01\n' +
        '├─ STDOUT ──────────────────────────────────────────────────\n' +
        '\n' +
        'Found 0 warnings and 0 errors.\n' +
        '\n' +
        '└─ @vzn/vx#lint ── (12ms) restored-local\n',
    )
  })

  it('local cache hit (already up-to-date) shows "up-to-date" instead of "restored-local"', () => {
    // restored: false means the on-disk tree already matched the
    // cached snapshot, so cleanOutputs + restoreOutputs were skipped.
    // The user sees "up-to-date" to confirm nothing was rewritten.
    const out = formatTaskBlock(
      node('@vzn/vx#lint', 'oxlint .'),
      outcome('@vzn/vx#lint', 'cache-hit', {
        durationMs: 3,
        hash: 'abcdef0123456789',
        restored: false,
      }),
      {},
    )
    expect(out).toBe(
      '┌─ @vzn/vx#lint > up-to-date • abcdef01\n' + '└─ @vzn/vx#lint ── (3ms) up-to-date\n',
    )
  })

  it('remote cache hit (restored) shows "restored-remote" in header + footer', () => {
    const out = formatTaskBlock(
      node('@vzn/vx#lint', 'oxlint .'),
      outcome('@vzn/vx#lint', 'cache-hit-remote', {
        durationMs: 156,
        hash: 'fedcba9876543210',
        restored: true,
      }),
      {},
    )
    expect(out).toBe(
      '┌─ @vzn/vx#lint > restored-remote • fedcba98\n' +
        '└─ @vzn/vx#lint ── (156ms) restored-remote\n',
    )
  })

  it('failures put the outcome in the header, command as a dim $ line', () => {
    const out = formatTaskBlock(
      node('@vzn/vx#build', 'tsc'),
      outcome('@vzn/vx#build', 'failed', { durationMs: 1234, exitCode: 2 }),
      { stderr: 'error TS1234: oops\n' },
    )
    expect(out).toBe(
      '┌─ @vzn/vx#build > failed (exit 2)\n' +
        '\n' +
        '$ tsc\n' +
        '\n' +
        '├─ STDERR ──────────────────────────────────────────────────\n' +
        '\n' +
        'error TS1234: oops\n' +
        '\n' +
        '└─ @vzn/vx#build ── (1.23s) failed (exit 2)\n',
    )
  })

  it('renders a sandbox violations section when outcome carries violation lines', () => {
    const out = formatTaskBlock(
      node('@bench/top#build', 'sleep 3 && mkdir -p dist && touch dist/index.js'),
      outcome('@bench/top#build', 'failed', {
        durationMs: 3060,
        exitCode: 1,
        sandboxViolations: 2,
        sandboxViolationLines: [
          'touch(32784) deny(1) sysctl-read kern.iossupportversion',
          'touch(32784) deny(1) file-read-metadata /Users/me/proj/packages/top/dist/index.js',
        ],
      }),
      { stderr: 'touch: dist/index.js: Operation not permitted\n' },
    )
    expect(out).toBe(
      '┌─ @bench/top#build > failed (exit 1, 2 sandbox violations)\n' +
        '\n' +
        '$ sleep 3 && mkdir -p dist && touch dist/index.js\n' +
        '\n' +
        '├─ STDERR ──────────────────────────────────────────────────\n' +
        '\n' +
        'touch: dist/index.js: Operation not permitted\n' +
        '\n' +
        '├─ SANDBOX VIOLATIONS (2) ──────────────────────────────────\n' +
        '\n' +
        'touch(32784) deny(1) sysctl-read kern.iossupportversion\n' +
        'touch(32784) deny(1) file-read-metadata /Users/me/proj/packages/top/dist/index.js\n' +
        '\n' +
        '└─ @bench/top#build ── (3.06s) failed (exit 1, 2 sandbox violations)\n',
    )
  })

  it('skipped tasks show 0ms + skipped status, and the blocker when one is recorded', () => {
    // A fail-fast skip has no blocker: the run stopped, and the old header's
    // "(upstream failed)" claimed one that never existed.
    const out = formatTaskBlock(
      node('@vzn/vx#deploy', 'aws s3 sync'),
      outcome('@vzn/vx#deploy', 'skipped'),
      {},
    )
    expect(out).toBe('┌─ @vzn/vx#deploy > skipped\n└─ @vzn/vx#deploy ── (0ms) skipped\n')
    const blocked = formatTaskBlock(
      node('@vzn/vx#deploy', 'aws s3 sync'),
      outcome('@vzn/vx#deploy', 'skipped', { blockedBy: '@vzn/vx#build' }),
      {},
    )
    expect(blocked).toBe(
      '┌─ @vzn/vx#deploy > skipped (blocked by @vzn/vx#build)\n' +
        '└─ @vzn/vx#deploy ── (0ms) skipped (blocked by @vzn/vx#build)\n',
    )
  })

  it('emits no block for group tasks (no exec) — they are pure organization', () => {
    expect(formatTaskBlock(node('@vzn/vx#ci'), outcome('@vzn/vx#ci', 'success'), {})).toBe('')
  })

  it('injects ANSI escapes when colors are enabled', () => {
    const out = formatTaskBlock(
      node('@vzn/vx#lint', 'oxlint .'),
      outcome('@vzn/vx#lint', 'cache-hit', {
        durationMs: 8,
        hash: 'abcdef0123456789',
        restored: true,
      }),
      {},
      { enabled: true },
    )
    expect(out).toContain('\x1b[')
    expect(out).toContain('\x1b[0m')
    // The id renders as two identity-colored halves with a dim
    // separator, so the contiguous string only exists uncolored.
    expect(out).toContain('@vzn/vx')
    expect(out).toContain('lint')
    expect(out).toContain('restored-local')
    expect(out).toContain('abcdef01')
  })

  it('section headers render dim; content lines stay raw (no border, no indent)', () => {
    const out = formatTaskBlock(
      node('@vzn/vx#build', 'tsc'),
      outcome('@vzn/vx#build', 'failed', { durationMs: 1, exitCode: 1 }),
      { stdout: 'out line\n', stderr: 'err line\n' },
      { enabled: true },
    )
    // command renders as a dim `$ cmd` line; section labels are
    // bold + state-colored with a dim trailing rule.
    expect(out).toContain('\x1b[2m$ tsc\x1b[0m')
    expect(out).toContain('\x1b[1m\x1b[38;2;34;197;94mSTDOUT\x1b[0m')
    expect(out).toContain('\x1b[1m\x1b[38;2;239;68;68mSTDERR\x1b[0m')
    expect(out).toContain('\nout line\n')
    expect(out).toContain('\nerr line\n')
    expect(out).not.toContain('│')
  })

  it('failed tasks colorize the failed tag', () => {
    const out = formatTaskBlock(
      node('@vzn/vx#build', 'tsc'),
      outcome('@vzn/vx#build', 'failed', { durationMs: 100, exitCode: 2 }),
      {},
      { enabled: true },
    )
    expect(out).toContain('failed (exit 2)')
    expect(out).toContain('\x1b[1m')
    expect(out).toMatch(/\[38;2;\d+;\d+;\d+m/)
  })
})

describe('persistent task framing', () => {
  it('marks both frame ends with ▸ and closes as running, not success', () => {
    const n = persistentNode('@vzn/vx-docs#dev', 'astro dev')
    const open = formatFrameOpen(n)
    const close = formatFrameClose(n, outcome('@vzn/vx-docs#dev', 'success', { durationMs: 1810 }))
    expect(open).toBe('┌─ ▸ @vzn/vx-docs#dev > $ astro dev')
    expect(close).toBe('└─ ▸ @vzn/vx-docs#dev ── (1.81s) running')
  })

  it('a non-persistent task frame is unmarked and closes as success', () => {
    const n = node('@vzn/vx#lint', 'oxlint .')
    expect(formatFrameOpen(n)).toBe('┌─ @vzn/vx#lint > $ oxlint .')
    expect(formatFrameClose(n, outcome('@vzn/vx#lint', 'success'))).toBe(
      '└─ @vzn/vx#lint ── (0ms) success',
    )
  })

  it('a persistent task that FAILED closes as failed, not running', () => {
    // `running` is the right close only for the success outcome a ready
    // persistent task lands on — its child is still alive. A failed one is
    // over, and closing it as `running` reports a dev server that is up
    // when it is down.
    const n = persistentNode('@vzn/vx-docs#dev', 'astro dev')
    expect(formatFrameClose(n, outcome('@vzn/vx-docs#dev', 'failed', { durationMs: 1810 }))).toBe(
      '└─ ▸ @vzn/vx-docs#dev ── (1.81s) failed (exit 1)',
    )
  })

  it('an empty violation list renders no section at all', () => {
    // `sandboxViolationLines: []` is what a clean sandboxed task carries.
    // Guarding only on the field's presence prints a `SANDBOX VIOLATIONS
    // (0)` heading over nothing, on every task that ran sandboxed.
    const n = node('@vzn/vx#fmt', 'oxfmt .')
    expect(
      formatFrameClose(n, {
        ...outcome('@vzn/vx#fmt', 'failed', { durationMs: 1234 }),
        node: n,
        sandboxViolationLines: [],
      }),
    ).toBe('└─ @vzn/vx#fmt ── (1.23s) failed (exit 1)')
  })

  it('collapses repeated records to unique lines, verbatim', () => {
    // A task's children trip the same denial many times. Only unique lines
    // are printed, and printed UNCHANGED — a violation is evidence, and the
    // count in the header is what is shown, not what was collapsed.
    const n = node('@vzn/vx#test', 'bun test')
    const line = 'bun(1) deny(1) file-read-data /repo'
    const close = formatFrameClose(
      n,
      outcome('@vzn/vx#test', 'failed', {
        durationMs: 10,
        exitCode: 1,
        sandboxViolations: 3,
        sandboxViolationLines: [line, line, 'bun(2) deny(1) file-read-data /repo'],
      }),
    )
    expect(close).toContain('SANDBOX VIOLATIONS (2)')
    expect(close).toContain(line)
    expect(close).toContain('bun(2) deny(1) file-read-data /repo')
  })

  it('the LIVE frame shows sandbox violations too — a focused run is where they are read', () => {
    // The focused/live frame omitted the section entirely, so `vx run
    // <one-task>` — exactly how someone debugging a single task invokes it —
    // printed a failure with no violations at all (owner, 2026-09-05).
    const n = node('@vzn/vx#test', 'bun test')
    const close = formatFrameClose(
      n,
      outcome('@vzn/vx#test', 'failed', {
        durationMs: 1090,
        exitCode: 1,
        sandboxViolations: 1,
        sandboxViolationLines: ['bun(49255) deny(1) file-read-data /repo/packages/vx'],
      }),
    )
    expect(close).toBe(
      '├─ SANDBOX VIOLATIONS (1) ──────────────────────────────────\n' +
        '\n' +
        'bun(49255) deny(1) file-read-data /repo/packages/vx\n' +
        '\n' +
        '└─ @vzn/vx#test ── (1.09s) failed (exit 1, 1 sandbox violation)',
    )
  })

  it('CONTROL: a clean live frame carries no section', () => {
    const n = node('@vzn/vx#lint', 'oxlint .')
    expect(formatFrameClose(n, outcome('@vzn/vx#lint', 'success'))).toBe(
      '└─ @vzn/vx#lint ── (0ms) success',
    )
  })

  it('formatPersistentList renders one ▸ running row per task', () => {
    const lines = formatPersistentList([
      persistentNode('@vzn/vx-docs#dev', 'astro dev'),
      persistentNode('@app/api#dev', 'tsx watch'),
    ])
    expect(lines).toEqual(['  ▸ @vzn/vx-docs#dev running', '  ▸ @app/api#dev running'])
  })
})
