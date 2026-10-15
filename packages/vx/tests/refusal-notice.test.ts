import { describe, expect, it } from 'bun:test'
import { refusal } from '../src/util/errors.js'
import { lineNotice, messageParts, refusalNotice } from '../src/util/refusal-notice.js'
import { render } from '../src/util/ui.js'

const plain = (b: Parameters<typeof render>[0][number]): string => render([b], { enabled: false })

describe('messageParts', () => {
  it('heads with the first sentence; each later one is a line', () => {
    expect(messageParts('no projects declare task(s): buidl. Run vx show to list them.')).toEqual({
      headline: 'no projects declare task(s): buidl',
      what: ['Run vx show to list them'],
    })
  })

  it('takes "(did you mean X?)" and ". Did you mean X?" as the fix', () => {
    expect(messageParts('unknown flag --concurency (did you mean --concurrency?)')).toEqual({
      headline: 'unknown flag --concurency',
      fix: '--concurrency',
    })
    expect(messageParts('no projects declare task(s): buidl. Did you mean build?')).toEqual({
      headline: 'no projects declare task(s): buidl',
      fix: 'build',
    })
  })

  it('takes "(see `cmd`)" as the why line', () => {
    expect(messageParts('missing task name (see `vx run --help`)')).toEqual({
      headline: 'missing task name',
      why: 'see vx run --help',
    })
  })

  it('keeps indented lines under the first as facts', () => {
    expect(
      messageParts('2 tasks refused:\n  a#build has no inputs\n  b#build has no inputs'),
    ).toEqual({
      headline: '2 tasks refused',
      what: ['a#build has no inputs', 'b#build has no inputs'],
    })
  })

  it('does not split inside a sentence on a semicolon or a lowercase word', () => {
    expect(messageParts('a.b is set; c is not. so it stays').headline).toBe(
      'a.b is set; c is not. so it stays',
    )
  })
})

describe('refusalNotice', () => {
  it('lays a message out as status, facts and fix', () => {
    expect(
      plain(refusalNotice('vx run', 'no projects declare task(s): buidl. Did you mean build?')),
    ).toBe('✗ vx run  no projects declare task(s): buidl\n\n  fix  build\n')
  })

  it("uses a refusal's own parts over its message", () => {
    const e = refusal({
      headline: 'lock not written',
      what: ['a and b both write dist/**'],
      fix: 'give each its own path',
    })
    expect(plain(refusalNotice('vx lock', e.message, e.parts))).toBe(
      '✗ vx lock  lock not written\n\n  a and b both write dist/**\n\n  fix  give each its own path\n',
    )
  })

  it("a set headline heads, and the refusal's headline joins the facts", () => {
    expect(
      plain(
        refusalNotice(
          'vx lock',
          'x',
          { headline: 'secret in a config' },
          { headline: 'lock not written' },
        ),
      ),
    ).toBe('✗ vx lock  lock not written\n\n  secret in a config\n')
  })
})

describe('lineNotice', () => {
  it('reads the verb off a `vx X:` prefix', () => {
    expect(plain(lineNotice('warn', 'vx watch: polling packages/a'))).toBe(
      '! vx watch  polling packages/a\n',
    )
    expect(plain(lineNotice('info', 'nothing to do'))).toBe('› vx  nothing to do\n')
  })
})
