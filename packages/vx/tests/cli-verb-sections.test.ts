// The CLI's verbs and flags are a 1.0 contract (contract-cli-surface
// records them, completions.test holds each verb's help to its parser).
// This holds the reference: each verb's flags are named in its own
// `docs/cli.md` section, and the section's synopsis names no flag the verb
// refuses. `vx run`'s flags are its Flags table's (cli-doc-drift.test.ts);
// `vx watch` takes run's, and its section names the ones it refuses.
//
// Named means a token in the section's code: an inline span
// (`` `vx init --plugin <seam>` ``) or a fenced sample.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import { verbFlags } from '../src/cli/completions.js'
import { CORE_VERBS, WATCH_REFUSED_FLAGS } from '../src/cli/help.js'

const CLI_MD = readFileSync(path.join(import.meta.dir, '..', 'docs', 'cli.md'), 'utf8')

/** `## \`vx <verb>…\`` up to the next `## `; undefined when the verb has none. */
function section(verb: string): string | undefined {
  const parts = CLI_MD.split(/^## /m)
  return parts.find((p) => p.startsWith(`\`vx ${verb}`) && /^`vx [a-z]+[ `]/.test(p))
}

function code(text: string): string {
  const fences = [...text.matchAll(/^```[^\n]*\n([\s\S]*?)^```/gm)].map((m) => m[1]!)
  const prose = text.replace(/^```[^\n]*\n[\s\S]*?^```/gm, '')
  return [...fences, ...(prose.match(/`[^`\n]+`/g) ?? [])].join('\n')
}

const named = (text: string, flag: string): boolean =>
  new RegExp(`(^|[^\\w-])${flag}(?![\\w-])`).test(code(text))

/** The first fenced block: the verb's synopsis. */
function synopsis(text: string): string {
  return /^```[^\n]*\n([\s\S]*?)^```/m.exec(text)?.[1] ?? ''
}

// run: its Flags table is held by cli-doc-drift; help/version: `--help` only.
const VERBS = CORE_VERBS.filter((v) => !['run', 'help', 'version'].includes(v))

describe("each verb's cli.md section names its flags", () => {
  it('reads a section and its code, and only code', () => {
    expect(section('lock')).toBeDefined()
    expect(named('the `vx init --plugin <seam>` form', '--plugin')).toBe(true)
    expect(named('```\nvx last --list=5\n```\n', '--list')).toBe(true)
    expect(named('pass --plugin to it', '--plugin')).toBe(false)
    expect(named('`--plugins`', '--plugin')).toBe(false)
  })

  it('every verb past run has a section', () => {
    expect(VERBS.filter((v) => section(v) === undefined)).toEqual([])
  })

  it('names every flag the verb accepts', () => {
    const missing: string[] = []
    for (const verb of VERBS) {
      const text = section(verb) ?? ''
      const flags = verb === 'watch' ? WATCH_REFUSED_FLAGS : verbFlags(verb)
      for (const flag of flags)
        if (flag !== '--help' && !named(text, flag)) missing.push(`${verb} ${flag}`)
    }
    expect(missing).toEqual([])
  })

  it('names in its synopsis no flag the verb refuses', () => {
    const foreign: string[] = []
    for (const verb of VERBS) {
      const accepted = new Set(verbFlags(verb))
      for (const flag of synopsis(section(verb) ?? '').match(/--[a-zA-Z][a-zA-Z-]*/g) ?? [])
        if (!accepted.has(flag)) foreign.push(`${verb} ${flag}`)
    }
    expect(foreign).toEqual([])
  })
})

// Exit codes are a 1.0 contract too: the exit-code records drive each
// documented outcome through the binary and hold the code it gave. The
// reference states them per verb, so every verb section says its codes,
// and every code a record holds for a verb is one its section names.
const RECORDS = ['exit-codes.json', 'exit-codes-init.json', 'exit-codes-states.json'].map(
  (f) =>
    JSON.parse(readFileSync(path.join(import.meta.dir, 'contract', f), 'utf8')) as Record<
      string,
      number
    >,
)

/** The section's text from its first "Exit code" on. */
function exitText(text: string): string | undefined {
  const at = text.search(/[Ee]xit codes?/)
  return at === -1 ? undefined : text.slice(at)
}

describe("each verb's cli.md section states its exit codes", () => {
  it('every verb with a section says them', () => {
    const silent = [...CORE_VERBS].filter((v) => {
      const text = section(v)
      return text !== undefined && exitText(text) === undefined
    })
    expect(silent).toEqual([])
  })

  it('every code a record holds is one the verb section names', () => {
    const unnamed: string[] = []
    let held = 0
    for (const record of RECORDS) {
      for (const [outcome, code] of Object.entries(record)) {
        const verb = /: vx ([a-z-]+)/.exec(outcome)?.[1]
        const text = verb === undefined ? undefined : section(verb)
        // An unknown verb has no section; `vx help` owns that refusal.
        if (text === undefined) continue
        held++
        if (!exitText(text)?.includes(`\`${code}\``)) unnamed.push(`${outcome} → ${code}`)
      }
    }
    expect(held).toBeGreaterThan(30)
    expect(unnamed).toEqual([])
  })
})
