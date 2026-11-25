// The logger's writes wait in turn while stdout's reader is slow
// (src/report/paced.ts). What a wait must not do: replay every status
// redraw it spanned, or leave a prompt's hold for later.
import { expect, it } from 'bun:test'
import { paced } from '../src/report/paced.js'
import type { OutputWriter } from '../src/ui/index.js'
import { noteWrite } from '../src/util/index.js'

/** A writer recording its calls, over a stream that refuses every write until `drain`. */
function stalled() {
  const calls: string[] = []
  let refusing = true
  const drains = new Set<() => void>()
  const stream = {
    once: (e: string, f: () => void) => void (e === 'drain' && drains.add(f)),
    off: (_: string, f: () => void) => void drains.delete(f),
  }
  const raw: OutputWriter = {
    enabled: true,
    write(chunk) {
      calls.push(`write ${chunk.length}`)
      noteWrite(stream, !refusing)
    },
    writeTo: () => calls.push('writeTo'),
    setStatus: (line, o) => calls.push(`status ${line} ${o?.force === true}`),
    setRegion: () => calls.push('region'),
    settle: () => calls.push('settle'),
    clearStatus: () => calls.push('clear'),
    hold() {
      calls.push('hold')
      return () => calls.push('release')
    },
  }
  const pace = paced(raw)
  // Past the queue's allowance: the next job waits for the drain.
  pace.writer.write('x'.repeat(2 * 1024 * 1024))
  return {
    pace,
    calls,
    async drain() {
      // The stall is process-wide (out-pace.ts): the next test's writes would wait on it.
      refusing = false
      for (const f of [...drains]) f()
      drains.clear()
      await pace.drained()
    },
  }
}

it('a wait draws the latest status once, not each one it spanned', async () => {
  const { pace, calls, drain } = stalled()
  pace.writer.setStatus('a')
  pace.writer.write('row\n')
  pace.writer.setStatus('b', { force: true })
  pace.writer.setStatus('c')
  pace.writer.clearStatus()
  pace.writer.setStatus('d')
  expect(calls).toEqual(['write 2097152'])
  await drain()
  expect(calls).toEqual(['write 2097152', 'status c true', 'write 4', 'clear', 'status d false'])
})

it('a hold takes the region down now, ahead of writes still waiting', async () => {
  const { pace, calls, drain } = stalled()
  pace.writer.write('row\n')
  const release = pace.writer.hold()
  expect(calls).toEqual(['write 2097152', 'hold'])
  release()
  expect(calls).toEqual(['write 2097152', 'hold', 'release'])
  await drain()
})
