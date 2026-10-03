// Keys pasted under a task's `exec` from Nx's run-commands options or a
// shell runner name vx's home (D-100).
import { expect, it } from 'bun:test'
import { validateProjectConfig } from '../src/workspace/config-schema.js'

const where = (key: string): string | undefined => {
  try {
    validateProjectConfig(
      { tasks: { t: { exec: { command: 'x', [key]: true } } } } as never,
      'vx.config.ts',
    )
  } catch (err) {
    return (err as Error).message.split(' — ')[1]
  }
  return undefined
}

it("names vx's home for an exec key another tool spells (D-100)", () => {
  expect(where('cwd')).toBe(
    'vx spells it `cd <dir> && …` in `command`: a task runs in its project directory',
  )
  expect(where('args')).toBe(
    'vx spells it the arguments written into `command`, or after `--` on `vx run`',
  )
  expect(where('commands')).toBe(
    'vx spells it one `command` (`a && b`, or `a & b; wait` to run them at once), or one task each',
  )
  expect(where('parallel')).toBe(
    'vx spells it one task each, which vx runs at once, or `a & b; wait` in `command`',
  )
  expect(where('shell')).toBe('vx spells it no field: `command` always runs in a shell')
  // Turbo's spelling is vx's own field.
  expect(where('interactive')).toBeUndefined()
  // CONTROL: a typo still gets the nearest spelling.
  expect(where('comand')).toBe('did you mean command?')
})
