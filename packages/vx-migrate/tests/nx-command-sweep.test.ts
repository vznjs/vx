// Item 813's sweep of nx-command.ts: each row fails with one line of the
// mapper undone. Exact text per option shape, as nx-command.test.ts pins it.
import { describe, expect, it } from 'bun:test'
import { mapRunCommands, shellQuote } from '../src/nx-command.js'

const CTX = { projectRel: 'packages/a', projectName: 'a' }

function line(options: Record<string, unknown>, ctx = CTX) {
  const todos: string[] = []
  const out = mapRunCommands(options, ctx, todos)
  return { out, todos }
}

/** The line's body for one command that takes no arguments. */
const one = (text: string) => `nx_run_commands() { (${text}); }; cd ../.. && nx_run_commands`

describe('placeholders and where the line starts', () => {
  it('every {projectName} is expanded, not only the first', () => {
    expect(line({ command: 'echo {projectName} {projectName}' }).out?.command).toBe(
      'cd ../.. && echo a a',
    )
  })

  it('a project dir given as the empty string is the workspace root: no cd', () => {
    expect(line({ command: 'make' }, { projectRel: '', projectName: 'root' }).out?.command).toBe(
      'make',
    )
  })

  it('an empty envFile is no envFile', () => {
    expect(line({ command: 'x', envFile: '' }).out?.envFile).toBeUndefined()
  })
})

describe('shellQuote', () => {
  it('quotes the empty word, and closes and reopens around a single quote', () => {
    expect([shellQuote(''), shellQuote("it's")]).toEqual(["''", "'it'\\''s'"])
  })
})

describe('the --name=value Nx appends, quoted as Nx quotes it', () => {
  const forwarded = (value: string) =>
    line({ commands: ['a', 'b'], parallel: false, q: value }).out?.command
  const expected = (arg: string) => {
    const q = shellQuote(`a ${arg}`)
    const r = shellQuote(`b ${arg}`)
    return (
      `nx_run() { nx_c=$1; shift; if [ $# -eq 0 ]; then eval "$nx_c"; else eval "$nx_c \\"\\$@\\""; fi; }; ` +
      `nx_run_commands() { (nx_run ${q} "$@") && (nx_run ${r} "$@"); }; cd ../.. && nx_run_commands`
    )
  }

  it('a lone double quote is not "already quoted": it is wrapped and escaped', () => {
    expect(forwarded('"')).toBe(expected('--q="\\""'))
  })

  it('a value already in single quotes is kept as it is', () => {
    expect(forwarded("'a b'")).toBe(expected("--q='a b'"))
  })

  it('double quotes inside a value that needs quoting are escaped', () => {
    expect(forwarded('say "hi"')).toBe(expected('--q="say \\"hi\\""'))
  })
})

describe('the `args` option as yargs-parser reads it, through {args.name}', () => {
  const filled = (template: string, args: string, extra: Record<string, unknown> = {}) =>
    line({ command: `echo ${template}`, args, ...extra }).out?.command

  it('a number with a leading zero stays a string; an exponent is a number', () => {
    expect(filled('{args.n}-{args.e}', '--n=007 --e=1e3')).toBe(one('echo 007-1000'))
  })

  it('a kebab-case name is also its camel-case name', () => {
    expect(filled('{args.outDir}', '--out-dir=dist')).toBe(one('echo dist'))
  })

  it('a repeated name collects its values, joined with a comma', () => {
    expect(filled('{args.t}', '--t=a --t=b --t=c')).toBe(one('echo a,b,c'))
  })

  it('a dotted name is not set', () => {
    expect(filled('{args.a.b}', '--a.b=1')).toBe(one('echo '))
  })

  it('--no-name is the name set false', () => {
    expect(filled('{args.watch}', '--no-watch')).toBe(one('echo false'))
  })

  it('a flag followed by another flag is true, not the next token', () => {
    expect(filled('{args.dry}', '--dry --tag=x')).toBe(one('echo true'))
  })

  it('an object option fills as [object Object], whatever keys it holds', () => {
    expect(filled('{args.o}', '', { o: { toString: 'x' } })).toBe(one('echo [object Object]'))
  })
})

describe('which options make a line', () => {
  it('an empty `command` defers to `commands`', () => {
    expect(line({ command: '', commands: ['make'] }).out?.command).toBe('cd ../.. && make')
  })

  it('a `command` array is its words joined with spaces', () => {
    expect(line({ command: ['vite', 'build'] }).out?.command).toBe('cd ../.. && vite build')
  })

  it('a command entry whose command is not a string is refused with the options', () => {
    const options = { commands: ['a', { command: 3 }] }
    expect(line(options)).toEqual({
      out: null,
      todos: [
        `nx:run-commands: a command entry has no command — options: ${JSON.stringify(options)}`,
      ],
    })
  })

  it('a readyWhen list keeps its strings only', () => {
    expect(line({ command: 'serve', readyWhen: ['up', 3] }).out?.readyWhen).toBe('up')
  })
})

describe('what the line does not reproduce, and what it does', () => {
  const DECORATION =
    'nx:run-commands: per-command `prefix` / `color` output decoration is not reproduced'

  it('`prefixColor` or `bgColor` alone is decoration reported', () => {
    expect(line({ commands: [{ command: 'a', prefixColor: 'red' }] }).todos).toEqual([DECORATION])
    expect(line({ commands: [{ command: 'a', bgColor: 'blue' }] }).todos).toEqual([DECORATION])
  })

  it('an empty `__unparsed__` is nothing to report; a non-empty one is', () => {
    expect(line({ command: 'a', __unparsed__: [] }).todos).toEqual([])
    expect(line({ command: 'a', __unparsed__: ['--x'] }).todos).toEqual([
      'nx:run-commands: `__unparsed__` in the graph is not forwarded',
    ])
  })

  it('an `args` array is its words joined with spaces, parsed as one string', () => {
    expect(line({ command: 'echo {args.a}{args.b}', args: ['--a=1', '--b=2'] }).out?.command).toBe(
      one('echo 12'),
    )
  })

  it('an `args` string wrapped in double quotes is read without them', () => {
    expect(line({ command: 'echo {args.tag}', args: '"--tag=x"' }).out?.command).toBe(one('echo x'))
  })
})

describe('the body, env and color', () => {
  it('one command of a parallel list is a plain subshell, no jobs', () => {
    expect(line({ commands: ['make'], forwardAllArgs: false }).out?.command).toBe(one('make'))
  })

  it('an `env` that is not an object is reported, and nothing is set', () => {
    expect(line({ command: 'x', env: 'A=1' })).toEqual({
      out: { command: 'cd ../.. && x', env: {}, readyWhen: undefined, envFile: undefined },
      todos: ['nx:run-commands: `env` is not an object — not set'],
    })
  })

  it('`color` other than true sets no FORCE_COLOR', () => {
    expect(line({ command: 'x', color: 'always' }).out?.env).toEqual({})
  })
})
