// The line an `nx:run-commands` target runs as: exact text per option
// shape (Nx's run-commands.impl.ts, 22.7 = 23.2), and — where the line is
// a program of its own (parallel, forwarding) — what it DOES under sh.
// `nx.test.ts` drives the same shapes through a real `vx run`, and
// `nx-exec-live.test.ts` holds them to real Nx.
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mapRunCommands } from '../src/nx-command.js'

const CTX = { projectRel: 'packages/a', projectName: 'a' }
/** The helper every line that forwards arguments to more than one command starts with. */
const NX_RUN = `nx_run() { nx_c=$1; shift; if [ $# -eq 0 ]; then eval "$nx_c"; else eval "$nx_c \\"\\$@\\""; fi; }; `

function line(options: Record<string, unknown>, ctx = CTX) {
  const todos: string[] = []
  const out = mapRunCommands(options, ctx, todos)
  return { out, todos }
}

describe('where Nx ran it, with its placeholders expanded', () => {
  it('runs from the workspace root by default: a cd from the project dir, {projectRoot} expanded', () => {
    // storybook's `compile`, 2026-09-11.
    expect(
      line(
        { command: 'node ./scripts/build/build-package.ts --cwd {projectRoot}' },
        { projectRel: 'code/lib/cli', projectName: 'cli' },
      ),
    ).toEqual({
      out: {
        command: 'cd ../../.. && node ./scripts/build/build-package.ts --cwd code/lib/cli',
        env: {},
        readyWhen: undefined,
      },
      todos: [],
    })
  })

  it('expands {projectName} and {workspaceRoot}', () => {
    expect(
      line(
        { command: 'yarn task build --template={projectName} --root {workspaceRoot}' },
        { projectRel: 'sandbox/react-vite', projectName: 'react-vite' },
      ).out?.command,
    ).toBe('cd ../.. && yarn task build --template=react-vite --root .')
  })

  it('stays in the project dir when cwd is {projectRoot} or the project path', () => {
    for (const cwd of ['{projectRoot}', 'packages/a', 'packages/a/']) {
      expect(line({ command: 'yarn vitest', cwd }).out?.command).toBe('yarn vitest')
    }
  })

  it('cds to another declared cwd, relative to the project dir; an absolute one as it is', () => {
    const b = { projectRel: 'packages/pkg-b', projectName: 'pkg-b' }
    expect(line({ command: 'make', cwd: 'packages/pkg-b/sub' }, b).out?.command).toBe(
      'cd sub && make',
    )
    expect(line({ command: 'make', cwd: '{workspaceRoot}' }, b).out?.command).toBe(
      'cd ../.. && make',
    )
    expect(line({ command: 'make', cwd: '/srv/my build' }, b).out?.command).toBe(
      "cd '/srv/my build' && make",
    )
  })

  it('the workspace-root project runs there without a cd', () => {
    expect(
      line({ command: 'echo root ci' }, { projectRel: '.', projectName: 'root' }).out?.command,
    ).toBe('echo root ci')
  })
})

describe('commands: one shell each, parallel unless `parallel: false` (nx#28477)', () => {
  it('the default is parallel: background jobs, the first failure TERMs the group and fails the line', () => {
    expect(line({ commands: ['tsc -b', 'echo done'] }).out?.command).toBe(
      NX_RUN +
        `nx_run_commands() { trap 'trap "" TERM; kill -TERM 0; exit 1' USR1; ` +
        `{ (nx_run 'tsc -b' "$@") || kill -USR1 $$; } & { (nx_run 'echo done' "$@") || kill -USR1 $$; } & wait; }; ` +
        'cd ../.. && nx_run_commands',
    )
  })

  it('`parallel: false` runs them in order, each in a subshell, stopping at the first failure', () => {
    expect(
      line({ commands: ['tsc -b', { command: 'echo done' }], parallel: false }).out?.command,
    ).toBe(
      NX_RUN +
        `nx_run_commands() { (nx_run 'tsc -b' "$@") && (nx_run 'echo done' "$@"); }; cd ../.. && nx_run_commands`,
    )
  })

  it('a comment in a command that takes no arguments does not swallow the paren that closes it', () => {
    expect(
      line({ commands: ['echo a # note', 'echo b'], parallel: false, forwardAllArgs: false }).out
        ?.command,
    ).toBe('nx_run_commands() { (echo a # note\n) && (echo b); }; cd ../.. && nx_run_commands')
  })
})

describe('what the line does under sh', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'vx-nx-rc-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  /** Runs the line as vx does: `sh -c`, its own process group, from the project dir (here: the root). */
  async function sh(command: string, args: string[] = []) {
    const quoted = args.map((a) => `'${a.replaceAll("'", "'\\''")}'`).join(' ')
    const p = Bun.spawn(['sh', '-c', args.length > 0 ? `${command} ${quoted}` : command], {
      cwd: dir,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      detached: true,
    })
    const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited])
    return { code, out }
  }

  const root = { projectRel: '.', projectName: 'r' }

  it('parallel: a failing check ends the line at once and TERMs the server beside it', async () => {
    // The server never exits by itself: run in order, the check never ran.
    const server =
      'trap "echo terminated > term.txt; exit 143" TERM; : > up; while :; do sleep 0.05; done'
    const check = 'while [ ! -f up ]; do sleep 0.01; done; echo check-failed; exit 3'
    const { out } = line({ commands: [server, check] }, root)
    const r = await sh(out!.command)
    // Nx's exit for a failed parallel run is 1, whatever the command's was.
    expect({ code: r.code, out: r.out.trim() }).toEqual({ code: 1, out: 'check-failed' })
    const term = Bun.file(path.join(dir, 'term.txt'))
    for (let i = 0; i < 200 && !(await term.exists()); i++) await Bun.sleep(10)
    expect((await term.text()).trim()).toBe('terminated')
  }, 10_000)

  it('parallel: both run at once, and the line succeeds when both have', async () => {
    // A rendezvous: each waits (bounded) for the other's file, so in order
    // the first would give up and fail.
    const meet = (mine: string, theirs: string) =>
      `: > ${mine}; i=0; while [ ! -f ${theirs} ]; do i=$((i+1)); [ $i -gt 300 ] && exit 9; sleep 0.01; done; echo ${mine}`
    const { out } = line({ commands: [meet('a', 'b'), meet('b', 'a')] }, root)
    const r = await sh(out!.command)
    expect({ code: r.code, lines: r.out.trim().split('\n').sort() }).toEqual({
      code: 0,
      lines: ['a', 'b'],
    })
  }, 10_000)

  it('serial: one command’s exit or cd stays in its own shell, and a failure stops the rest', async () => {
    const ok = line(
      {
        commands: ['cd / ; echo first', 'pwd > where.txt', 'exit 0', 'echo last'],
        parallel: false,
      },
      root,
    )
    const r = await sh(ok.out!.command)
    expect({ code: r.code, out: r.out.trim().split('\n') }).toEqual({
      code: 0,
      out: ['first', 'last'],
    })
    expect((await Bun.file(path.join(dir, 'where.txt')).text()).trim()).toBe(await realpath(dir))
    const failed = line({ commands: ['echo one', 'exit 4', 'echo never'], parallel: false }, root)
    const f = await sh(failed.out!.command)
    expect({ code: f.code, out: f.out.trim() }).toEqual({ code: 4, out: 'one' })
  })

  it('a command ending in `done` runs: no arguments, no words after it', async () => {
    const { out } = line(
      { commands: ['for i in 1 2; do echo $i; done', 'echo b'], parallel: false },
      root,
    )
    const r = await sh(out!.command)
    expect({ code: r.code, out: r.out.trim().split('\n') }).toEqual({
      code: 0,
      out: ['1', '2', 'b'],
    })
  })

  it('forwarded arguments reach EVERY command, and none when forwardAllArgs is off (nx#12165)', async () => {
    const { out } = line(
      {
        commands: [
          'echo one',
          { command: 'echo two' },
          { command: 'echo three', forwardAllArgs: false },
        ],
        parallel: false,
      },
      root,
    )
    const r = await sh(out!.command, ['--otp=123', 'it s'])
    expect(r.out.trim().split('\n')).toEqual(['one --otp=123 it s', 'two --otp=123 it s', 'three'])
  })
})

describe('an empty command list is a no-op, as Nx completes it (nx#31345)', () => {
  it('maps to `true`, no todo', () => {
    expect(line({ commands: [] })).toEqual({
      out: { command: 'true', env: {}, readyWhen: undefined },
      todos: [],
    })
  })
})

describe('arguments as Nx builds them (nx#12165)', () => {
  it('an option run-commands does not consume is forwarded to each command as --name=value', () => {
    expect(
      line({
        commands: ['tsc -b', 'echo done'],
        parallel: false,
        outFile: 'packages/a/build/main.js',
        watch: false,
        mode: 'a b',
        nested: { no: 'objects' },
      }).out?.command,
    ).toBe(
      NX_RUN +
        `nx_run_commands() { (nx_run 'tsc -b --outFile=packages/a/build/main.js --watch=false --mode="a b"' "$@") && ` +
        `(nx_run 'echo done --outFile=packages/a/build/main.js --watch=false --mode="a b"' "$@"); }; cd ../.. && nx_run_commands`,
    )
  })

  it('a single forwarding command is the plain line: vx appends the arguments to it', () => {
    expect(line({ command: 'vite build', args: '--mode=prod' }).out?.command).toBe(
      'cd ../.. && vite build --mode=prod',
    )
  })

  it('`{args}` takes the forwarded options, the arguments and `args`; `{args.name}` one of them', () => {
    expect(
      line({ command: 'deploy {args} --yes', env: undefined, region: 'eu', args: '--tag=x' }).out
        ?.command,
    ).toBe(
      'nx_run_commands() { (deploy --region=eu "$@" --tag=x --yes); }; cd ../.. && nx_run_commands',
    )
    const dotted = line({
      command: 'echo {args.region}-{args.tag}-{args.missing}',
      region: 'eu',
      args: '--tag x',
    })
    expect(dotted.out?.command).toBe(
      'nx_run_commands() { (echo eu-x-); }; cd ../.. && nx_run_commands',
    )
    expect(dotted.todos).toEqual([
      '`{args.*}` is filled from the target’s options — a value passed after `vx run … --` does not reach it',
    ])
  })

  it('an option `args` overrides sets, by value, is not forwarded twice', () => {
    expect(line({ command: 'run', mode: 'dev', args: '--mode=prod' }).out?.command).toBe(
      'cd ../.. && run --mode=prod',
    )
  })

  it('what Nx refuses is the placeholder with its reason', () => {
    expect(line({ command: 'x {args} {args.y}' })).toEqual({
      out: null,
      todos: ['nx:run-commands: Nx refuses a command with both `{args}` and `{args.*}`'],
    })
    expect(line({ commands: ['a', 'b'], parallel: false, readyWhen: 'up' })).toEqual({
      out: null,
      todos: ['nx:run-commands: Nx refuses `readyWhen` without `parallel: true`'],
    })
  })
})

describe('env, color and readyWhen (nx#20465)', () => {
  it('`env` is exec.env.define; `color` sets FORCE_COLOR as Nx does', () => {
    expect(
      line({ command: 'echo $OUTPUT_PATH', env: { OUTPUT_PATH: 'abc', N: 3 }, color: true }),
    ).toEqual({
      out: {
        command: 'cd ../.. && echo $OUTPUT_PATH',
        env: { OUTPUT_PATH: 'abc', N: '3', FORCE_COLOR: 'true' },
        readyWhen: undefined,
      },
      todos: [],
    })
  })

  it('`readyWhen` is the persistent pattern, escaped; several strings are a todo', () => {
    expect(line({ command: 'serve', readyWhen: 'Local: (http)' }).out?.readyWhen).toBe(
      'Local: \\(http\\)',
    )
    const many = line({ commands: ['api', 'web'], readyWhen: ['api up', 'web up'] })
    expect(many.out?.readyWhen).toBe('api up|web up')
    expect(many.todos).toEqual([
      'nx:run-commands: Nx waits for every `readyWhen` string ("api up", "web up"); vx takes one pattern, so the task is ready on the first of them',
    ])
  })

  it('what it does not reproduce is reported, never dropped', () => {
    expect(
      line({
        commands: [{ command: 'a', prefix: 'A' }, 'b'],
        envFile: 'packages/a/.env.custom',
        streamOutput: false,
      }).todos,
    ).toEqual([
      'nx:run-commands: `envFile` "packages/a/.env.custom" is not loaded — put its variables in `env`, or in exec.env in a vx.config',
      'nx:run-commands: `streamOutput: false` — vx shows the output per its own modes',
      'nx:run-commands: per-command `prefix` / `color` output decoration is not reproduced',
    ])
  })
})
