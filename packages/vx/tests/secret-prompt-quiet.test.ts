// A remote's token prompt is asked before the run starts, but `vx:load`'s
// step already started the live region's ticker: every 100 ms it erased
// the line the prompt sat on (`\x1b[2K\r`), so the question vanished and
// vx looked frozen (M's run, 2026-10-17). The terminal stays quiet from
// the question to its answer, and the region comes back after.

import { expect, it } from 'bun:test'
import { defaultLogger } from '../src/report/logger.js'
import type { StatusStream } from '../src/report/status-line.js'
import { SecretBroker, type SecretStore } from '../src/util/index.js'

function tty(): StatusStream & { text(): string } {
  const chunks: string[] = []
  return {
    isTTY: true,
    columns: 100,
    write(c: string) {
      chunks.push(String(c))
      return true
    },
    text: () => chunks.join(''),
  }
}

const empty: SecretStore = {
  get: async () => null,
  set: async () => undefined,
  delete: async () => false,
}

async function until(drawn: () => boolean): Promise<void> {
  const deadline = performance.now() + 3000
  while (!drawn() && performance.now() < deadline) await Bun.sleep(25)
}

it('nothing is drawn while a secret prompt waits for its answer', async () => {
  const out = tty()
  const log = defaultLogger({ enabled: false }, { mode: 'broad' }, out, { forceFloorMs: 0 })
  log.stepStart?.('vx:load')
  await until(() => /running internal +local +vx:load/.test(out.text()))
  log.stepEnd?.('vx:load', { durationMs: 300, ok: true })
  let during = ''
  const broker = new SecretBroker(
    false,
    () => undefined,
    empty,
    {
      interactive: () => true,
      async ask() {
        const at = out.text().length
        await Bun.sleep(400)
        during = out.text().slice(at)
        return 'tok'
      },
    },
    () => log.holdStatus(),
  )
  log.stepStart?.('vx:open')
  expect(await broker.for('p').secret({ key: 'k', prompt: 'Token: ' })).toBe('tok')
  expect(during).toBe('')
  await until(() => /running internal +local +vx:open/.test(out.text()))
  expect(out.text()).toMatch(/running internal +local +vx:open/)
  log.stepEnd?.('vx:open', { durationMs: 600, ok: true })
  log.runStart?.({ total: 0, concurrency: 1 })
  log.runDone?.()
})

it('CONTROL: without the hold the ticker keeps drawing over the prompt line', async () => {
  const out = tty()
  const log = defaultLogger({ enabled: false }, { mode: 'broad' }, out, { forceFloorMs: 0 })
  log.stepStart?.('vx:load')
  await until(() => /running internal +local +vx:load/.test(out.text()))
  log.stepEnd?.('vx:load', { durationMs: 300, ok: true })
  const at = out.text().length
  await Bun.sleep(400)
  expect(out.text().slice(at)).toContain('\x1b[2K\r')
  log.runStart?.({ total: 0, concurrency: 1 })
  log.runDone?.()
})
