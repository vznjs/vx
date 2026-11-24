// A frame's `$ <command>` line is what ran: a requested task's line
// carries the args after `--`, shell-quoted; a dependency's, which got
// none, does not. The line showed the bare config command (X-41).
import { realpath, rm } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { addProject, makeWorkspace } from './helpers/workspace.js'

const BIN = path.resolve(import.meta.dir, 'helpers', 'vx-locked.ts')

describe('the $ line under forwarded args', () => {
  let root = ''
  let dir = ''
  beforeEach(async () => {
    root = await realpath(await makeWorkspace({ prefix: 'vx-fwd-frame-' }))
    dir = await addProject(
      root,
      'a',
      `export default {
        tasks: {
          dep: { exec: { command: 'echo dep' } },
          say: { dependsOn: ['dep'], exec: { command: 'echo said' } },
        },
      }
      `,
    )
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  const commandLines = (...args: string[]): string[] => {
    const r = Bun.spawnSync([process.execPath, BIN, 'run', ...args], {
      cwd: dir,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, CI: '', GITHUB_ACTIONS: '', NO_COLOR: '1' },
    })
    if (r.exitCode !== 0) throw new Error(r.stderr.toString())
    return r.stdout
      .toString()
      .split('\n')
      .filter((l) => l.includes('$ '))
  }

  it("the requested task's frame shows the args it ran with (X-41)", () => {
    expect(commandLines('say', '--output-logs=full', '--', 'two words', '--x')).toEqual([
      'packages/a $ echo dep',
      "packages/a $ echo said 'two words' --x",
    ])
    // The live frame a single focused request opens.
    expect(commandLines('say', '--', 'two words', '--x')).toEqual([
      "┌─ a#say > $ echo said 'two words' --x",
    ])
  })
})

// `--dry` shows the command as the run would run it: the requested task's
// with the args after `--`, quoted as the run quotes them (M 2026-11-24).
describe('the plan under forwarded args', () => {
  let root = ''
  let dir = ''
  beforeEach(async () => {
    root = await realpath(await makeWorkspace({ prefix: 'vx-fwd-dry-' }))
    dir = await addProject(
      root,
      'a',
      `export default {
        tasks: {
          dep: { exec: { command: 'echo dep' } },
          say: { dependsOn: ['dep'], exec: { command: 'echo said' } },
        },
      }
      `,
    )
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  const dry = (...args: string[]): string => {
    const r = Bun.spawnSync([process.execPath, BIN, 'run', '--dry', ...args], {
      cwd: dir,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, CI: '', GITHUB_ACTIONS: '', NO_COLOR: '1' },
    })
    if (r.exitCode !== 0) throw new Error(r.stderr.toString())
    return r.stdout.toString()
  }

  it('names the command with the args in text', () => {
    expect(dry('say', '--', 'two words', "it's")).toContain(
      `a#say $ echo said 'two words' 'it'\\''s'`,
    )
    expect(dry('say')).not.toContain('$ echo')
  })

  it('gives every task its command as it would run in JSON', () => {
    const plan = JSON.parse(dry('say', '--format', 'json', '--', 'two words')) as {
      tasks: { id: string; command?: string }[]
    }
    expect(
      plan.tasks.map((t) => [t.id, t.command]).sort((a, b) => a[0]!.localeCompare(b[0]!)),
    ).toEqual([
      ['a#dep', 'echo dep'],
      ['a#say', "echo said 'two words'"],
    ])
  })
})
