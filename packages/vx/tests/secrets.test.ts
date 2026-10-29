// A plugin's keychain (`ctx.secret`): the OS keychain under the plugin's
// name, then an optional prompt on a terminal, saved; never read from the
// environment. A stand-in store and terminal: the real keychain is never
// touched.
import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'bun:test'
import {
  isSecretUnavailable,
  SecretBroker,
  type SecretStore,
  type SecretTerminal,
  terminalOf,
} from '../src/util/index.js'

function store(initial: Record<string, string> = {}, broken = false) {
  const entries = new Map(Object.entries(initial))
  const calls: string[] = []
  const fail = () => {
    if (broken) throw new Error('libsecret not found')
  }
  const s: SecretStore = {
    async get({ service, name }) {
      calls.push(`get ${service} ${name}`)
      fail()
      return entries.get(`${service} ${name}`) ?? null
    },
    async set({ service, name, value }) {
      calls.push(`set ${service} ${name}`)
      fail()
      entries.set(`${service} ${name}`, value)
    },
    async delete({ service, name }) {
      calls.push(`delete ${service} ${name}`)
      fail()
      return entries.delete(`${service} ${name}`)
    },
  }
  return { s, calls, entries }
}

function terminal(answer: string | (() => Promise<string>), interactive = true) {
  const asked: string[] = []
  const t: SecretTerminal = {
    interactive: () => interactive,
    async ask(question) {
      asked.push(question)
      return typeof answer === 'string' ? answer : answer()
    },
  }
  return { t, asked }
}

const reason = (p: Promise<unknown>) =>
  p.then(
    () => '(resolved)',
    (e: unknown) => (isSecretUnavailable(e) ? e.reason : `not a SecretUnavailable: ${String(e)}`),
  )
const broker = (s: SecretStore, t: SecretTerminal, ci = false, warn: string[] = []) =>
  new SecretBroker(ci, (m) => warn.push(m), s, t)

describe('ctx.secret', () => {
  it('the keychain entry, under the plugin’s name; nobody asked', async () => {
    const { s, calls } = store({ '@acme/cache remote-a': 'kc' })
    const term = terminal('typed')
    const value = await broker(s, term.t)
      .for('@acme/cache')
      .secret({ key: 'remote-a', prompt: 'Token: ' })
    expect(value).toBe('kc')
    expect(calls).toEqual(['get @acme/cache remote-a'])
    expect(term.asked).toEqual([])
  })

  it('reads no environment', async () => {
    process.env['VX_TEST_SECRET_KEY'] = 'from-env'
    try {
      expect(
        await reason(
          broker(store().s, terminal('').t).for('p').secret({ key: 'VX_TEST_SECRET_KEY' }),
        ),
      ).toBe('not-found')
    } finally {
      delete process.env['VX_TEST_SECRET_KEY']
    }
  })

  it('missing with a prompt: asked, saved, resolved', async () => {
    const { s, entries } = store()
    const term = terminal('  typed  ')
    expect(await broker(s, term.t).for('p').secret({ key: 'k', prompt: 'Token: ' })).toBe('typed')
    expect(term.asked).toEqual(['Token: '])
    expect(entries.get('p k')).toBe('typed')
  })

  it('missing with no prompt: not-found, nobody asked', async () => {
    const term = terminal('typed')
    expect(await reason(broker(store().s, term.t).for('p').secret({ key: 'k' }))).toBe('not-found')
    expect(term.asked).toEqual([])
  })

  it('an empty answer is declined, and nothing is saved', async () => {
    const { s, calls } = store()
    expect(
      await reason(broker(s, terminal('  ').t).for('p').secret({ key: 'k', prompt: '?' })),
    ).toBe('declined')
    expect(calls).toEqual(['get p k'])
  })

  it('entries are namespaced by plugin', async () => {
    const { s } = store({ 'a k': 'for-a' })
    const b = broker(s, terminal('').t)
    expect(await b.for('a').secret({ key: 'k' })).toBe('for-a')
    expect(await reason(b.for('b').secret({ key: 'k' }))).toBe('not-found')
  })

  it('once per run per key: concurrent asks share one answer; forgetSecret deletes and asks again', async () => {
    const { s, calls, entries } = store()
    const term = terminal('typed')
    const p = broker(s, term.t).for('p')
    const [x, y] = await Promise.all([
      p.secret({ key: 'k', prompt: '?' }),
      p.secret({ key: 'k', prompt: '?' }),
    ])
    expect([x, y, term.asked.length]).toEqual(['typed', 'typed', 1])
    await p.forgetSecret({ key: 'k' })
    expect(entries.has('p k')).toBe(false)
    await p.secret({ key: 'k', prompt: '?' })
    expect(term.asked.length).toBe(2)
    expect(calls.filter((c) => c.startsWith('get'))).toHaveLength(2)
  })

  it('forgetSecret never throws, keychain or not', async () => {
    await broker(store({}, true).s, terminal('').t).for('p').forgetSecret({ key: 'k' })
  })

  describe('a prompt is asked only where someone can answer', () => {
    it('not on CI', async () => {
      const term = terminal('typed')
      expect(
        await reason(broker(store().s, term.t, true).for('p').secret({ key: 'k', prompt: '?' })),
      ).toBe('no-terminal')
      expect(term.asked).toEqual([])
    })

    const fakeIn = (isTTY: boolean) =>
      Object.assign(new EventEmitter(), {
        isTTY,
        setRawMode: () => {},
        resume: () => {},
        pause: () => {},
      })
    const fakeErr = (isTTY: boolean) => ({ isTTY, write: () => true })
    for (const [name, stdin, stderr] of [
      ['not with stdin piped', false, true],
      ['not with stderr piped', true, false],
    ] as const) {
      it(name, async () => {
        const t = terminalOf(fakeIn(stdin), fakeErr(stderr))
        expect(await reason(broker(store().s, t).for('p').secret({ key: 'k', prompt: '?' }))).toBe(
          'no-terminal',
        )
      })
    }

    it('not once the status line is up', async () => {
      const term = terminal('typed')
      const b = broker(store().s, term.t)
      b.closePrompts()
      expect(await reason(b.for('p').secret({ key: 'k', prompt: '?' }))).toBe('no-terminal')
      expect(term.asked).toEqual([])
    })
  })

  it('two plugins’ prompts never overlap', async () => {
    const order: string[] = []
    let release!: () => void
    const first = new Promise<string>((r) => {
      release = () => r('one')
    })
    let n = 0
    const t: SecretTerminal = {
      interactive: () => true,
      ask: async (q) => {
        order.push(`ask ${q}`)
        const answer = n++ === 0 ? await first : 'two'
        order.push(`done ${q}`)
        return answer
      },
    }
    const b = broker(store().s, t)
    const a = b.for('a').secret({ key: 'k', prompt: 'A' })
    const c = b.for('c').secret({ key: 'k', prompt: 'C' })
    await Bun.sleep(5)
    expect(order).toEqual(['ask A'])
    release()
    expect([await a, await c]).toEqual(['one', 'two'])
    expect(order).toEqual(['ask A', 'done A', 'ask C', 'done C'])
  })

  it('no keychain: store-unavailable without a prompt; with one, asked and used for the run', async () => {
    const broken = store({}, true)
    const warn: string[] = []
    expect(await reason(broker(broken.s, terminal('').t).for('p').secret({ key: 'k' }))).toBe(
      'store-unavailable',
    )
    expect(
      await broker(broken.s, terminal('typed').t, false, warn).for('p').secret({
        key: 'k',
        prompt: '?',
      }),
    ).toBe('typed')
    expect(warn).toEqual([
      "[vx] could not save 'k' to the OS keychain (libsecret not found); used for this run only",
    ])
  })
})

describe('the hidden prompt', () => {
  const raw = () => {
    const modes: boolean[] = []
    const input = Object.assign(new EventEmitter(), {
      isTTY: true,
      isRaw: false,
      setRawMode: (m: boolean) => modes.push(m),
      resume: () => {},
      pause: () => {},
    })
    const out: string[] = []
    let interrupted = 0
    const t = terminalOf(
      input,
      { isTTY: true, write: (s: string) => out.push(s) },
      () => interrupted++,
    )
    return { input, modes, out, t, interrupts: () => interrupted }
  }

  it('echoes nothing, edits with backspace, and restores the mode', async () => {
    const r = raw()
    const line = r.t.ask('Token: ')
    r.input.emit('data', Buffer.from('sec'))
    r.input.emit('data', '\u007ft\r')
    expect(await line).toBe('set')
    expect(r.out).toEqual(['Token: ', '\n'])
    expect(r.modes).toEqual([true, false])
    expect(r.input.listenerCount('data')).toBe(0)
  })

  it('Ctrl-C answers nothing and raises the interrupt raw mode swallowed', async () => {
    const r = raw()
    const line = r.t.ask('Token: ')
    r.input.emit('data', 'ab\u0003')
    expect(await line).toBe('')
    expect(r.interrupts()).toBe(1)
    expect(r.modes).toEqual([true, false])
  })

  it('is asked only where stdin and stderr are both terminals', () => {
    const sink = { write: () => true }
    const input = (isTTY: boolean) => Object.assign(raw().input, { isTTY })
    expect([
      terminalOf(input(true), { ...sink, isTTY: true }).interactive(),
      terminalOf(input(false), { ...sink, isTTY: true }).interactive(),
      terminalOf(input(true), { ...sink, isTTY: false }).interactive(),
    ]).toEqual([true, false, false])
  })

  it('a terminal that refuses raw mode is no terminal: no question, no crash', async () => {
    const r = raw()
    r.input.setRawMode = () => {
      throw Object.assign(new Error('setRawMode EIO'), { code: 'EIO' })
    }
    const got = await reason(
      broker(store().s, r.t).for('p').secret({ key: 'k', prompt: 'Token: ' }),
    )
    expect([got, r.out]).toEqual(['no-terminal', []])
  })

  it('Ctrl-D answers nothing and interrupts nothing', async () => {
    const r = raw()
    const line = r.t.ask('Token: ')
    r.input.emit('data', 'ab\u0004')
    expect(await line).toBe('')
    expect(r.interrupts()).toBe(0)
  })
})
