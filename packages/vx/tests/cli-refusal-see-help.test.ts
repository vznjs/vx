// Every argument refusal a verb's parser returns ends with where to read
// more, `(see \`vx <verb> --help\`)`: the notice prints it as its "see"
// line. `vx why`'s --run, --cache-dir and missing task said nothing of it
// while every other verb's refusals did. `run` and `watch` share a parser
// whose caller appends it.

import { expect, it } from 'bun:test'
import { verbFlags } from '../src/cli/completions.js'
import { PARSE } from './helpers/cli-parsers.js'

it("each verb's parser refusals end with its help pointer", () => {
  const missing: string[] = []
  for (const [verb, parse] of Object.entries(PARSE)) {
    if (verb === 'run' || verb === 'watch') continue
    const tries: string[][] = [['--zzz'], ['a', 'b', 'c']]
    for (const f of verbFlags(verb)) {
      if (f === '--help') continue
      tries.push([f], [`${f}=`], [f, 'zq'], [`${f}=zq`], [f, '--zzz'])
    }
    for (const argv of tries) {
      const error = parse(argv)
      if (error !== null && !error.endsWith(` (see \`vx ${verb} --help\`)`))
        missing.push(`${verb} ${argv.join(' ')}: ${error}`)
    }
  }
  expect(missing).toEqual([])
})
