// A sandboxed `go build` on a fresh home was refused its telemetry file,
// then `mkdir ~/.cache`, and failed on the second. The hint granted only
// the first one's directory, which left the build failing (2026-11-11).
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { outsideWritesHint } from '../src/exec/sandbox-runtime.js'

describe('the refused outside writes hint', () => {
  // Not under the host temp root (a write there is told to use $TMPDIR),
  // and never made: the test checkout is read-only in a sandboxed run.
  const base = `/vx-outside-writes-hint-${process.pid}`
  const home = path.join(base, 'home')
  beforeEach(() => {
    spyOn(os, 'homedir').mockReturnValue(home)
  })
  afterEach(() => {
    mock.restore()
  })
  const hint = (paths: string[], made: string[]): string =>
    outsideWritesHint(paths, new Set(made), [path.join(base, 'ws')], path.join(base, 'ws', 'app'))
      .line

  it('grants every refused write, a refused mkdir as the directory itself', () => {
    const telemetry = `${home}/.config/go/telemetry/local/go@1.24-2026-11-11.v1.count`
    const cache = `${home}/.cache`
    expect(hint([telemetry, cache], [cache])).toEndWith(
      'If the task needs them, grant their directories, e.g. ' +
        "`allow: { write: ['~/.config/go/telemetry/local/', '~/.cache/'] }`.",
    )
  })

  it('never grants home itself, and folds a grant under another', () => {
    // A file right in home is its own grant, never `~/` and never a directory.
    expect(
      hint([`${home}/.npmrc`, `${home}/.cache/a/f`, `${home}/.cache`], [`${home}/.cache`]),
    ).toEndWith(
      'If the task needs them, grant their directories, e.g. ' +
        "`allow: { write: ['~/.npmrc', '~/.cache/'] }`.",
    )
  })

  // `go build` writes `~/.cache/go-build/ab/<hash>-d`: the hint granted
  // `~/.cache/go-build/ab/`, and the next build failed on another subdir.
  it("grants a tool's cache directory under ~/.cache whole", () => {
    expect(hint([`${home}/.cache/go-build/ab/abcd-d`], [])).toEndWith(
      "If the task needs one, grant its directory, e.g. `allow: { write: ['~/.cache/go-build/'] }`.",
    )
  })

  // A home under the host temp root (a CI container's, an agent's) is
  // still home: `go build` was told to write under $TMPDIR, which go
  // never does unless GOCACHE says so, and no grant was named.
  it('a home under the host temp root names the grant, not $TMPDIR', () => {
    const tmpHome = path.join(os.tmpdir(), `vx-home-${process.pid}`)
    spyOn(os, 'homedir').mockReturnValue(tmpHome)
    const line = hint([`${tmpHome}/.cache/go-build/ab/abcd-d`], [])
    expect(line).not.toContain('$TMPDIR')
    expect(line).toEndWith(
      "If the task needs one, grant its directory, e.g. `allow: { write: ['~/.cache/go-build/'] }`.",
    )
  })

  it('CONTROL: one refused write names one grant', () => {
    expect(hint([`${home}/.cache/tool/f`], [])).toEndWith(
      "If the task needs one, grant its directory, e.g. `allow: { write: ['~/.cache/tool/'] }`.",
    )
  })
})
