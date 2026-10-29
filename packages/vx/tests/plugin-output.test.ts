// The `output` capability: a plugin may take the terminal for a run (the
// seam a TUI plugin needs). The first Logger returned renders everything;
// a decline leaves core's renderer; a throw hands the rest back to core.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'bun:test'
import { localWorkspaceSource } from './helpers/local-workspace.js'
import { pluginSource } from './helpers/plugin.js'
import { gitInitCommit } from './helpers/workspace.js'

const CLI = path.join(import.meta.dir, 'helpers', 'vx-locked.ts')
const roots: string[] = []
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

/** A Logger, as source, that prints one line per call it gets. */
const PRINTER = `{
  status: (line) => process.stdout.write('status ' + line.split('\\n')[0] + '\\n'),
  taskStdout: (node, chunk) => process.stdout.write('out ' + node.id + ' ' + chunk),
  taskStderr: () => {},
  taskComplete: (node, outcome) => process.stdout.write('done ' + node.id + ' ' + outcome.status + '\\n'),
  runStart: (info) => process.stdout.write('start ' + info.total + '\\n'),
  runEnd: () => process.stdout.write('end\\n'),
}`

async function fixture(plugins: string[]): Promise<string> {
  const root = mkdtempSync(path.join(tmpdir(), 'vx-output-'))
  roots.push(root)
  await Bun.write(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'root', private: true, workspaces: ['pkg-a'] }),
  )
  await Bun.write(path.join(root, 'pkg-a/package.json'), JSON.stringify({ name: 'pkg-a' }))
  await Bun.write(
    path.join(root, 'pkg-a/vx.config.mjs'),
    `export default { tasks: { hello: { exec: { command: 'echo hi' } } } }\n`,
  )
  await Bun.write(path.join(root, '.vx/workspace.mjs'), localWorkspaceSource(plugins))
  gitInitCommit(root)
  return root
}

function vx(root: string, ...args: string[]): { code: number; stdout: string; stderr: string } {
  return vxWith({}, root, ...args)
}

function vxWith(
  env: Record<string, string>,
  root: string,
  ...args: string[]
): { code: number; stdout: string; stderr: string } {
  const r = Bun.spawnSync({
    cmd: [process.execPath, CLI, 'run', 'pkg-a#hello', '--no-cache', ...args],
    cwd: root,
    env: { ...process.env, CI: '', NO_COLOR: '1', ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return { code: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() }
}

describe('the output stage', () => {
  it('the first plugin to return a Logger renders the whole run; core prints nothing', async () => {
    const root = await fixture([
      pluginSource('org/quiet', `{ output() { return undefined } }`),
      pluginSource(
        'org/tui',
        `{ output(ctx) {
          process.stdout.write('ctx ' + [ctx.isTTY, ctx.ci].join(' ') + '\\n')
          return ${PRINTER}
        } }`,
      ),
      pluginSource('org/late', `{ output() { throw new Error('never asked') } }`),
    ])
    const r = vx(root)
    expect(r.code).toBe(0)
    const lines = r.stdout.split('\n')
    expect(lines.slice(0, 5)).toEqual([
      'ctx false false',
      'start 1',
      'out pkg-a#hello hi',
      'done pkg-a#hello success',
      'end',
    ])
    expect(
      lines.filter((l) => l !== '' && !/^(ctx|start|out|done|status|end)( |$)/.test(l)),
    ).toEqual([])
    // Core's summary still reaches the terminal, through the plugin.
    expect(lines.slice(5).some((l) => l.startsWith('status '))).toBe(true)
  })

  it('a plugin that declines leaves core rendering', async () => {
    const root = await fixture([pluginSource('org/quiet', `{ output() { return undefined } }`)])
    const r = vx(root)
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('pkg-a#hello')
    expect(r.stdout).toContain('hi')
  })

  it('a Logger missing a method is refused with a warning, and core renders', async () => {
    const root = await fixture([pluginSource('org/bad', `{ output() { return { status() {} } } }`)])
    const r = vx(root)
    expect(r.code).toBe(0)
    expect(r.stderr).toContain(
      "[vx] plugin 'org/bad' output: output Logger has no taskStdout, taskStderr, taskComplete; vx renders the run",
    )
    expect(r.stdout).toContain('hi')
  })

  it('a Logger that throws hands the rest of the run to core', async () => {
    const root = await fixture([
      pluginSource(
        'org/crash',
        `{ output() { return { ...${PRINTER}, taskStdout() { throw new Error('boom') } } } }`,
      ),
    ])
    const r = vx(root)
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('start 1\n')
    expect(r.stderr).toContain(
      "[vx] plugin 'org/crash' output failed: boom; vx renders the rest of the run",
    )
    expect(r.stdout).not.toContain('done pkg-a#hello')
    expect(r.stdout).toContain('hi')
  })

  it('a Logger method that rejects hands the rest of the run to core, as a throw does', async () => {
    // An `async` method's rejection reached no one: an unhandled
    // rejection, a stack, exit 1 after the task had passed.
    const root = await fixture([
      pluginSource(
        'org/crash',
        `{ output() { return { ...${PRINTER}, async taskStdout() { throw new Error('boom') } } } }`,
      ),
    ])
    const r = vx(root)
    expect(r.stderr).not.toContain('error: boom')
    expect(r.code).toBe(0)
    expect(r.stderr).toContain(
      "[vx] plugin 'org/crash' output failed: boom; vx renders the rest of the run",
    )
    expect(r.stdout).not.toContain('done pkg-a#hello')
    expect(r.stdout).toContain('pkg-a#hello')
  })

  it('an output hook that never answers is passed over in time, and core renders the run', async () => {
    // Unbounded, it held the run before its first task until the loop
    // drained: exit 1, the task never run (telemetry's item 921).
    const root = await fixture([
      pluginSource('org/hang', `{ output() { return new Promise(() => {}) } }`),
    ])
    const r = vxWith({ VX_TEST_TEARDOWN_TIMEOUT: '200ms' }, root)
    expect(r.stderr).not.toContain('the run stopped before it finished')
    expect(r.code).toBe(0)
    expect(r.stderr).toContain(
      "[vx] plugin 'org/hang' output: did not answer within 200 ms; vx renders the run",
    )
    expect(r.stdout).toContain('hi')
  })
})
