import { expect, test } from 'bun:test'
import { check, marked } from '../src/harness.ts'

const marks = ['+lib#build', '-lib#build', '+app#build', '-app#build']

test('exit codes', () => {
  expect(check({ exit: 0 }, 0, '', [], {})).toBeNull()
  expect(check({ exit: 0 }, 1, '', [], {})).toBe('exited 1, expected success')
  expect(check({ exit: 'fail' }, 0, '', [], {})).toBe('succeeded, expected a failure')
})

test('ran and notRan', () => {
  expect(check({ ran: ['app#build'] }, 0, '', marks, {})).toBeNull()
  expect(check({ ran: ['ui#build'] }, 0, '', marks, {})).toBe('did not run ui#build')
  expect(check({ notRan: ['app#build'] }, 0, '', marks, {})).toBe(
    'ran app#build, expected it replayed or left out',
  )
})

test('a task started twice in one run fails any expectation', () => {
  expect(check({}, 0, '', ['+a#b', '-a#b', '+a#b', '-a#b'], {})).toBe('ran a#b more than once')
})

test('order needs the first to finish before the second starts', () => {
  expect(check({ order: [['lib#build', 'app#build']] }, 0, '', marks, {})).toBeNull()
  expect(check({ order: [['app#build', 'lib#build']] }, 0, '', marks, {})).toBe(
    'lib#build started before app#build finished',
  )
  const overlap = ['+lib#build', '+app#build', '-lib#build', '-app#build']
  expect(check({ order: [['lib#build', 'app#build']] }, 0, '', overlap, {})).not.toBeNull()
})

test('files and output', () => {
  expect(check({ files: { f: 'x' } }, 0, '', [], { f: 'x' })).toBeNull()
  expect(check({ files: { f: 'x' } }, 0, '', [], { f: null })).toBe('f is missing, expected "x"')
  expect(check({ files: { f: null } }, 0, '', [], { f: 'x' })).toBe('f exists, expected none')
  expect(check({ output: ['hello'] }, 0, 'say hello', [], {})).toBeNull()
  expect(check({ output: ['bye'] }, 0, 'say hello', [], {})).toBe('output lacks "bye"')
})

test('a marked command finds the run log from its project directory', () => {
  const ws = { projects: { a: { dir: 'x/y/a', tasks: { build: { command: 'true' } } } } }
  expect(marked(ws, 'a', 'build')).toBe(
    "printf '+%s\\n' 'a#build' >> ../../../.ran && (true) && printf -- '-%s\\n' 'a#build' >> ../../../.ran",
  )
})

test('filesNot fails only the stale text', () => {
  expect(check({ filesNot: { f: 'old' } }, 0, '', [], { f: 'new' })).toBeNull()
  expect(check({ filesNot: { f: 'old' } }, 0, '', [], { f: 'old' })).toBe(
    'f is "old", a stale result',
  )
})

test('ifReplayed judges the files only when the task did not run', () => {
  const want = { ifReplayed: { task: 'a#b', files: { f: 'mine' } } }
  expect(check(want, 0, '', ['+a#b', '-a#b'], { f: 'fresh' })).toBeNull()
  expect(check(want, 0, '', [], { f: 'mine' })).toBeNull()
  expect(check(want, 0, '', [], { f: 'old' })).toBe(
    'a#b replayed and left f "old", expected "mine"',
  )
})
