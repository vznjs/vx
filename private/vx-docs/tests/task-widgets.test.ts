// The tasks page's widgets answer as vx does: which tasks one `dependsOn`
// entry waits for, and whether a declared output must exist.

import { describe, expect, it } from 'bun:test'
import { outputRule, waitsOn } from '../src/components/demos/model/task-fields.ts'

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
