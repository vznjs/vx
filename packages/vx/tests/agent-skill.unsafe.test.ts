// The agent skill (skills/vx/SKILL.md) is what an agent trusts without
// reading the code: each command it shows is a verb vx has, each flag one
// that verb accepts, and its MCP list is @vzn/vx-mcp's tools. Unsafe: it
// reads another package.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import { acceptedFlags, CORE_VERBS } from '../src/cli/help.js'

const SKILL = readFileSync(path.resolve(import.meta.dir, '..', 'skills', 'vx', 'SKILL.md'), 'utf8')
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

  it("names exactly @vzn/vx-mcp's tools", () => {
    const tools = readFileSync(
      path.resolve(import.meta.dir, '..', '..', 'vx-mcp', 'src', 'tools.ts'),
      'utf8',
    )
    const want = [...tools.matchAll(/^ {4}name: '(\w+)'/gm)].map((m) => m[1]!).sort()
    const listed = /Its tools: ([^.]+)\./.exec(SKILL)![1]!
    const got = [...listed.matchAll(/`(\w+)`/g)].map((m) => m[1]!).sort()
    expect(want.length).toBeGreaterThan(5)
    expect(got).toEqual(want)
  })
})
