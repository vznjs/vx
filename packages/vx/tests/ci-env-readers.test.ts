import { describe, expect, it } from 'bun:test'
import { onCI } from '../src/cli/run.js'
import { detectCi } from '../src/orchestrator/run-context.js'
import { resolveOutputView } from '../src/report/logger.js'

// detectCi folds case before it reads `false` (item 509). The remote-write
// default (`onCI`) and the output view read CI too: with `CI=False` they
// called a laptop CI while detectCi did not, so the run wrote the shared
// remote cache and printed CI output on a machine its header said was not CI.
describe('every reader of CI agrees with detectCi', () => {
  it.each([['False'], ['FALSE'], ['fAlSe']])('CI=%s is not CI', (spelling) => {
    expect(detectCi({ CI: spelling }).ci).toBe(false)
    expect(onCI(spelling)).toBe(false)
    expect(resolveOutputView({ flow: 'broad' }, { CI: spelling })).toEqual({ mode: 'broad' })
    expect(resolveOutputView({ flow: 'broad' }, { GITHUB_ACTIONS: spelling })).toEqual({
      mode: 'broad',
    })
  })

  it('CONTROL: an unrecognised value is CI to each of them', () => {
    expect(detectCi({ CI: 'yes' }).ci).toBe(true)
    expect(onCI('yes')).toBe(true)
    expect(resolveOutputView({ flow: 'broad' }, { CI: 'yes' })).toEqual({ mode: 'full', ci: true })
  })
})
