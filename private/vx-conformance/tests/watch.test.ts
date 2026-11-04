import { expect, test } from 'bun:test'
import { awaitPhase, type Seen } from '../src/harness.ts'

/** A watch whose marks and files follow `script`, one state per poll; the last state holds. */
function replay(script: Seen[]): () => Promise<Seen> {
  let i = 0
  return async () => script[Math.min(i++, script.length - 1)]!
}

const fast = { timeoutMs: 400, quietMs: 60, pollMs: 5, alive: () => true }
const built = { marks: ['+app#build', '-app#build'], files: { out: 'a2' } }

test('a phase passes once the task ran to its end, the files hold, and the watch went quiet', async () => {
  const seen = replay([
    { marks: [], files: { out: 'a1' } },
    { marks: ['+app#build'], files: {} },
    built,
  ])
  expect(await awaitPhase({ ran: ['app#build'], files: { out: 'a2' } }, seen, fast)).toBeNull()
})

test('a task that never runs fails with what was missing when the time ran out', async () => {
  const seen = replay([{ marks: [], files: { out: 'a1' } }])
  expect(await awaitPhase({ ran: ['app#build'], files: { out: 'a2' } }, seen, fast)).toBe(
    'after 0.4 s: did not run app#build',
  )
  expect(await awaitPhase({ files: { out: 'a2' } }, seen, fast)).toBe(
    'after 0.4 s: out is "a1", expected "a2"',
  )
})

test('a task started and not yet ended has not run', async () => {
  const seen = replay([{ marks: ['+app#build'], files: { out: 'a2' } }])
  expect(await awaitPhase({ ran: ['app#build'] }, seen, fast)).toBe(
    'after 0.4 s: app#build started and did not finish',
  )
})

test('a run that follows the expected one inside the quiet window is a rerun', async () => {
  const seen = replay([
    built,
    built,
    { ...built, marks: [...built.marks, '+app#build', '-app#build'] },
  ])
  expect(await awaitPhase({ ran: ['app#build'] }, seen, fast)).toBe('ran app#build more than once')
})

test('nothing expected to run holds only through a quiet window', async () => {
  const rerun = replay([
    { marks: [], files: {} },
    { marks: [], files: {} },
    { marks: ['+app#build', '-app#build'], files: {} },
  ])
  expect(await awaitPhase({ notRan: ['app#build'] }, rerun, fast)).toBe(
    'ran app#build, expected it replayed or left out',
  )
  expect(
    await awaitPhase({ notRan: ['app#build'] }, replay([{ marks: [], files: {} }]), fast),
  ).toBeNull()
})

test('a watch that never goes quiet fails as one that keeps running', async () => {
  let n = 0
  const forever = async (): Promise<Seen> => {
    n++
    return {
      marks: Array.from({ length: n }, (_, i) => (i % 2 ? '-app#build' : '+app#build')),
      files: {},
    }
  }
  expect(await awaitPhase({}, forever, fast)).toBe('after 0.4 s: still running tasks, never quiet')
})

test('an in-flight check passes the moment it holds, a task still running', async () => {
  const seen = replay([{ marks: ['+app#build'], files: { started: 'a2' } }])
  expect(await awaitPhase({ files: { started: 'a2' }, inFlight: true }, seen, fast)).toBeNull()
})

test('a watch that exits fails the phase at once', async () => {
  const seen = replay([{ marks: [], files: {} }])
  expect(await awaitPhase({ ran: ['app#build'] }, seen, { ...fast, alive: () => false })).toBe(
    'the watch exited',
  )
})

test('order holds within the phase', async () => {
  const seen = replay([
    { marks: ['+lib#build', '-lib#build', '+app#build', '-app#build'], files: {} },
  ])
  expect(
    await awaitPhase(
      { ran: ['lib#build', 'app#build'], order: [['lib#build', 'app#build']] },
      seen,
      fast,
    ),
  ).toBeNull()
  expect(
    await awaitPhase(
      { ran: ['lib#build', 'app#build'], order: [['app#build', 'lib#build']] },
      seen,
      fast,
    ),
  ).toBe('lib#build started before app#build finished')
})
