// The agent skill (skills/vx/SKILL.md) is what an agent trusts without
// reading the code: each command it shows is a verb vx has, each flag one
// that verb accepts, each JSON field it names one its schema declares.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import { acceptedFlags } from '../src/cli/help.js'
import { CORE_VERBS } from '../src/util/index.js'

const SKILL = readFileSync(
  path.resolve(import.meta.dir, '..', '..', '..', 'skills', 'vx', 'SKILL.md'),
  'utf8',
)
const byName = (a: string, b: string): number => a.localeCompare(b)
const schema = (verb: string): Record<string, any> =>
  JSON.parse(readFileSync(path.resolve(import.meta.dir, '..', 'schemas', `${verb}.json`), 'utf8'))
const shell = [...SKILL.matchAll(/```sh\n([\s\S]*?)```/g)].map((m) => m[1]!).join('')
const commands = [...shell.matchAll(/^vx (\S+)([^\n#]*)/gm)].map((m) => ({
  verb: m[1]!,
  flags: (m[2]!.match(/--[a-z][a-z-]*/g) ?? []) as string[],
}))

describe('the agent skill', () => {
  it('is a skill: a name and a one-line description', () => {
    const front = /^---\nname: (.+)\ndescription: (.+)\n---\n/.exec(SKILL)
    expect(front?.[1]).toBe('vx')
    expect(front?.[2]!.length).toBeGreaterThan(40)
  })

  it('shows only verbs vx has, with flags each accepts', () => {
    expect(commands.length).toBeGreaterThan(5)
    const wrong = commands.flatMap(({ verb, flags }) =>
      !(CORE_VERBS as readonly string[]).includes(verb)
        ? [`vx ${verb}`]
        : flags.filter((f) => !acceptedFlags(verb).includes(f)).map((f) => `vx ${verb} ${f}`),
    )
    expect(wrong).toEqual([])
  })

  // It listed five of the six kinds: `workspace` was missing.
  it('names every affected kind the plan prints, and no other', () => {
    const sentence = /where `kind` is ([^.]*?), and\n?\s*`via`/s.exec(SKILL)?.[1]
    const named = [...(sentence ?? '').matchAll(/`([a-z]+)`/g)].map((m) => m[1]!)
    const kinds = schema('plan')['properties'].tasks.items.properties.affected.properties.kind
    expect(named.toSorted(byName)).toEqual((kinds.enum as string[]).toSorted(byName))
  })

  it('spells the refusal and a failed row as their schemas do', () => {
    const refusal = /`\{"ok":false,"error":\{([^}]*)\}\}`/.exec(SKILL)?.[1]
    expect(
      refusal
        ?.split(',')
        .map((k) => JSON.parse(k))
        .sort(),
    ).toEqual(Object.keys(schema('error')['properties'].error.properties).sort())
    const row = Object.keys(schema('last')['$defs'].task.properties)
    for (const field of ['output', 'locations', 'dir', 'warnings']) {
      expect(SKILL).toContain(`\`${field}\``)
      if (field !== 'warnings') expect(row).toContain(field)
    }
  })
})
