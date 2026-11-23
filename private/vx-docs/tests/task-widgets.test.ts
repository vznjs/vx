// The tasks page's widgets answer as vx does: which tasks one `dependsOn`
// entry waits for, and whether a declared output must exist.

import { describe, expect, it } from 'bun:test'
import { outputRule, outputsVerdict, waitsOn } from '../src/components/demos/model/task-fields.ts'

describe('dependsOn picker', () => {
  it.each([
    ['^build', ['ui#build']],
    ['gen-*', ['web#gen-icons', 'web#gen-routes']],
    ['lint', ['web#lint']],
    ['api#build', ['api#build']],
    ['ui#test', ['ui#test']],
    ['^test', ['ui#test']],
  ])('%s waits for %p', (entry, tasks) => {
    expect(waitsOn(entry)).toEqual({ ok: true, tasks })
  })

  it.each(['*', '^*', '!lint', 'build', 'api#lint', 'nope#build', 'deploy', '^ui#build', ''])(
    '%p is refused',
    (entry) => {
      expect(waitsOn(entry).ok).toBe(false)
    },
  )
})

describe('output rule', () => {
  it.each([
    ['dist/index.js', 'required'],
    ['dist', 'required'],
    ['dist/**', 'optional'],
    ['.next/**', 'optional'],
    ['coverage/*.json', 'optional'],
    ['', 'empty'],
  ] as const)('%p is %s', (p, r) => {
    expect(outputRule(p)).toBe(r)
  })
})

describe('outputs verdict', () => {
  const all = ['dist/index.js', 'dist/**', 'coverage/**']
  it.each([
    [['dist/index.js'], ['dist/index.js'], true],
    [['dist/index.js'], [], false],
    [['dist/**', 'coverage/**'], ['dist/**'], true],
    [['dist/**'], [], false],
    [all, ['dist/**', 'coverage/**'], false],
    [all, ['dist/index.js'], true],
    [[], [], true],
  ] as const)('%p wrote %p: passes %p', (declared, wrote, ok) => {
    expect(outputsVerdict(declared, new Set(wrote)).ok).toBe(ok)
  })
})
