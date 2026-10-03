// Nx's run-commands throws when a command carries `prefix`, `prefixColor`,
// `color` or `bgColor` and the run is serial ("can only be set when
// parallel=true"): such a target never ran under Nx. The mapper wrote a
// working line with a cosmetic TODO; it is the placeholder with Nx's
// reason now, as `readyWhen` without `parallel` already was.
import { describe, expect, it } from 'bun:test'
import { mapRunCommands } from '../src/nx-command.js'

const CTX = { projectRel: 'packages/a', projectName: 'a' }
const map = (options: Record<string, unknown>) => {
  const todos: string[] = []
  return { out: mapRunCommands(options, CTX, todos), todos }
}
const REFUSED =
  'nx:run-commands: Nx refuses `prefix` / `prefixColor` / `color` / `bgColor` without `parallel: true`'

describe('run-commands decoration in a serial run', () => {
  it('is refused as Nx refuses it, for each decoration', () => {
    for (const deco of ['prefix', 'prefixColor', 'color', 'bgColor']) {
      expect(map({ commands: [{ command: 'a', [deco]: 'x' }, 'b'], parallel: false })).toEqual({
        out: null,
        todos: [REFUSED],
      })
    }
  })

  // Control: in a parallel run the decoration is only not reproduced.
  it('in a parallel run is a line with the decoration TODO', () => {
    const r = map({ commands: [{ command: 'a', prefix: 'A' }, 'b'] })
    expect(r.out).not.toBeNull()
    expect(r.todos).toEqual([
      'nx:run-commands: per-command `prefix` / `color` output decoration is not reproduced',
    ])
  })
})
