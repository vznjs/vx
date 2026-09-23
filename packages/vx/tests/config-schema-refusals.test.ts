// Refusals in `workspace/config-schema.ts` that the 628-method sweep (item
// 653) found unheld: each row names the arm it holds, and each went red with
// that arm deleted alone. Messages are compared whole (`toBe`) — a substring
// probe would be satisfied by a neighbouring refusal's text.
import { describe, expect, it } from 'bun:test'
import type { WorkspaceConfig } from '../src/config.js'
import { validateProjectConfig, validateWorkspace } from '../src/workspace/config-schema.js'
import { parseDependencySpec } from '../src/graph/dependency-spec.js'
import { testPlugin } from './helpers/plugin.js'

const WS = '/ws/vx.workspace.ts'
const CFG = '/ws/pkg/vx.config.ts'

function refusal(config: unknown): string | null {
  try {
    validateWorkspace(config as WorkspaceConfig, WS)
    return null
  } catch (err) {
    expect((err as Error).name).toBe('UserError')
    return (err as Error).message
  }
}

/** The message a one-task project config `{ tasks: { t: task } }` is refused with, or null. */
function taskRefusal(task: unknown): string | null {
  try {
    validateProjectConfig({ tasks: { t: task } } as never, CFG)
    return null
  } catch (err) {
    expect((err as Error).name).toBe('UserError')
    return (err as Error).message
  }
}

describe('workspace refusals the sweep found unheld (item 653)', () => {
  it('a fractional concurrency is refused — the integer arm, past the positivity one', () => {
    expect(refusal({ concurrency: 1.5 })).toBe(`${WS}: \`concurrency\` must be a positive integer`)
    // Control: an integer passes, so the row is not held by a coarser gate.
    expect(refusal({ concurrency: 2 })).toBeNull()
  })

  it('an EMPTY package stamp is refused like a missing one', () => {
    // `definePlugin` never stamps '' (a nameless package.json is refused
    // there), but the stamp is a registry symbol another copy of vx writes,
    // and this schema is the one boundary every plugin crosses.
    const forged = { name: '', [Symbol.for('vx.plugin.package')]: '', teardown() {} }
    expect(refusal({ plugins: [forged] })).toBe(
      `${WS}: \`plugins[0]\` must come from definePlugin(import.meta, { … }) — a plugin's name is its package name`,
    )
    // Control: the same object stamped with a real name validates.
    const stamped = { name: 'p', [Symbol.for('vx.plugin.package')]: 'p', teardown() {} }
    expect(refusal({ plugins: [stamped] })).toBeNull()
  })

  it('a non-object `commands` is refused, not read as a plugin that contributes a verb', () => {
    // `Object.entries(7)` is `[]`: without the shape check the plugin passes
    // the at-least-one-capability rule on a `commands` that declares nothing.
    const p = { ...testPlugin('sweep-653-cmd', { teardown() {} }), commands: 7 }
    expect(refusal({ plugins: [p] })).toBe(`${WS}: \`plugins[0].commands\` must be an object`)
  })

  it('a fingerprint claim over NO files is refused', () => {
    const claim = { files: [], affected: () => new Set<string>() }
    const p = testPlugin('sweep-653-fp', { fingerprint: claim as never })
    expect(refusal({ plugins: [p] })).toBe(
      `${WS}: \`plugins[0].fingerprint\` must be { files: [name, …], affected: function }`,
    )
    // Control: the same claim over a file core folds validates.
    const ok = testPlugin('sweep-653-fp-ok', {
      fingerprint: { files: ['bun.lock'], affected: () => new Set<string>() } as never,
    })
    expect(refusal({ plugins: [ok] })).toBeNull()
  })
})

describe('task refusals the sweep found unheld (item 653)', () => {
  it('a remote that is neither a boolean nor "only" is refused', () => {
    expect(taskRefusal({ exec: { command: 'x', remote: 'yes' } })).toBe(
      `${CFG}: tasks.t.exec.remote must be a boolean or 'only' (or omitted)`,
    )
    // Controls: each accepted spelling passes.
    for (const remote of [true, false, 'only']) {
      expect(taskRefusal({ exec: { command: 'x', remote } })).toBeNull()
    }
  })

  it('a non-object env is refused, not read as an env with no fields', () => {
    // `Object.keys(5)` is `[]`, so the unknown-key check below passes it.
    expect(taskRefusal({ exec: { command: 'x', env: 5 } })).toBe(
      `${CFG}: tasks.t.exec.env must be an object (or omitted)`,
    )
  })

  it('an ARRAY define is refused — its index would be the variable name', () => {
    expect(taskRefusal({ exec: { command: 'x', env: { define: ['X=1'] } } })).toBe(
      `${CFG}: tasks.t.exec.env.define must be an object of name:value string pairs`,
    )
    expect(taskRefusal({ exec: { command: 'x', env: { define: { X: '1' } } } })).toBeNull()
  })

  it('a null cache is refused by name, not by a TypeError from the field scan', () => {
    // A non-null non-object is refused further down (`cache.inputs is
    // required`); null alone reaches `Object.keys` and throws a raw TypeError.
    expect(taskRefusal({ exec: { command: 'x' }, cache: null })).toBe(
      `${CFG}: tasks.t.cache must be an object when present`,
    )
  })
})

/** A cached task over `inputs` / `outputs`, as its refusal message or null. */
function cacheRefusal(inputs: object, outputs: object = { files: [] }, dependsOn?: string[]) {
  return taskRefusal({ exec: { command: 'x' }, dependsOn, cache: { inputs, outputs } })
}

describe('glob and filter refusals the sweep found unheld (item 653)', () => {
  it('"!/" in inputs.files names the project directory — the "/" arm of namesDirItself', () => {
    // A bare "/" is refused as absolute first, and "./" normalizes to "";
    // "!/" is the one spelling that reaches the "/" arm.
    expect(cacheRefusal({ files: ['src/**', '!/'] })).toBe(
      `${CFG}: tasks.t.cache.inputs.files: "!/" names the project directory itself and selects nothing — use "**" for everything under it`,
    )
    expect(cacheRefusal({ files: ['src/**', '!dist/**'] })).toBeNull()
  })

  it('"." in workspaceFiles names the workspace root and is refused', () => {
    expect(cacheRefusal({ files: ['src/**'], workspaceFiles: ['.'] })).toBe(
      `${CFG}: tasks.t.cache.inputs.workspaceFiles: "." names the workspace root itself and selects nothing — use "**" for everything under it`,
    )
    expect(cacheRefusal({ files: ['src/**'], workspaceFiles: ['tsconfig.json'] })).toBeNull()
  })

  it('an inputs.tasks entry with an EMPTY task half is left to the syntax check', () => {
    // `'^'` names no task, but the schema leaves it to `parseDependencySpec`,
    // whose reason says what is wrong; "names no task in dependsOn" would
    // send the author looking for a typo in a name that is not there.
    expect(cacheRefusal({ files: ['src/**'], tasks: ['^'] }, { files: [] }, ['^build'])).toBeNull()
    expect(() => parseDependencySpec('^')).toThrow('"^" with no task name')
    // Control: a non-empty name dependsOn lacks is refused here.
    expect(
      cacheRefusal({ files: ['src/**'], tasks: ['^buidl'] }, { files: [] }, ['^build']),
    ).not.toBeNull()
  })
})

describe('sandbox refusals the sweep found unheld (item 653)', () => {
  const W = `${CFG}: tasks.t.exec`
  const sandboxRefusal = (sandbox: unknown) => taskRefusal({ exec: { command: 'x', sandbox } })
  // A non-null scalar where an object belongs reads as an object with no
  // fields to the unknown-key check (`Object.keys(true)` is `[]`), so each
  // shape check below is the only thing between it and a silent baseline.
  const CASES: Array<[string, unknown, string]> = [
    [
      'sandbox itself',
      true,
      `${W}.sandbox must be an object (e.g. \`{}\` for the baseline, or \`{ allow: { read: [...] } }\`)`,
    ],
    [
      'weakerWhenNested',
      { weakerWhenNested: 'yes' },
      `${W}.sandbox.weakerWhenNested must be a boolean`,
    ],
    [
      'weakerNetworkIsolation',
      { weakerNetworkIsolation: 1 },
      `${W}.sandbox.weakerNetworkIsolation must be a boolean`,
    ],
    ['allow', { allow: true }, `${W}.sandbox.allow must be an object`],
    [
      'allow.read',
      { allow: { read: 'src' } },
      `${W}.sandbox.allow.read must be an array of non-empty strings`,
    ],
    [
      'allow.write',
      { allow: { write: [''] } },
      `${W}.sandbox.allow.write must be an array of non-empty strings`,
    ],
    [
      'allow.systemInfo',
      { allow: { systemInfo: 'hw' } },
      `${W}.sandbox.allow.systemInfo must be an array of non-empty strings`,
    ],
    [
      'allow.machLookup',
      { allow: { machLookup: [1] } },
      `${W}.sandbox.allow.machLookup must be an array of non-empty strings`,
    ],
    ['allow.pty', { allow: { pty: 'yes' } }, `${W}.sandbox.allow.pty must be a boolean`],
    [
      'allow.gitConfig',
      { allow: { gitConfig: 1 } },
      `${W}.sandbox.allow.gitConfig must be a boolean`,
    ],
    [
      'allow.network',
      { allow: { network: 'example.com' } },
      `${W}.sandbox.allow.network must be an array of non-empty strings`,
    ],
    [
      'allow.unixSockets',
      { allow: { unixSockets: false } },
      `${W}.sandbox.allow.unixSockets must be an array of non-empty strings`,
    ],
    ['deny', { deny: true }, `${W}.sandbox.deny must be an object`],
    [
      'deny.network',
      { deny: { network: 'example.com' } },
      `${W}.sandbox.deny.network must be an array of non-empty strings`,
    ],
    ['ignore', { ignore: true }, `${W}.sandbox.ignore must be an object`],
    [
      'ignore.read',
      { ignore: { read: 'x' } },
      `${W}.sandbox.ignore.read must be an array of non-empty strings`,
    ],
    [
      'ignore.machLookup',
      { ignore: { machLookup: [''] } },
      `${W}.sandbox.ignore.machLookup must be an array of non-empty strings`,
    ],
    [
      'ignore.network',
      { ignore: { network: true } },
      `${W}.sandbox.ignore.network must be an array of non-empty strings`,
    ],
    [
      'ignore.pty',
      { ignore: { pty: true } },
      `${W}.sandbox.ignore.pty is a flag, not something to ignore`,
    ],
  ]
  for (const [field, sandbox, message] of CASES) {
    it(`refuses a malformed ${field}`, () => {
      expect(sandboxRefusal(sandbox)).toBe(message)
    })
  }

  it('accepts every field in a well-formed sandbox (the control past each check)', () => {
    expect(
      sandboxRefusal({
        weakerWhenNested: true,
        weakerNetworkIsolation: false,
        allow: {
          read: ['/opt/**'],
          write: ['out/**'],
          systemInfo: ['hw.ncpu'],
          machLookup: ['com.apple.x'],
          pty: true,
          gitConfig: false,
          network: true,
          unixSockets: ['/tmp/s.sock'],
          localBinding: [8080],
        },
        deny: { network: ['example.com'] },
        ignore: { read: ['/proc/**'], write: ['x'], network: ['y'], unixSockets: ['z'] },
      }),
    ).toBeNull()
  })
})
