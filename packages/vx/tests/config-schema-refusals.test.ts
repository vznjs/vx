// Refusals in `workspace/config-schema.ts` that the 628-method sweep (item
// 653) found unheld: each row names the arm it holds, and each went red with
// that arm deleted alone. Messages are compared whole (`toBe`) — a substring
// probe would be satisfied by a neighbouring refusal's text.
import { describe, expect, it } from 'bun:test'
import type { WorkspaceConfig } from '../src/config.js'
import { validateProjectConfig, validateWorkspace } from '../src/workspace/config-schema.js'
import { parseDependencySpec } from '../src/graph/dependency-spec.js'
import { testPlugin } from './helpers/plugin.js'

const WS = '/ws/.vx/workspace.ts'
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

// A branch is the checkout's, never the config's (2026-10-14): a
// committed one would mislabel every other branch's runs.
describe('run.branch in the workspace config', () => {
  it('is refused as an unknown key', () => {
    expect(refusal({ run: { branch: 'main' } })).toBe(
      `${WS}: \`run\` has unknown field "branch" (allowed: concurrency, continue, retries, rules, schedule, timeout)`,
    )
  })
})

// JSON writes a non-finite number as null: `concurrency: 1e400` was
// refused as "(got null)", a value the file never held.
describe('a non-finite number in the workspace config', () => {
  it('is quoted as written', () => {
    const rule = "must be a positive integer, or a share of the cores like '50%'"
    expect([Infinity, -Infinity, NaN].map((n) => refusal({ run: { concurrency: n } }))).toEqual([
      `${WS}: \`run.concurrency\` ${rule} (got Infinity)`,
      `${WS}: \`run.concurrency\` ${rule} (got -Infinity)`,
      `${WS}: \`run.concurrency\` ${rule} (got NaN)`,
    ])
  })
})

// Item 1099: a command of whitespace alone passed as non-empty and ran as
// a no-op success, cached.
describe('an empty command in any spelling', () => {
  it('is refused', () => {
    for (const command of ['', '   ', '\n', '\t \n']) {
      expect(taskRefusal({ exec: { command } })).toBe(
        `${CFG}: tasks.t.exec.command must be a non-empty string`,
      )
    }
    // CONTROL: a command with text around whitespace stands.
    expect(taskRefusal({ exec: { command: ' true ' } })).toBeNull()
  })
})

// X-22: whitespace alone made a directory of spaces, or a no-op probe.
describe('whitespace-only values', () => {
  it('a cache.dir or runtime probe of spaces is refused', () => {
    expect([refusal({ cache: { dir: '   ' } }), refusal({ cache: { dir: '.vx/c' } })]).toEqual([
      `${WS}: \`cache.dir\` must be a non-blank string (got "   ")`,
      null,
    ])
    const probe = (runtime: string[]) =>
      taskRefusal({
        exec: { command: 'x' },
        inputs: { files: ['src/**'], runtime },
        cache: { outputs: { files: [] } },
      })
    expect([probe(['   ']), probe(['\t\n']), probe(['node -v'])]).toEqual([
      `${CFG}: tasks.t.inputs.runtime must be an array of non-empty shell command strings with no NUL`,
      `${CFG}: tasks.t.inputs.runtime must be an array of non-empty shell command strings with no NUL`,
      null,
    ])
  })
})

// A NUL in a workspace path or ref loaded, then failed the run with
// Node's argument error: the cache dir's message blamed the workspace's
// permissions, and a base ref's named `args[3]` and nothing in the config.
describe('a NUL in a workspace string', () => {
  it('is refused in cache.dir and baseBranch', () => {
    expect([
      refusal({ cache: { dir: 'a\0b' } }),
      refusal({ baseBranch: 'main\0x' }),
      refusal({ baseBranch: 'release/2' }),
    ]).toEqual([
      `${WS}: \`cache.dir\` holds a NUL, which no path can carry`,
      `${WS}: \`baseBranch\` must be a branch name like 'main'`,
      null,
    ])
  })
})

describe('workspace refusals the sweep found unheld (item 653)', () => {
  it('a fractional concurrency is refused — the integer arm, past the positivity one', () => {
    expect(refusal({ run: { concurrency: 1.5 } })).toBe(
      `${WS}: \`run.concurrency\` must be a positive integer, or a share of the cores like '50%' (got 1.5)`,
    )
    // Control: an integer passes, so the row is not held by a coarser gate.
    expect(refusal({ run: { concurrency: 2 } })).toBeNull()
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

  // X-19: a misspelled hook was never called and never said.
  it('a key that names no hook is refused, the nearest hinted', () => {
    const p = (hooks: object) => ({ ...testPlugin('x19', { setup() {} }), ...hooks })
    expect([
      refusal({ plugins: [p({ excutor: () => null })] }),
      refusal({ plugins: [p({ zzzzzzzz: 1 })] }),
      refusal({ plugins: [p({ teardown() {} })] }),
    ]).toEqual([
      `${WS}: plugin 'x19' declares 'excutor', which is no plugin hook — did you mean 'executor'?`,
      `${WS}: plugin 'x19' declares 'zzzzzzzz', which is no plugin hook (hooks: config, discover, project, graph, key, fingerprint, schedule, admit, executor, cache, telemetry, output, setup, commands, teardown)`,
      null,
    ])
  })

  // X-21: a flag-like or empty verb loaded and could never run. A verb
  // with a space or shell syntax broke or injected into `vx completions`.
  it('a verb no command line reaches is refused', () => {
    const p = (verb: string) => ({
      ...testPlugin('x21', { teardown() {} }),
      commands: { [verb]: { description: 'd', run: () => 0 } },
    })
    const why = (verb: string) =>
      `${WS}: plugin 'x21' declares command '${verb}', which is not a word — a verb is a letter or digit, then letters, digits, ':', '.', '_' or '-'`
    expect([
      refusal({ plugins: [p('--version')] }),
      refusal({ plugins: [p('')] }),
      refusal({ plugins: [p(' ')] }),
      refusal({ plugins: [p('a b')] }),
      refusal({ plugins: [p('$(touch x)')] }),
      refusal({ plugins: [p('x;y')] }),
      refusal({ plugins: [p('deploy')] }),
      refusal({ plugins: [p('db:migrate.v2_x-1')] }),
    ]).toEqual([
      why('--version'),
      why(''),
      why(' '),
      why('a b'),
      why('$(touch x)'),
      why('x;y'),
      null,
      null,
    ])
  })

  it('a non-object `commands` is refused, not read as a plugin that contributes a verb', () => {
    // `Object.entries(7)` is `[]`: without the shape check the plugin passes
    // the at-least-one-capability rule on a `commands` that declares nothing.
    const p = { ...testPlugin('sweep-653-cmd', { teardown() {} }), commands: 7 }
    expect(refusal({ plugins: [p] })).toBe(
      `${WS}: \`plugins[0].commands\` of plugin '${p.name}' must be an object`,
    )
  })

  it('a `commands` array is refused, not read as the verbs 0, 1, …', () => {
    const p = testPlugin('sweep-cmd-list', {
      commands: [{ description: 'd', run: () => 0 }] as never,
    })
    expect(refusal({ plugins: [p] })).toBe(
      `${WS}: \`plugins[0].commands\` must be an object keyed by verb, not an array`,
    )
  })

  it('a fingerprint claim over NO files is refused', () => {
    const claim = { files: [], affected: () => new Set<string>() }
    const p = testPlugin('sweep-653-fp', { fingerprint: claim as never })
    expect(refusal({ plugins: [p] })).toBe(
      `${WS}: \`plugins[0].fingerprint\` of plugin '${p.name}' must be { files: [name, …], affected: function, extraFiles?: function }`,
    )
    // Control: the same claim over a file core folds validates.
    const ok = testPlugin('sweep-653-fp-ok', {
      fingerprint: { files: ['bun.lock'], affected: () => new Set<string>() } as never,
    })
    expect(refusal({ plugins: [ok] })).toBeNull()
  })
})

describe('setting refusals the sweep found unheld (item 653)', () => {
  it('a NUMBER size is refused by name, not by a TypeError from parseSize', () => {
    // `parseSize` takes a string; the type arm is what keeps a number from it.
    expect(refusal({ cache: { store: { embeddings: 1048576 } } })).toBe(
      `${WS}: \`cache.store.embeddings\` must be false, or a size like '32KiB' (got 1048576)`,
    )
    expect(refusal({ cache: { store: { embeddings: '1048576B' } } })).toBeNull()
  })

  it('a bigint or symbol value is refused by name, not by a TypeError from quoting it', () => {
    // The workspace file has no JSON rule before its schema; the fuzz found it.
    expect(refusal({ run: { timeout: 30n } })).toBe(
      `${WS}: \`run.timeout\` must be a duration like '500ms', '30s' or '5m', at most 24 days (got 30n)`,
    )
    expect(refusal({ cache: { store: { embeddings: Symbol('s') } } })).toBe(
      `${WS}: \`cache.store.embeddings\` must be false, or a size like '32KiB' (got Symbol(s))`,
    )
    const p = testPlugin('fz-fp-bigint', {
      fingerprint: { files: [1n], affected: () => new Set<string>() } as never,
    })
    expect(refusal({ plugins: [p] })).toBe(
      `${WS}: plugin 'fz-fp-bigint' claims fingerprint file 1n, which is not a file name at the workspace root`,
    )
  })
})

describe('task refusals the sweep found unheld (item 653)', () => {
  it('a persistent task with a cache is refused', () => {
    expect(
      taskRefusal({
        exec: { command: 'x', persistent: {} },
        inputs: { files: [] },
        cache: { outputs: { files: [] } },
      }),
    ).toBe(
      `${CFG}: tasks.t: \`cache\` is not allowed on a persistent task — persistent tasks don't terminate, so there's no exit to cache`,
    )
  })

  it('a remote that is neither a boolean nor "only" is refused', () => {
    expect(taskRefusal({ exec: { command: 'x', remote: 'yes' } })).toBe(
      `${CFG}: tasks.t.exec.remote must be a boolean or 'only' (or omitted)`,
    )
    // Controls: each accepted spelling passes ('only' with the cache it needs).
    for (const remote of [true, false]) {
      expect(taskRefusal({ exec: { command: 'x', remote } })).toBeNull()
    }
    const cache = { outputs: { files: [] } }
    expect(
      taskRefusal({ exec: { command: 'x', remote: 'only' }, inputs: { files: [] }, cache }),
    ).toBeNull()
  })

  // schema.md said an 'only' task must declare `cache`, and nothing held
  // it: the task loaded, and the REAPI executor refused it at run time
  // for want of described inputs (item 1001).
  it("an uncached remote 'only' task is refused", () => {
    expect(taskRefusal({ exec: { command: 'x', remote: 'only' } })).toBe(
      `${CFG}: tasks.t.exec.remote 'only' needs \`cache\`: its inputs are what a worker ` +
        `reproduces and its key is the address of its remote record`,
    )
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

  // An env name holds no `=` (the child split `A=B` into `A` = `B=x`), is
  // not empty (dropped) and holds no NUL (the spawn failed with a hint
  // about exit 127); a define value holds no NUL either (item 999).
  it('an env name that no environment can hold is refused in every list', () => {
    const define = (d: object) => taskRefusal({ exec: { command: 'x', env: { define: d } } })
    for (const k of ['A=B', '', 'A\0B']) {
      expect(define({ [k]: 'x' })).toBe(
        `${CFG}: tasks.t.exec.env.define: ${JSON.stringify(k)} is not an env var name (non-empty, no '=' or NUL)`,
      )
    }
    expect(define({ A: 'x\0y' })).toBe(
      `${CFG}: tasks.t.exec.env.define.A must be a string with no NUL`,
    )
    for (const n of ['A=B', 'A\0B']) {
      expect(taskRefusal({ exec: { command: 'x', env: { passThrough: [n] } } })).toBe(
        `${CFG}: tasks.t.exec.env.passThrough must be an array of env var names (non-empty, no '=' or NUL)`,
      )
      expect(cacheRefusal({ files: [], env: [n] })).toBe(
        `${CFG}: tasks.t.inputs.env must be an array of env var names (non-empty, no '=' or NUL)`,
      )
    }
    // Item 1090: a wildcard passed nothing through and loaded clean.
    for (const n of ['VITE_*', 'A?', 'A{B,C}', 'A[B]']) {
      expect(taskRefusal({ exec: { command: 'x', env: { passThrough: [n] } } })).toBe(
        `${CFG}: tasks.t.exec.env.passThrough: wildcards in env names are not supported (got ${JSON.stringify(n)}) — list explicit env var names instead`,
      )
    }
    // L-14: `env.secret` names the variables masked whatever their name.
    for (const n of ['A=B', 'A\0B', '', 'GH_*']) {
      expect(taskRefusal({ exec: { command: 'x', env: { secret: [n] } } })).toBe(
        `${CFG}: tasks.t.exec.env.secret must be an array of env var names (non-empty, no '=', NUL or wildcard)`,
      )
    }
    expect(taskRefusal({ exec: { command: 'x', env: { secret: 'GH_PAT' } } })).toBe(
      `${CFG}: tasks.t.exec.env.secret must be an array of env var names (non-empty, no '=', NUL or wildcard)`,
    )
    expect(taskRefusal({ exec: { command: 'x', env: { secret: ['GH_PAT'] } } })).toBeNull()
    // `sh` (dash on Linux) drops a name that is no shell identifier from the
    // environment it hands the command: `my.var` loaded clean and never
    // reached the task there, and did under macOS's bash.
    for (const n of ['my.var', 'A-B', '1A', 'A B', 'ü']) {
      expect(define({ [n]: 'x' })).toBe(
        `${CFG}: tasks.t.exec.env.define: ${JSON.stringify(n)} is not a shell variable name ([A-Za-z_][A-Za-z0-9_]*); sh would drop it before the task runs`,
      )
      expect(taskRefusal({ exec: { command: 'x', env: { passThrough: [n] } } })).toBe(
        `${CFG}: tasks.t.exec.env.passThrough: ${JSON.stringify(n)} is not a shell variable name ([A-Za-z_][A-Za-z0-9_]*); sh would drop it before the task runs`,
      )
    }
    expect(define({ _a1: 'x' })).toBeNull()
    // Controls: a name with no `=` or NUL, and a value holding `=`, pass.
    expect(define({ A_B: 'x=y' })).toBeNull()
    expect(taskRefusal({ exec: { command: 'x', env: { passThrough: ['A_B'] } } })).toBeNull()
    expect(cacheRefusal({ files: [], env: ['A_B'] })).toBeNull()
  })

  // No argv carries a NUL: the spawn refused one and the task failed as
  // exit 127, "not on this task's PATH", the NUL printed as a space (D-4).
  it('a command holding a NUL is refused where the config names it', () => {
    expect(taskRefusal({ exec: { command: 'echo a\0b' } })).toBe(
      `${CFG}: tasks.t.exec.command holds a NUL, which no command line can carry`,
    )
    for (const field of ['runtime', 'workspaceRuntime']) {
      expect(cacheRefusal({ files: [], [field]: ['node -v\0'] })).toBe(
        `${CFG}: tasks.t.inputs.${field} must be an array of non-empty shell command strings with no NUL`,
      )
      expect(cacheRefusal({ files: [], [field]: ['node -v'] })).toBeNull()
    }
    // Control: a command with an escaped `\0` in its text, which the shell reads.
    expect(taskRefusal({ exec: { command: "printf 'a\\0b'" } })).toBeNull()
  })

  // Each shape loaded and could not be referenced: `x#y` read as project
  // `x`, `^gen` as the dependencies' `gen`, `''` ran as `a#` and `vx run a#`
  // refused it (item 1000).
  it('a task name dependsOn and the CLI cannot name is refused', () => {
    const named = (name: string): string | null => {
      try {
        validateProjectConfig({ tasks: { [name]: { exec: { command: 'x' } } } } as never, CFG)
        return null
      } catch (err) {
        return (err as Error).message
      }
    }
    const tail = ' — dependsOn, inputs.tasks and the CLI could not name it. Rename the task.'
    for (const [name, why] of [
      ['', 'is empty'],
      ['  ', 'is empty'],
      [' sp ', 'has surrounding whitespace'],
      ['x#y', "holds '#', which separates a project from its task"],
      ['b.*', "holds '*', which makes it a pattern"],
      ['^gen', "starts with '^', which names dependencies' tasks or negates"],
      ['!gen', "starts with '!', which names dependencies' tasks or negates"],
      // Printed raw by the status line, `ESC ]0;` retitled the terminal.
      ['b\x1b]0;x\x07', 'holds a control character'],
      ['b\rc', 'holds a control character'],
    ] as const) {
      expect(named(name)).toBe(`${CFG}: task name ${JSON.stringify(name)} ${why}${tail}`)
    }
    // Controls: the separators vx does not read inside a name pass.
    for (const name of ['build:prod', 'e2e-ci--src/app.cy.ts', 'gen^2', 'a!b', 'lint.fix']) {
      expect(named(name)).toBeNull()
    }
  })

  it('a project name holding a control character is refused', () => {
    const named = (name: string): string | null => {
      try {
        validateProjectConfig({ name, tasks: {} } as never, CFG)
        return null
      } catch (err) {
        return (err as Error).message
      }
    }
    expect(named('a\x1b]0;x\x07')).toBe(
      `${CFG}: \`name\` "a\\u001b]0;x\\u0007" holds a control character — rename the project`,
    )
    expect(named('@acme/ui')).toBeNull()
  })

  // `run.retries` refused what no attempt count can be; a task's own took
  // 1e20 and retried a failing task without end.
  it("a task's retries are held to run.retries' rule", () => {
    expect(taskRefusal({ exec: { command: 'x', retries: 1e20 } })).toBe(
      `${CFG}: tasks.t.exec.retries must be a non-negative integer (got 100000000000000000000)`,
    )
    expect(taskRefusal({ exec: { command: 'x', retries: 3 } })).toBeNull()
  })

  // `vx show` printed a tag raw: `ESC ]0;` retitled the terminal.
  it('a tag holding a control character is refused', () => {
    const tagged = (tag: string): string | null => {
      try {
        validateProjectConfig({ tags: [tag] } as never, CFG)
        return null
      } catch (err) {
        return (err as Error).message
      }
    }
    expect(tagged('t\x1b]0;x\x07')).toBe(
      `${CFG}: tag "t\\u001b]0;x\\u0007" holds a control character — rename the tag`,
    )
    expect(tagged('team-ui')).toBeNull()
  })

  // A project output under `workspace-outputs/` read back as a workspace
  // output: every hit was a corrupt artifact, dropped and run again.
  it('an output glob under the reserved workspace-outputs/ is refused (X-30)', () => {
    const out = (g: string) =>
      taskRefusal({
        exec: { command: 'x' },
        inputs: { files: [] },
        cache: { outputs: { files: ['dist/**', g] } },
      })
    for (const g of ['workspace-outputs/**', './workspace-outputs/o', 'workspace-outputs']) {
      expect(out(g)).toBe(
        `${CFG}: tasks.t.cache.outputs.files: "${g}" is under workspace-outputs/, a name vx's ` +
          `artifacts reserve for outputs.workspaceFiles — write the task's files to another directory`,
      )
    }
    // Controls: a neighbour's name, a nested one, and a take-back.
    for (const g of ['workspace-outputs2/**', 'out/workspace-outputs/**', '!workspace-outputs/x']) {
      expect(out(g)).toBeNull()
    }
  })

  // `outputs: ['**']` loaded, and the clean before the run deleted the
  // project's source, package.json and vx.config while the run reported
  // success; the message for '.' had suggested `**` (item 1002).
  it("an output glob that takes the project's config is refused; package.json is no core file", () => {
    const out = (g: string) =>
      taskRefusal({
        exec: { command: 'x' },
        inputs: { files: [] },
        cache: { outputs: { files: [g] } },
      })
    const why = (g: string, own: string) =>
      `${CFG}: tasks.t.cache.outputs.files: "${g}" covers the project's own ${own} — vx deletes a ` +
      `task's outputs before it runs and restores them on a hit, so the project would lose ` +
      `its config. Name the directory the task writes, such as "dist/**", ` +
      `or take the file back with "!${own}".`
    expect(out('**')).toBe(why('**', 'vx.config.ts'))
    expect(out('vx.config.*')).toBe(why('vx.config.*', 'vx.config.ts'))
    expect(out('*.ts')).toBe(why('*.ts', 'vx.config.ts'))
    expect(out('.')).toBe(
      `${CFG}: tasks.t.cache.outputs.files: "." names the project directory itself and selects nothing — ` +
        `name the directory the task writes, such as "dist/**"`,
    )
    // Controls: a directory's tree, a file beside the config, and the
    // manifest, which core keys and protects no more than any other file.
    // `*.js` is another config's spelling: this project's is vx.config.ts.
    for (const g of [
      'dist/**',
      '**/*.d.ts',
      'out.json',
      'src/**/*.js',
      '**/*.js',
      '*.json',
      'package.json',
    ]) {
      expect(out(g)).toBeNull()
    }
    // Taken back by a `!`, the file is never cleaned or restored: it loads.
    const outs = (files: string[]) =>
      taskRefusal({
        exec: { command: 'x' },
        inputs: { files: [] },
        cache: { outputs: { files } },
      })
    expect(outs(['**', '!vx.config.ts'])).toBeNull()
    expect(outs(['*.ts', '!vx.config.*'])).toBeNull()
    // CONTROL: a take-back of another file leaves the config refused.
    expect(outs(['**', '!package.json'])).toBe(why('**', 'vx.config.ts'))
  })

  it('a null cache is refused by name, not by a TypeError from the field scan', () => {
    // A non-null non-object is refused further down (`inputs is
    // required`); null alone reaches `Object.keys` and throws a raw TypeError.
    expect(taskRefusal({ exec: { command: 'x' }, cache: null })).toBe(
      `${CFG}: tasks.t.cache must be an object when present — \`inputs: { files: [...] }, cache: { outputs: { files: [...] } }\`, or no \`cache\` for a task that never caches`,
    )
  })

  it('a field another runner spells elsewhere is refused naming where vx keeps it (D-37)', () => {
    // Turbo's task-level `outputs` / `env`, Nx's `command`: an
    // unknown-field refusal that named neither the field nor its home.
    const where = (task: Record<string, unknown>): string | undefined =>
      taskRefusal({ exec: { command: 'x' }, ...task })?.split(' — ')[1]
    expect(where({ outputs: ['dist/**'] })).toBe('vx spells it `cache.outputs.files`')
    expect(taskRefusal({ exec: { command: 'x' }, inputs: ['src/**'] })).toContain(
      'did you mean `{ files: [...] }`?',
    )
    expect(where({ env: ['API_URL'] })).toBe(
      'vx spells it `inputs.env` (to key the task on a variable) or `exec.env` (to pass one)',
    )
    expect(where({ passThroughEnv: ['CI'] })).toBe('vx spells it `exec.env.passThrough`')
    expect(where({ persistent: true })).toBe('vx spells it `exec.persistent: {}`')
    expect(taskRefusal({ command: 'x' })?.split(' — ')[1]).toBe('vx spells it `exec.command`')
    expect(taskRefusal({ exec: { cmd: 'x' } })?.split(' — ')[1]).toBe('vx spells it `command`')
    // `cache: false` (Turbo's "never cache") and `persistent: true` name the fix.
    expect(taskRefusal({ exec: { command: 'x' }, cache: false })).toContain(
      'or no `cache` for a task that never caches',
    )
    expect(taskRefusal({ exec: { command: 'x', persistent: true } })).toContain('`persistent: {}`')
    // CONTROL: a typo still gets the nearest spelling.
    expect(where({ dependOn: [] })).toBe('did you mean dependsOn?')
  })

  // `retries` or `timeout` beside `exec` was refused with the task's own
  // fields alone, none of which is it.
  it('a field of exec, inputs or cache written on the task names its level', () => {
    const where = (task: Record<string, unknown>): string | undefined =>
      taskRefusal({ exec: { command: 'x' }, ...task })?.split(' — ')[1]
    expect(where({ retries: 2 })).toBe('vx spells it `exec.retries`')
    expect(where({ timeout: '5m' })).toBe('vx spells it `exec.timeout`')
    expect(where({ sandbox: {} })).toBe('vx spells it `exec.sandbox`')
    expect(where({ files: ['src/**'] })).toBe('vx spells it `inputs.files`')
    expect(where({ inputStability: {} })).toBe('vx spells it `cache.inputStability`')
    // Another runner's spelling keeps its own word.
    expect(where({ env: ['A'] })).toStartWith('vx spells it `inputs.env` (to key')
  })

  it("names where vx keeps an Nx target's keys and Turbo's outputLogs (D-49)", () => {
    const where = (task: Record<string, unknown>): string | undefined =>
      taskRefusal({ exec: { command: 'x' }, ...task })?.split(' — ')[1]
    expect(where({ continuous: true })).toBe('vx spells it `exec.persistent: {}`')
    expect(where({ executor: 'nx:run-commands' })).toBe(
      'vx spells it `exec.command`: vx runs one shell command (`nx()` from `@vzn/vx-migrate` runs an Nx executor as one)',
    )
    expect(where({ options: { command: 'x' } })).toBe(
      'vx spells it `exec.command` (a run-commands `options.command`) and `exec.env`',
    )
    expect(where({ outputLogs: 'new-only' })).toBe(
      'vx spells it the `--output-logs` flag of `vx run`',
    )
    // D-89: Turbo's `interactive` / `with`, Nx's `cwd`, `parallelism`,
    // `configurations`.
    expect(where({ interactive: true })).toBe('vx spells it `exec.interactive: true`')
    expect(where({ with: ['api#dev'] })).toBe(
      'vx spells it `dependsOn` on each task it runs beside: a persistent one stays up, and this task starts once it is ready',
    )
    expect(where({ cwd: 'src' })).toBe(
      'vx spells it `cd <dir> && …` in `exec.command`: a task runs in its project directory',
    )
    expect(where({ parallelism: false })).toBe(
      'vx spells it `run.concurrency: 1` in .vx/workspace or `--concurrency 1` on the run: no task runs alone beside others',
    )
    expect(where({ configurations: {} })).toBe(
      'vx spells it one task per configuration (`build:production`, with its own `exec.command`)',
    )
  })
})

/** A cached task over `inputs` / `outputs`, as its refusal message or null. */
function cacheRefusal(inputs: object, outputs: object = { files: [] }, dependsOn?: string[]) {
  return taskRefusal({ exec: { command: 'x' }, dependsOn, inputs, cache: { outputs } })
}

// A `!` entry subtracts wherever it sits: a literal named after it never
// entered the key, and an edit to it replayed the old output.
describe('a literal input a negation takes back (X-31)', () => {
  const refused = (g: string, by: string, where = 'tasks.t.inputs.files') =>
    `${CFG}: ${where}: "${g}" is taken back by "!${by}" — a \`!\` entry subtracts wherever it sits in ` +
    `the list, so the file never enters the key. Narrow the negation so it leaves "${g}".`
  it('is refused in files and workspaceFiles', () => {
    expect(cacheRefusal({ files: ['src/**', '!src/gen/**', 'src/gen/keep.ts'] })).toBe(
      refused('src/gen/keep.ts', 'src/gen/**'),
    )
    expect(cacheRefusal({ files: ['src/**', '!src/gen', './src/gen/keep.ts'] })).toBe(
      refused('./src/gen/keep.ts', 'src/gen'),
    )
    expect(cacheRefusal({ files: ['package.json', '!*.json'] })).toBe(
      refused('package.json', '*.json'),
    )
    expect(cacheRefusal({ files: [], workspaceFiles: ['tsconfig.json', '!tsconfig.json'] })).toBe(
      refused('tsconfig.json', 'tsconfig.json', 'tasks.t.inputs.workspaceFiles'),
    )
  })
  it('is refused in outputs too: the file was never saved, and a hit said up-to-date', () => {
    const lost = (g: string, by: string, where: string) =>
      `${CFG}: ${where}: "${g}" is taken back by "!${by}" — a \`!\` entry subtracts wherever it ` +
      `sits in the list, so the file is never saved or restored. Narrow the negation so it leaves "${g}".`
    expect(cacheRefusal({ files: [] }, { files: ['out/f', '!out/**'] })).toBe(
      lost('out/f', 'out/**', 'tasks.t.cache.outputs.files'),
    )
    expect(cacheRefusal({ files: [] }, { files: [], workspaceFiles: ['gen/a', '!gen/*'] })).toBe(
      lost('gen/a', 'gen/*', 'tasks.t.cache.outputs.workspaceFiles'),
    )
    expect(cacheRefusal({ files: [] }, { files: ['dist/', '!dist/cache/**'] })).toBeNull()
  })
  it('CONTROL: a directory literal a negation trims, and a glob, load', () => {
    expect(cacheRefusal({ files: ['src', '!src/gen/**'] })).toBeNull()
    expect(cacheRefusal({ files: ['src/**/*.ts', '!src/gen/**'] })).toBeNull()
    expect(cacheRefusal({ files: ['src/gen/keep.ts', '!src/gen/other.ts'] })).toBeNull()
  })
})

describe('glob and filter refusals the sweep found unheld (item 653)', () => {
  it('"!/" in inputs.files names the project directory — the "/" arm of namesDirItself', () => {
    // A bare "/" is refused as absolute first, and "./" normalizes to "";
    // "!/" is the one spelling that reaches the "/" arm.
    expect(cacheRefusal({ files: ['src/**', '!/'] })).toBe(
      `${CFG}: tasks.t.inputs.files: "!/" names the project directory itself and selects nothing — use "**" for everything under it`,
    )
    expect(cacheRefusal({ files: ['src/**', '!dist/**'] })).toBeNull()
  })

  it('a negated absolute path in inputs.files is refused like workspaceFiles refuses it (item 679)', () => {
    // It subtracts nothing from project-relative globs: a silent no-op.
    expect(cacheRefusal({ files: ['src/**', '!/etc/passwd'] })).toBe(
      `${CFG}: tasks.t.inputs.files: absolute paths are not allowed (got "!/etc/passwd") — inputs must be project-relative globs`,
    )
    expect(cacheRefusal({ files: ['src/**', '!src/**/*.spec.ts'] })).toBeNull()
  })

  it('"." in workspaceFiles names the workspace root and is refused', () => {
    expect(cacheRefusal({ files: ['src/**'], workspaceFiles: ['.'] })).toBe(
      `${CFG}: tasks.t.inputs.workspaceFiles: "." names the workspace root itself and selects nothing — use "**" for everything under it`,
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

  // The selection picks among the task's own dependencies and a group's
  // members are not among them (schema.md: name the group, whose hash
  // rolls its members up), so a name reached only through a group would
  // fold nothing; it is refused like a typo.
  it('an inputs.tasks name reached only through a group is refused, in each form', () => {
    const refused = (name: string, dep: string) =>
      `${CFG}: tasks.t.inputs.tasks: "${name}" names no task in tasks.t.dependsOn ('${dep}') — ` +
      `it would match nothing and fold no upstream hash, decoupling the task from its ` +
      `dependencies. \`name\` is this project's task, \`^name\` its dependencies', ` +
      `\`pkg#name\` one project's. Fix the name, or use [] to decouple on purpose.`
    for (const [name, dep] of [
      ['compile', 'all'],
      ['^compile', '^all'],
      ['lib#compile', 'lib#all'],
    ] as const) {
      expect(cacheRefusal({ files: ['src/**'], tasks: [name] }, { files: [] }, [dep])).toBe(
        refused(name, dep),
      )
      // Control: the group itself is named.
      expect(cacheRefusal({ files: ['src/**'], tasks: [dep] }, { files: [] }, [dep])).toBeNull()
    }
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
      'ignore.systemInfo',
      { ignore: { systemInfo: [''] } },
      `${W}.sandbox.ignore.systemInfo must be an array of non-empty strings`,
    ],
    [
      'ignore.network',
      { ignore: { network: true } },
      `${W}.sandbox.ignore.network must be an array of non-empty strings`,
    ],
    // A denial is classed read, write, systemInfo or network: every other
    // grant name loaded here and silenced nothing (D-4).
    ...['machLookup', 'unixSockets', 'localBinding', 'pty', 'gitConfig'].map(
      (f): [string, unknown, string] => [
        `ignore.${f}`,
        { ignore: { [f]: ['x'] } },
        `${W}.sandbox.ignore has unknown field "${f}" (allowed: network, read, systemInfo, write)`,
      ],
    ),
  ]
  for (const f of ['read', 'write']) {
    it(`refuses a NUL byte in allow.${f} at the boundary`, () => {
      expect(sandboxRefusal({ allow: { [f]: ['a\0b'] } })).toBe(
        `${W}.sandbox.allow.${f}: "a\\u0000b" holds a NUL byte`,
      )
      expect(sandboxRefusal({ allow: { [f]: ['a/b'] } })).toBeNull()
    })
  }
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
        ignore: { read: ['/proc/**'], write: ['x'], network: ['y'], systemInfo: ['hw.ncpu'] },
      }),
    ).toBeNull()
  })
})

describe('workspace fields another runner spells elsewhere (D-38)', () => {
  it('names where vx keeps each one', () => {
    const where = (key: string): string | undefined => {
      try {
        validateWorkspace({ [key]: {} } as never, '.vx/workspace.ts')
      } catch (err) {
        return (err as Error).message.split(' — ')[1]
      }
      return undefined
    }
    expect(where('pipeline')).toBe(
      "vx spells it each package's `vx.config` `tasks` (`bunx @vzn/vx-migrate` writes them from turbo.json)",
    )
    expect(where('remoteCache')).toBe(
      'vx spells it a cache plugin in `plugins` (`turboCache()` or `nxCache()` from `@vzn/vx-migrate`)',
    )
    expect(where('globalEnv')).toBe('vx spells it `inputs.env` on the tasks it keys')
    expect(where('parallel')).toBe('vx spells it `run.concurrency`')
    expect(where('cacheDirectory')).toBe('vx spells it `cache.dir`')
    // CONTROL: a typo still gets the nearest spelling.
    expect(where('concurency')).toBe('did you mean `run.concurrency`?')
  })

  it("names where vx keeps Nx's nx.json and Turbo's global keys (D-49)", () => {
    const where = (key: string): string | undefined => {
      try {
        validateWorkspace({ [key]: {} } as never, '.vx/workspace.ts')
      } catch (err) {
        return (err as Error).message.split(' — ')[1]
      }
      return undefined
    }
    expect(where('defaultBase')).toBe('vx spells it `baseBranch`')
    expect(where('tasksRunnerOptions')).toBe(
      'vx spells it a cache plugin in `plugins` (`nxCache()` from `@vzn/vx-migrate`)',
    )
    expect(where('globalPassThroughEnv')).toBe(
      'vx spells it `exec.env.passThrough` on the tasks it passes to',
    )
  })

  it('an Nx-style plugin name says what a vx plugin is (D-49)', () => {
    const refusal = (plugins: unknown[]): string => {
      try {
        validateWorkspace({ plugins } as never, '.vx/workspace.ts')
      } catch (err) {
        return (err as Error).message
      }
      return ''
    }
    expect(refusal(['@nx/vite/plugin'])).toBe(
      ".vx/workspace.ts: `plugins[0]` must be an object — a plugin is what its package's function returns (`nx()` from `@vzn/vx-migrate`), not a module name",
    )
    // CONTROL: any other non-object keeps the plain refusal.
    expect(refusal([42])).toBe('.vx/workspace.ts: `plugins[0]` must be an object')
    // `plugins: [otel]`, the factory itself, was told only that it is no object.
    expect(refusal([function otel() {}])).toBe(
      ".vx/workspace.ts: `plugins[0]` must be an object — it is the function 'otel'; call it: otel()",
    )
  })

  it('one plugin object listed twice is refused', async () => {
    // Two presets that both carry one shared instance: its setup, every
    // `ctx.on` handler and every telemetry sink ran twice, so each record
    // was exported twice. Two instances of one package stay two plugins.
    const { testPlugin } = await import('./helpers/plugin.js')
    const p = testPlugin('@acme/shared', { teardown() {} })
    const refusal = (plugins: unknown[]): string => {
      try {
        validateWorkspace({ plugins } as never, '.vx/workspace.ts')
      } catch (err) {
        return (err as Error).message
      }
      return ''
    }
    expect(refusal([p, false, p])).toBe(
      ".vx/workspace.ts: `plugins[2]` is `plugins[0]` again (plugin '@acme/shared') — declare a plugin once",
    )
    expect(refusal([p, testPlugin('@acme/shared', { teardown() {} })])).toBe('')
  })

  it('an undefined, null or false entry is skipped, as Vite skips it', () => {
    const refusal = (plugins: unknown[]): string => {
      try {
        validateWorkspace({ plugins } as never, '.vx/workspace.ts')
      } catch (err) {
        return (err as Error).message
      }
      return ''
    }
    expect(refusal([undefined, null, false])).toBe('')
    // CONTROL: the index past a skipped entry is still the entry's own.
    expect(refusal([undefined, 0])).toBe('.vx/workspace.ts: `plugins[1]` must be an object')
    expect(refusal([true])).toBe('.vx/workspace.ts: `plugins[0]` must be an object')
  })
})

describe("Turbo's and Nx's glob tokens (D-50)", () => {
  // vx expands none of them: `$TURBO_DEFAULT$` as the input list keyed the
  // task on no file, and an edited source replayed the old output.
  it('is refused in each glob list, naming what vx writes instead', () => {
    expect(cacheRefusal({ files: ['$TURBO_DEFAULT$'] })).toBe(
      `${CFG}: tasks.t.inputs.files: "$TURBO_DEFAULT$" holds $TURBO_DEFAULT$, Turbo's default input set, which vx does not have — list the files, such as "**" for everything in the project`,
    )
    expect(cacheRefusal({ files: ['**', '{projectRoot}/src/**'] })).toBe(
      `${CFG}: tasks.t.inputs.files: "{projectRoot}/src/**" holds {projectRoot}, Nx's project root — drop it: \`files\` globs are project-relative already`,
    )
    expect(cacheRefusal({ files: ['**'], workspaceFiles: ['$TURBO_ROOT$/tsconfig.json'] })).toBe(
      `${CFG}: tasks.t.inputs.workspaceFiles: "$TURBO_ROOT$/tsconfig.json" holds $TURBO_ROOT$, Turbo's workspace root — name the path without it in \`workspaceFiles\`, which is workspace-root-relative`,
    )
    expect(cacheRefusal({ files: ['**'] }, { files: ['{workspaceRoot}/dist/**'] })).toBe(
      `${CFG}: tasks.t.cache.outputs.files: "{workspaceRoot}/dist/**" holds {workspaceRoot}, Nx's workspace root — name the path without it in \`workspaceFiles\`, which is workspace-root-relative`,
    )
    // CONTROL: a brace alternation and a `$` in a name are globs.
    expect(cacheRefusal({ files: ['{src,lib}/**', 'a$b.txt'] })).toBeNull()
  })

  it("Nx's upstream named input is refused; a bare name stays a path (D-51)", () => {
    expect(cacheRefusal({ files: ['default', '^production'] })).toBe(
      `${CFG}: tasks.t.inputs.files: "^production" starts with ^, Nx's named input of the dependencies — vx keys a task on its dependencies through \`dependsOn\` (\`^build\`); list this project's files here`,
    )
    expect(cacheRefusal({ files: ['**', '!^default'] })).toContain('"!^default" starts with ^')
    // CONTROL: `default` may be a directory (themes/default), and `^` inside a
    // path is a character.
    expect(cacheRefusal({ files: ['default', 'a^b/**'] })).toBeNull()
  })

  it("Nx's option and project-name interpolations are refused (D-52)", () => {
    // `{options.outputPath}` as an output matched nothing: the miss saved an
    // empty artifact and a later hit restored no build.
    expect(cacheRefusal({ files: ['src/**'] }, { files: ['{options.outputPath}'] })).toBe(
      `${CFG}: tasks.t.cache.outputs.files: "{options.outputPath}" holds {options.…}, an Nx target option, which vx does not interpolate — write the path the option names`,
    )
    expect(cacheRefusal({ files: ['**'] }, { files: ['dist/{projectName}/**'] })).toBe(
      `${CFG}: tasks.t.cache.outputs.files: "dist/{projectName}/**" holds {projectName}, Nx's project name, which vx does not interpolate — write the name`,
    )
    // CONTROL: a brace set whose alternative starts `options` is a glob.
    expect(cacheRefusal({ files: ['**'] }, { files: ['{options,dist}/**'] })).toBeNull()
  })
})

describe("Turbo's env exclusion (D-53)", () => {
  // `!SECRET` takes a name back out of a Turbo wildcard; vx has none, so it
  // was a variable named `!SECRET`, and nothing said so.
  it('is refused in each env list', () => {
    expect(cacheRefusal({ files: ['**'], env: ['API_URL', '!SECRET'] })).toBe(
      `${CFG}: tasks.t.inputs.env: "!SECRET" is Turbo's exclusion from a wildcard — vx lists names explicitly, so leave SECRET out`,
    )
    expect(taskRefusal({ exec: { command: 'x', env: { passThrough: ['!AWS_KEY'] } } })).toBe(
      `${CFG}: tasks.t.exec.env.passThrough: "!AWS_KEY" is Turbo's exclusion from a wildcard — vx lists names explicitly, so leave AWS_KEY out`,
    )
    expect(taskRefusal({ exec: { command: 'x', env: { secret: ['!TOKEN'] } } })).toContain(
      'exec.env.secret: "!TOKEN" is Turbo\'s exclusion',
    )
    // CONTROL: a `!` inside a name is the name.
    expect(cacheRefusal({ files: ['**'], env: ['A!B'] })).toBeNull()
  })
})

describe("a package turbo.json's and Nx project.json's keys (D-56)", () => {
  // `tags` read as a typo of `tasks`, and `targets` or `extends` named no
  // home at all.
  it('names where vx keeps each one', () => {
    const where = (field: Record<string, unknown>): string | undefined => {
      try {
        validateProjectConfig({ ...field, tasks: {} } as never, CFG)
      } catch (err) {
        return (err as Error).message.split(' — ')[1]
      }
      return undefined
    }
    expect(where({ targets: {} })).toBe(
      'vx spells it `tasks` (a target is a task: `exec.command`, `dependsOn`, `cache`)',
    )
    expect(where({ extends: ['//'] })).toBe(
      'vx spells it an imported module spread into `tasks` (a vx.config is code; nothing is inherited)',
    )
    expect(where({ implicitDependencies: ['b'] })).toBe(
      'vx spells it a `dependsOn` entry `pkg#task`, or a package.json dependency',
    )
    // `name` is a project field of vx's own.
    expect(where({ name: 'a' })).toBeUndefined()
    // CONTROL: a typo of `tasks` still gets the nearest spelling.
    expect(where({ taks: {} })).toBe('did you mean tasks?')
  })
})

describe('project tags', () => {
  const refusal = (tags: unknown): string | null => {
    try {
      validateProjectConfig({ tags, tasks: {} } as never, CFG)
    } catch (err) {
      return (err as Error).message
    }
    return null
  }
  it('takes an array of non-empty strings', () => {
    expect(refusal(['ui', 'scope:web'])).toBeNull()
    expect(refusal([])).toBeNull()
  })
  it('refuses anything else, by the field', () => {
    const msg = `${CFG}: \`tags\` must be an array of non-empty strings`
    for (const bad of ['ui', ['ui', ''], ['  '], [1], [null], { ui: true }])
      expect(refusal(bad)).toBe(msg)
  })
  // Each loaded, and `--filter tag:<it>` parsed as something else: the
  // padding is lost to the shell, `v1...` walked v1's deps, `v[2]` asked
  // git for ref 2.
  it.each([
    [' ui', 'has surrounding whitespace'],
    ['ui\t', 'has surrounding whitespace'],
    ['ui*', "holds '*', which makes it a pattern"],
    ['v1...', "ends in '...', which a filter reads as a dependency walk"],
    ['v1^...', "ends in '...', which a filter reads as a dependency walk"],
    ['v[2]', 'ends in "[2]", which a filter reads as a git range'],
  ])('refuses %j, which a tag filter cannot name', (tag, why) => {
    expect(refusal(['ok', tag])).toBe(
      `${CFG}: tag ${JSON.stringify(tag)} ${why} — \`--filter tag:<name>\` could not name it. Rename the tag.`,
    )
  })
  it('keeps the characters a tag filter reads literally', () => {
    expect(refusal(['scope:web', 'a.b', 'v1..', '[x', 'x]', 'a b', 'a#b', '^x', '!x'])).toBeNull()
  })
})

// Nx 23.3 compare, 2026-10-04: `Bun.Glob` has no extglob, so an input of
// `src/@(x|y).ts` keyed no file and an edit to src/x.ts replayed a stale
// hit with `vx why` reporting the key unchanged.
describe('an extglob in a task glob', () => {
  const task = (inputs: object, outputs: object = { files: ['dist/**'] }) => ({
    exec: { command: 'x' },
    inputs,
    cache: { outputs },
  })
  const tail =
    `" is an extglob, which vx's glob engine reads as literal text or a ` +
    'plain wildcard, never as the alternatives it lists, so the cache key would miss the files it names.'

  it('is refused in every task glob field, with the brace it means when there is one', () => {
    expect(taskRefusal(task({ files: ['src/@(x|y).ts'] }))).toBe(
      `${CFG}: tasks.t.inputs.files: "src/@(x|y).ts${tail} Write "src/{x,y}.ts" instead.`,
    )
    expect(taskRefusal(task({ files: ['src/@(x).ts'] }))).toBe(
      `${CFG}: tasks.t.inputs.files: "src/@(x).ts${tail} Write "src/x.ts" instead.`,
    )
    const generic = 'Write braces ("{a,b}") or one entry per alternative instead.'
    for (const g of ['src/!(x).ts', 'src/+(a).ts', 'src/*(a).ts', 'src/?(a).ts', 'src/@(*.a|b)']) {
      expect(taskRefusal(task({ files: [g] }))).toBe(
        `${CFG}: tasks.t.inputs.files: "${g}${tail} ${generic}`,
      )
    }
    expect(taskRefusal(task({ files: ['**', '!src/@(x|y).ts'] }))).toBe(
      `${CFG}: tasks.t.inputs.files: "!src/@(x|y).ts${tail} Write "!src/{x,y}.ts" instead.`,
    )
    expect(taskRefusal(task({ files: ['**'], workspaceFiles: ['@(a|b).json'] }))).toBe(
      `${CFG}: tasks.t.inputs.workspaceFiles: "@(a|b).json${tail} Write "{a,b}.json" instead.`,
    )
    expect(taskRefusal(task({ files: ['**'] }, { files: ['@(dist|lib)/**'] }))).toBe(
      `${CFG}: tasks.t.cache.outputs.files: "@(dist|lib)/**${tail} Write "{dist,lib}/**" instead.`,
    )
    expect(
      taskRefusal(task({ files: ['**'] }, { files: ['dist/**'], workspaceFiles: ['+(x)'] })),
    ).toBe(`${CFG}: tasks.t.cache.outputs.workspaceFiles: "+(x)${tail} ${generic}`)
  })

  it('leaves a route group and its negation alone', () => {
    // CONTROL: `(group)` is a Next.js route group, and a leading `!` is
    // vx's own negation, so `!(group)/**` takes one back.
    expect(taskRefusal(task({ files: ['app/(marketing)/**', 'src/{x,y}.ts'] }))).toBeNull()
    expect(taskRefusal(task({ files: ['**', '!(group)/**'] }))).toBeNull()
  })
})

// X-67: a Windows spelling loaded with only a "matched no files" warning,
// so the task's key never saw its source and an edit replayed the old output.
describe('a backslash separator or a drive letter in a task glob', () => {
  const task = (inputs: object, outputs: object = { files: ['dist/**'] }) => ({
    exec: { command: 'x' },
    inputs,
    cache: { outputs },
  })
  const sep = (field: string, g: string, write: string, base = 'project') =>
    `${CFG}: tasks.t.${field}: "${g}" uses a backslash as a path separator — task globs ` +
    `are ${base}-relative with forward slashes: write "${write}"`
  const drive = (field: string, g: string, write: string, base = 'project') =>
    `${CFG}: tasks.t.${field}: "${g}" starts with a Windows drive — task globs ` +
    `are ${base}-relative with forward slashes: write "${write}"`

  it('is refused in every task glob list, with the forward-slash spelling', () => {
    expect(taskRefusal(task({ files: ['src\\**'] }))).toBe(sep('inputs.files', 'src\\**', 'src/**'))
    expect(taskRefusal(task({ files: ['src\\lib\\*.ts'] }))).toBe(
      sep('inputs.files', 'src\\lib\\*.ts', 'src/lib/*.ts'),
    )
    expect(taskRefusal(task({ files: ['src\\'] }))).toBe(sep('inputs.files', 'src\\', 'src/'))
    expect(taskRefusal(task({ files: ['**', '!src\\gen\\**'] }))).toBe(
      sep('inputs.files', '!src\\gen\\**', '!src/gen/**'),
    )
    expect(taskRefusal(task({ files: ['C:\\src\\**'] }))).toBe(
      drive('inputs.files', 'C:\\src\\**', 'src/**'),
    )
    expect(taskRefusal(task({ files: ['C:/src/**'] }))).toBe(
      drive('inputs.files', 'C:/src/**', 'src/**'),
    )
    expect(taskRefusal(task({ files: ['{c:/x,src}/**'] }))).toBe(
      drive('inputs.files', '{c:/x,src}/**', '{x,src}/**'),
    )
    expect(taskRefusal(task({ files: ['**'], workspaceFiles: ['config\\*.json'] }))).toBe(
      sep('inputs.workspaceFiles', 'config\\*.json', 'config/*.json', 'workspace-root'),
    )
    expect(taskRefusal(task({ files: ['**'] }, { files: ['dist\\**'] }))).toBe(
      sep('cache.outputs.files', 'dist\\**', 'dist/**'),
    )
    expect(
      taskRefusal(task({ files: ['**'] }, { files: ['dist/**'], workspaceFiles: ['D:\\out\\**'] })),
    ).toBe(drive('cache.outputs.workspaceFiles', 'D:\\out\\**', 'out/**', 'workspace-root'))
  })

  it('leaves an escape and a colon in a name alone', () => {
    // CONTROL: a backslash before a glob character escapes it (Turbo's
    // `app/\[id\]/**`), and a colon past a drive's one letter is a name.
    expect(
      taskRefusal(task({ files: ['app/\\[id\\]/**', 'src/\\{b\\}.ts', '\\!x', 'x\\\\y'] })),
    ).toBeNull()
    expect(taskRefusal(task({ files: ['src/C:/x', 'ab:/x', 'src/**'] }))).toBeNull()
  })
})

// `exec.retries` overrides `run.retries` and is the same setting kind: a
// count past 2^53 is no count either names (run.retries refused it, a
// task's took it).
describe('exec.retries', () => {
  it('is refused past the safe integers, as run.retries is', () => {
    expect(refusal({ run: { retries: 2 ** 60 } })).toBe(
      `${WS}: \`run.retries\` must be a non-negative integer (got ${2 ** 60})`,
    )
    expect(taskRefusal({ exec: { command: 'x', retries: 2 ** 60 } })).toBe(
      `${CFG}: tasks.t.exec.retries must be a non-negative integer (got ${2 ** 60})`,
    )
    // Control: a large safe count is taken.
    expect(taskRefusal({ exec: { command: 'x', retries: 2 ** 31 } })).toBeNull()
  })
})
