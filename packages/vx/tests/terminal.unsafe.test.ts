// A vx on a real pseudo-terminal. Unsafe: macOS's sandbox (seatbelt)
// refuses to open a pty ("Failed to open PTY", darwin CI 2026-09-24), so
// a sandboxed shard cannot host these rows; Linux's bwrap allows it.
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { addProject, gitIn, makeWorkspace } from './helpers/workspace.js'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')

// turborepo#12502: a task that touched the terminal hung the run when the
// runner itself sat on one (stopped by SIGTTIN/SIGTTOU, or blocked reading
// keys nobody typed). vx starts each task in its own session with no
// controlling terminal, so /dev/tty cannot be opened at all. The run here
// sits on a real pseudo-terminal: without that, "no terminal" is true of
// any CI box and proves nothing.
describe('a task under a vx that runs on a terminal', () => {
  it('cannot open /dev/tty, fails that open at once, and the run completes', async () => {
    const root = await makeWorkspace({ prefix: 'vx-runner-tty-' })
    try {
      await addProject(root, 'app', {
        config: `
          export default {
            tasks: {
              probe: {
                exec: {
                  command: 'if stty -echo < /dev/tty; then echo HAD-TTY; else echo NO-TTY; fi; head -c1 < /dev/tty; echo AFTER-READ',
                },
              },
            },
          }
        `,
      })
      let screen = ''
      const proc = Bun.spawn([process.execPath, BIN, 'run', 'app#probe', '--output-logs=full'], {
        cwd: root,
        env: { ...process.env, CI: '', GITHUB_ACTIONS: '', NO_COLOR: '1' },
        terminal: {
          data: (_term, data) => {
            screen += new TextDecoder().decode(data)
          },
        },
      })
      const code = await proc.exited
      proc.terminal?.close()
      // The echoed command line holds every marker, so the task's own
      // output is read as whole lines.
      const lines = screen.split(/\r?\n/)
      expect({
        code,
        answers: lines.filter((l) => ['HAD-TTY', 'NO-TTY', 'AFTER-READ'].includes(l)),
        refusals: lines.filter((l) => l.includes('/dev/tty') && !l.startsWith('$ ')).length,
      }).toEqual({ code: 0, answers: ['NO-TTY', 'AFTER-READ'], refusals: 2 })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 20_000)
})

describe('a vx that paints its own output on a terminal', () => {
  let root: string
  beforeEach(async () => {
    root = await makeWorkspace({ prefix: 'vx-terminal-' })
    await addProject(root, 'app', {
      config: `
        export default {
          tasks: {
            fc: { exec: { command: 'echo "FC=[$FORCE_COLOR]"' } },
          },
        }
      `,
    })
    const git = gitIn(root)
    git('add', '-A')
    git('commit', '-q', '-m', 'init')
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  // nx#23259: the runner forced FORCE_COLOR into every task, so a task
  // writing to a pipe or a file got escapes. vx paints its own output on a
  // terminal and leaves the task's environment as the host set it.
  it('vx painting its own output on a terminal sets no FORCE_COLOR for the task', async () => {
    const env: Record<string, string> = { CI: '', GITHUB_ACTIONS: '' }
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined && k !== 'NO_COLOR' && k !== 'FORCE_COLOR' && k !== 'CI') env[k] = v
    }
    let screen = ''
    const proc = Bun.spawn([process.execPath, BIN, 'run', 'fc', '--all', '--output-logs=full'], {
      cwd: root,
      env,
      terminal: {
        data: (_term, data) => {
          screen += new TextDecoder().decode(data)
        },
      },
    })
    const code = await proc.exited
    proc.terminal?.close()
    expect({
      code,
      painted: screen.includes('\x1b[38;2;'),
      task: /^FC=\[[^\]\r\n]*\]/m.exec(screen)?.[0],
    }).toEqual({ code: 0, painted: true, task: 'FC=[]' })
  })
})
