import { describe, expect, it } from 'bun:test'
import { defineProject, defineWorkspace } from '../src/config.js'

describe('defineProject', () => {
  it('is an identity function (returns its input)', () => {
    const cfg = { tasks: { build: { exec: { command: 'tsc' } } } }
    expect(defineProject(cfg)).toBe(cfg)
  })

  it('preserves nested literal types via the generic', () => {
    const cfg = defineProject({
      tasks: {
        build: {
          exec: { command: 'tsc' },
          cache: { inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] } },
        },
      },
    })
    expect(cfg.tasks?.build?.cache?.outputs.files).toEqual(['dist/**'])
  })

  it('type-checks dependsOn bare entries against task keys', () => {
    // The valid forms: bare task key, `^name` (dep workspaces, incl.
    // `^all`), and `pkg#name` (cross-project). These must type-check.
    const cfg = defineProject({
      tasks: {
        build: { exec: { command: 'tsc' } },
        ci: { dependsOn: ['build', '^all', '^build', 'pkg#build'] },
      },
    })
    expect(cfg.tasks?.ci?.dependsOn).toContain('^all')
  })

  it('rejects a dependsOn entry that is not a task key', () => {
    defineProject({
      tasks: {
        build: { exec: { command: 'tsc' } },
        // @ts-expect-error 'biuld' is not a declared task key (typo of 'build').
        ci: { dependsOn: ['biuld'] },
      },
    })
  })
})

describe('defineWorkspace', () => {
  it('is an identity function (returns its input)', () => {
    const cfg = { concurrency: 4 }
    expect(defineWorkspace(cfg)).toBe(cfg)
  })
})
