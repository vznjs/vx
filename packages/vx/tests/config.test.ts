import { describe, expect, it } from 'bun:test'
import {
  defineProject,
  defineWorkspace,
  PLUGIN_FUNCTION_HOOKS,
  PLUGIN_HOOKS,
  PLUGIN_PACKAGE,
} from '../src/config.js'

describe('defineProject', () => {
  it('is an identity function (returns its input)', () => {
    const cfg = { tasks: { build: { exec: { command: 'tsc' } } } }
    expect(defineProject(cfg)).toBe(cfg)
  })

  it('preserves nested literal types via the generic', () => {
    const cfg = defineProject({
      tasks: {
        build: {
          exec: { command: 'tsc' },
          cache: { inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] } },
        },
      },
    })
    expect(cfg.tasks?.build?.cache?.outputs.files).toEqual(['dist/**'])
    // The claim is about the TYPE, and the line above is a runtime one that
    // holds whether or not the generic narrows. `const T` is what keeps the
    // command a literal rather than widening it to `string`; this line is
    // the assertion, and it is checked by the gate's type-check, not here.
    const command: 'tsc' | undefined = cfg.tasks?.build?.exec?.command
    expect(command).toBe('tsc')
  })

  it('type-checks dependsOn bare entries against task keys', () => {
    // The valid forms: bare task key, `^name` (dep workspaces, incl.
    // `^all`), and `pkg#name` (cross-project). These must type-check.
    const cfg = defineProject({
      tasks: {
        build: { exec: { command: 'tsc' } },
        ci: { dependsOn: ['build', '^all', '^build', 'pkg#build'] },
      },
    })
    expect(cfg.tasks?.ci?.dependsOn).toContain('^all')
  })

  it('rejects a dependsOn entry that is not a task key', () => {
    defineProject({
      tasks: {
        build: { exec: { command: 'tsc' } },
        // @ts-expect-error 'biuld' is not a declared task key (typo of 'build').
        ci: { dependsOn: ['biuld'] },
      },
    })
  })

  it('requires cache.inputs.files — the one declaration vx will not infer', () => {
    // Architecture principle #2: caching is opt-in and `cache.inputs.files`
    // is REQUIRED; there is no inferred-input path. The requirement lives
    // only in this type, and nothing asserted it, so it could become
    // optional with the whole suite green — and a task declaring `cache`
    // with no `files` would then key on nothing it reads.
    defineProject({
      tasks: {
        // @ts-expect-error `files` is required on cache.inputs.
        build: { exec: { command: 'tsc' }, cache: { inputs: {}, outputs: { files: [] } } },
      },
    })
    // CONTROL: the same task with an explicit (even empty) files list is fine.
    defineProject({
      tasks: {
        build: {
          exec: { command: 'tsc' },
          cache: { inputs: { files: [] }, outputs: { files: [] } },
        },
      },
    })
  })
})

describe('defineWorkspace', () => {
  it('is an identity function (returns its input)', () => {
    const cfg = { concurrency: 4 }
    expect(defineWorkspace(cfg)).toBe(cfg)
  })

  it('is constrained to the workspace schema and does not widen its return', () => {
    const ws = defineWorkspace({ concurrency: 4 })
    // Widening the return to `WorkspaceConfig` makes every field optional
    // again, so this stops compiling — the generic is what carries the
    // caller's own shape back out.
    const concurrency: number = ws.concurrency
    expect(concurrency).toBe(4)

    // @ts-expect-error `notAWorkspaceKey` is not part of WorkspaceConfig.
    defineWorkspace({ notAWorkspaceKey: 1 })
  })

  it('requires a plugin to carry a name', () => {
    defineWorkspace({
      // @ts-expect-error a plugin without a `name` is not a Plugin.
      plugins: [{ teardown() {} }],
    })
  })
})

describe('the plugin vocabulary config.ts owns', () => {
  it('PLUGIN_PACKAGE is the REGISTRY symbol under its exact key', () => {
    // A plugin package imports its own copy of @vzn/vx beside a compiled
    // binary's, and the two copies must stamp and check the same key. Both
    // halves matter and neither had a witness: a plain `Symbol()` is unique
    // per copy, and a different key string silently stops recognising every
    // plugin built against the old one. `Symbol.for` in a test is the same
    // global registry lookup the other copy would do.
    // Widened to `symbol`: the constant's type is `unique symbol`, which
    // has no overlap with the registry lookup's `symbol` as far as the
    // type-checker is concerned — the claim here is the runtime identity.
    const stamped: symbol = PLUGIN_PACKAGE
    expect(stamped).toBe(Symbol.for('vx.plugin.package'))
  })

  it('PLUGIN_HOOKS is this list, in pipeline order', () => {
    // "Every hook a plugin may fill, IN PIPELINE ORDER — THE list." The
    // doc-drift suites ask only that each name appears SOMEWHERE, so the
    // order — which `vx info`'s seam column and the stage tables render —
    // was free. Written out rather than derived, so it cannot agree with
    // whatever the constant happens to say.
    expect([...PLUGIN_HOOKS]).toEqual([
      'config',
      'project',
      'graph',
      'key',
      'fingerprint',
      'schedule',
      'admit',
      'executor',
      'cache',
      'telemetry',
      'setup',
      'commands',
      'teardown',
    ])
  })

  it('PLUGIN_FUNCTION_HOOKS is every hook except the two that are objects', () => {
    // The loader demands a function of each of these, so membership decides
    // what it refuses: `commands` is a record and `fingerprint` a claim
    // object, and admitting either would reject a legal plugin.
    expect([...PLUGIN_FUNCTION_HOOKS]).toEqual([
      'config',
      'project',
      'graph',
      'key',
      'schedule',
      'admit',
      'executor',
      'cache',
      'telemetry',
      'setup',
      'teardown',
    ])
    // And both directions against the list it is filtered from, so a hook
    // added to PLUGIN_HOOKS cannot quietly go missing here.
    const all: readonly string[] = PLUGIN_HOOKS
    const fns: readonly string[] = PLUGIN_FUNCTION_HOOKS
    expect(all.filter((h) => !fns.includes(h))).toEqual(['fingerprint', 'commands'])
    expect(fns.filter((h) => !all.includes(h))).toEqual([])
  })
})
