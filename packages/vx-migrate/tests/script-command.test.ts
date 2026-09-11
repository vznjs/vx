import { describe, expect, it } from 'bun:test'
import { scriptCommand } from '../src/script-command.js'

describe('scriptCommand — a script body becomes the task command', () => {
  it('inlines a body that stands on its own in sh', () => {
    expect(scriptCommand('build', 'tsc -b')).toBe('tsc -b')
    expect(scriptCommand('build', 'pnpm run clean && tsc -b')).toBe('pnpm run clean && tsc -b')
    expect(scriptCommand('build', 'npm-run-all clean --parallel build:code')).toBe(
      'npm-run-all clean --parallel build:code',
    )
    // `run` inside a word or an argument is not the builtin.
    expect(scriptCommand('test', 'vitest run')).toBe('vitest run')
    expect(scriptCommand('test', 'prerun-check && vitest')).toBe('prerun-check && vitest')
  })

  it("routes a body that calls yarn's `run` builtin through `yarn run <name>`", () => {
    // strapi, 2026-09-11: every package script is `run -T <root bin>`.
    expect(scriptCommand('build:code', 'run -T rollup -c')).toBe('yarn run build:code')
    expect(scriptCommand('build', 'run -T npm-run-all clean --parallel build:code')).toBe(
      'yarn run build',
    )
    expect(scriptCommand('build', 'run clean && run build:code')).toBe('yarn run build')
    expect(scriptCommand('build', 'tsc -b; run copy')).toBe('yarn run build')
  })
})
