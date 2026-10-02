// A task written as package.json's `name: 'command'` names the object
// that holds the command.
import { expect, it } from 'bun:test'
import { validateProjectConfig } from '../src/workspace/config-schema.js'

const refusal = (task: unknown): string => {
  try {
    validateProjectConfig({ tasks: { x: task } } as never, 'vx.config.ts')
  } catch (err) {
    return (err as Error).message
  }
  return 'accepted'
}

it('a task given as a command string names { exec: { command } }', () => {
  expect(refusal("tsc -b 'src'")).toBe(
    `vx.config.ts: tasks.x must be an object — a command is { exec: { command: "tsc -b 'src'" } }`,
  )
  // CONTROLS: an empty string and any other non-object keep the bare message.
  expect(refusal(' ')).toBe('vx.config.ts: tasks.x must be an object')
  expect(refusal(null)).toBe('vx.config.ts: tasks.x must be an object')
  expect(refusal(true)).toBe('vx.config.ts: tasks.x must be an object')
})
