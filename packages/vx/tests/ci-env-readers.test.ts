import { describe, expect, it } from 'bun:test'
import { ciProvider, envFlagOn as onCI } from '../src/util/index.js'
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
    expect(resolveOutputView({ flow: 'broad' }, { CI: 'yes' })).toEqual({
      mode: 'errors-only',
      ci: true,
    })
  })
})

// 2026-11-23: `CI=no` and `CI=off` read as CI, so a laptop with either wrote
// the shared remote cache; and the output view read `CI` alone, so a Jenkins
// job (no `CI`) got the laptop's flow while every other reader called it CI.
describe('one rule for "on CI"', () => {
  it.each([[''], ['0'], ['false'], ['no'], ['NO'], ['off'], ['Off'], [' no ']])(
    'CI=%p is not CI to any reader',
    (value) => {
      expect([
        ciProvider({ CI: value }),
        ciProvider({ JENKINS_URL: value }),
        detectCi({ CI: value }).ci,
        resolveOutputView({ flow: 'broad' }, { CI: value }),
      ]).toEqual([null, null, false, { mode: 'broad' }])
    },
  )

  it('a CI known by its own variable gets the CI output flow', () => {
    expect(resolveOutputView({ flow: 'broad' }, { JENKINS_URL: 'https://ci.example/' })).toEqual({
      mode: 'errors-only',
      ci: true,
    })
    expect(resolveOutputView({ flow: 'broad' }, { GITHUB_ACTIONS: 'true' })).toEqual({
      mode: 'errors-only',
      gha: true,
      ci: true,
    })
  })
})
