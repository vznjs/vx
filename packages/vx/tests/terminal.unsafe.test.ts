// A vx on a real pseudo-terminal. Unsafe: macOS's sandbox (seatbelt)
// refuses to open a pty ("Failed to open PTY", darwin CI 2026-09-24), so
// a sandboxed shard cannot host these rows; Linux's bwrap allows it.
import { realpath, rm } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { addProject, gitIn, makeWorkspace } from './helpers/workspace.js'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
/** termios `c_lflag` ECHO: the same bit on Linux and macOS. */
const ECHO = 0o10

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

// `exec.interactive` (Turbo #1235, Nx #8269): on a terminal the task gets
// vx's own stdin, stdout and stderr, and a typed line reaches it.
describe('an interactive task under a vx on a terminal', () => {
  const PROBE =
    '[ -t 0 ] && echo IN-TTY; [ -t 1 ] && echo OUT-TTY; echo ASKING; read line; echo "got:[$line]"'

  const onTerminal = async (config: string, task: string) => {
    const root = await makeWorkspace({ prefix: 'vx-interactive-tty-' })
    try {
      await addProject(root, 'app', { config })
      let screen = ''
      let typed = false
      const proc = Bun.spawn([process.execPath, BIN, 'run', task, '--output-logs=full'], {
        cwd: root,
        env: { ...process.env, CI: '', GITHUB_ACTIONS: '', NO_COLOR: '1' },
        terminal: {
          data: (term, data) => {
            screen += new TextDecoder().decode(data)
            // Typed once the task asks: a line typed earlier would sit in
            // the terminal's queue and prove nothing about the hand-over.
            if (!typed && /^ASKING\r?$/m.test(screen)) {
              typed = true
              term.write('hello\r')
            }
          },
        },
      })
      // No echo: the kernel echoes the typed line into vx's output wherever
      // its write has reached: the control row's `got:[]` read `gothello:[]`
      // (2026-10-08). A reader still gets the line.
      proc.terminal!.localFlags &= ~ECHO
      // A vx that never hands the line over waits on it for good: stopped,
      // so a failing row fails in seconds and leaves no server behind.
      const stop = setTimeout(() => proc.kill('SIGTERM'), 8_000)
      const code = await proc.exited
      clearTimeout(stop)
      proc.terminal?.close()
      const lines = screen.split(/\r?\n/)
      return {
        code,
        answers: lines.filter((l) => /^(IN-TTY|OUT-TTY|got:\[.*\])$/.test(l)),
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }

  it('reads what is typed, on the terminal itself', async () => {
    const config = `export default { tasks: { ask: { exec: { command: ${JSON.stringify(PROBE)}, interactive: true } } } }`
    expect(await onTerminal(config, 'app#ask')).toEqual({
      code: 0,
      answers: ['IN-TTY', 'OUT-TTY', 'got:[hello]'],
    })
  }, 20_000)

  it('a server holds it too, and the run ends when it exits', async () => {
    const config = `export default { tasks: { dev: { exec: { command: ${JSON.stringify(PROBE)}, interactive: true, persistent: {} } } } }`
    expect(await onTerminal(config, 'app#dev')).toEqual({
      code: 0,
      answers: ['IN-TTY', 'OUT-TTY', 'got:[hello]'],
    })
  }, 20_000)

  // CONTROL: the same command undeclared reads end of input at once.
  it('without the field the task reads no terminal', async () => {
    const config = `export default { tasks: { ask: { exec: { command: ${JSON.stringify(PROBE)} } } } }`
    expect(await onTerminal(config, 'app#ask')).toEqual({ code: 0, answers: ['got:[]'] })
  }, 20_000)
})

// Every run needs git, so a workspace git does not track is refused before
// the picker asks: the menu came first and the refusal followed the choice.
describe('the picker outside a git work tree', () => {
  it('is never shown: the refusal comes first', async () => {
    // Canonical: vx names its cwd, and macOS's temp dir is a symlink.
    const root = await realpath(await makeWorkspace({ prefix: 'vx-picker-nogit-', git: false }))
    try {
      await addProject(root, 'app', {
        config: `export default { tasks: { build: { exec: { command: 'true' } } } }`,
      })
      let screen = ''
      const proc = Bun.spawn([process.execPath, BIN, 'run'], {
        cwd: root,
        // A ceiling at the fixture's parent: a temp dir inside some repo
        // must not lend the fixture its git.
        env: {
          ...process.env,
          CI: '',
          GITHUB_ACTIONS: '',
          NO_COLOR: '1',
          GIT_CEILING_DIRECTORIES: path.dirname(root),
        },
        terminal: {
          data: (_term, data) => {
            screen += new TextDecoder().decode(data)
          },
        },
      })
      const stop = setTimeout(() => proc.kill('SIGTERM'), 8_000)
      const code = await proc.exited
      clearTimeout(stop)
      proc.terminal?.close()
      expect({ code, lines: screen.split(/\r?\n/).filter((l) => l !== '') }).toEqual({
        code: 1,
        lines: [
          `vx requires git: ${root} is not inside a git work tree. Run 'git init' in your workspace root. (git: fatal: not a git repository (or any of the parent directories): .git)`,
        ],
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 20_000)
})

// `vx last` prints the run's command as a line to paste: a run whose task
// came from the picker recorded `vx run -- x`, which opens the picker again
// and drops the choice.
describe('a task picked on a terminal', () => {
  it('is named in the command `vx last` replays', async () => {
    const root = await makeWorkspace({ prefix: 'vx-picker-tty-' })
    try {
      await addProject(root, 'app', {
        config: `export default { tasks: { build: { exec: { command: 'true' } } } }`,
      })
      let screen = ''
      let typed = false
      const proc = Bun.spawn([process.execPath, BIN, 'run', '--', 'x'], {
        cwd: root,
        env: { ...process.env, CI: '', GITHUB_ACTIONS: '', NO_COLOR: '1' },
        terminal: {
          data: (term, data) => {
            screen += new TextDecoder().decode(data)
            if (!typed && screen.includes('Pick a task [1-1]: ')) {
              typed = true
              term.write('1\r')
            }
          },
        },
      })
      const stop = setTimeout(() => proc.kill('SIGTERM'), 8_000)
      const code = await proc.exited
      clearTimeout(stop)
      proc.terminal?.close()
      const last = Bun.spawnSync([process.execPath, BIN, 'last'], {
        cwd: root,
        env: { ...process.env, NO_COLOR: '1' },
      })
      expect({ code, command: last.stdout.toString().split('\n')[1] }).toEqual({
        code: 0,
        command: '  $ vx run app#build -- x',
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 20_000)
})

// `vx run > out.txt` on a terminal: the menu and prompt went to stdout, so
// they landed in the file and the terminal sat blank, waiting on a number.
describe('the picker with stdout redirected', () => {
  it('asks on the terminal, and only the run reaches the file', async () => {
    const root = await makeWorkspace({ prefix: 'vx-picker-redirect-' })
    try {
      await addProject(root, 'app', {
        config: `export default { tasks: { build: { exec: { command: 'echo BUILT' } } } }`,
      })
      let screen = ''
      let typed = false
      const proc = Bun.spawn(['sh', '-c', `"${process.execPath}" "${BIN}" run > out.txt`], {
        cwd: root,
        env: { ...process.env, CI: '', GITHUB_ACTIONS: '', NO_COLOR: '1' },
        terminal: {
          data: (term, data) => {
            screen += new TextDecoder().decode(data)
            if (!typed && screen.includes('Pick a task [1-1]: ')) {
              typed = true
              term.write('1\r')
            }
          },
        },
      })
      const stop = setTimeout(() => proc.kill('SIGTERM'), 8_000)
      const code = await proc.exited
      clearTimeout(stop)
      proc.terminal?.close()
      const file = await Bun.file(path.join(root, 'out.txt')).text()
      expect({
        code,
        asked: screen.includes('1. app#build'),
        built: file.includes('BUILT'),
        menuInFile: file.includes('Pick a task'),
      }).toEqual({ code: 0, asked: true, built: true, menuInFile: false })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 20_000)
})

// `--filter` scopes the menu as it scopes a bare task: the picker listed
// every project, and an anchored pick ran outside the filter.
describe('the picker under --filter', () => {
  it('lists only the selected projects and runs the pick', async () => {
    const root = await makeWorkspace({ prefix: 'vx-picker-filter-' })
    try {
      for (const name of ['alpha', 'beta']) {
        await addProject(root, name, {
          config: `export default { tasks: { build: { exec: { command: 'echo BUILT-${name}' } } } }`,
        })
      }
      let screen = ''
      let typed = false
      const proc = Bun.spawn(
        [process.execPath, BIN, 'run', '--filter', 'beta', '--output-logs=full'],
        {
          cwd: root,
          env: { ...process.env, CI: '', GITHUB_ACTIONS: '', NO_COLOR: '1' },
          terminal: {
            data: (term, data) => {
              screen += new TextDecoder().decode(data)
              if (!typed && screen.includes('Pick a task [')) {
                typed = true
                term.write('1\r')
              }
            },
          },
        },
      )
      const stop = setTimeout(() => proc.kill('SIGTERM'), 8_000)
      const code = await proc.exited
      clearTimeout(stop)
      proc.terminal?.close()
      const lines = screen.split(/\r?\n/)
      expect({
        code,
        menu: lines.filter((l) => /^\s+\d+\. /.test(l)).map((l) => l.trim()),
        ran: lines.filter((l) => l.startsWith('BUILT-')),
      }).toEqual({ code: 0, menu: ['1. beta#build'], ran: ['BUILT-beta'] })
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

  // A task's stdout is a pipe, so vx forces colour (owner, 2026-10-03,
  // reversing the nx#23259 stance) and strips it where it prints plain. A
  // task that writes its own output to a file sets FORCE_COLOR=0 itself.
  it('vx on a terminal sets FORCE_COLOR=1 for a task, and NO_COLOR keeps it unset', async () => {
    const env: Record<string, string> = { CI: '', GITHUB_ACTIONS: '' }
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined && k !== 'NO_COLOR' && k !== 'FORCE_COLOR' && k !== 'CI') env[k] = v
    }
    const onTerminal = async (extra: Record<string, string>) => {
      let screen = ''
      const proc = Bun.spawn([process.execPath, BIN, 'run', 'fc', '--all', '--output-logs=full'], {
        cwd: root,
        env: { ...env, ...extra },
        terminal: {
          data: (_term, data) => {
            screen += new TextDecoder().decode(data)
          },
        },
      })
      const code = await proc.exited
      proc.terminal?.close()
      return {
        code,
        painted: screen.includes('\x1b[38;2;'),
        task: /^FC=\[[^\]\r\n]*\]/m.exec(screen)?.[0],
      }
    }
    expect([await onTerminal({}), await onTerminal({ NO_COLOR: '1' })]).toEqual([
      { code: 0, painted: true, task: 'FC=[1]' },
      { code: 0, painted: false, task: 'FC=[]' },
    ])
  })
})
