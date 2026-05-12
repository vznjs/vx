import { describe, expect, it } from 'bun:test'
import { defineProject, defineWorkspace } from './config.js'

describe('defineProject', () => {
  it('is an identity function (returns its input)', () => {
    const cfg = { run: { tasks: { build: { exec: { command: 'tsc' } } } } }
    expect(defineProject(cfg)).toBe(cfg)
  })

  it('preserves nested literal types via the generic', () => {
    const cfg = defineProject({
      run: {
        tasks: {
          build: {
            exec: { command: 'tsc' },
            cache: { inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] } },
          },
        },
      },
    })
    expect(cfg.run?.tasks?.build?.cache?.outputs.files).toEqual(['dist/**'])
  })
})

describe('defineWorkspace', () => {
  it('is an identity function (returns its input)', () => {
    const cfg = { concurrency: 4 }
    expect(defineWorkspace(cfg)).toBe(cfg)
  })
})
