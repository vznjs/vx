// M, 2026-10-15: uploads still running show as `⇡`, last in the remote
// part, and a run that ends with uploads still flushing keeps its region,
// footer only, until they finish. No new wait: the run's own drain is it.

import { describe, expect, it } from 'bun:test'
import type { TaskNode, TaskOutcome } from '../src/graph/index.js'
import { defaultLogger } from '../src/report/logger.js'
import type { StatusStream } from '../src/report/status-line.js'

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

const ERASE = '\x1b[J'

describe('uploads still running at the end of a run', () => {
  const start = () => {
    const out = tty()
    const log = defaultLogger({ enabled: false }, { mode: 'broad' }, out, {})
    const key = { uploading: 1, failures: [] as string[] }
    const traffic = { inFlight: 1, keys: new Map([['h-a', key]]) }
    log.runStart?.({
      total: 1,
      concurrency: 1,
      context: {
        version: '0.0.0',
        packageCount: 1,
        remoteCacheEnabled: true,
        cache: { local: true, localWrite: true, remote: true, traffic, notDownloaded: () => 0 },
      },
    })
    const a = {
      id: 'p#a',
      deps: [],
      projectName: 'p',
      taskName: 'a',
      requested: true,
      config: { exec: { command: 'true' }, cache: {} },
    } as unknown as TaskNode
    log.taskStart?.(a)
    log.taskComplete(a, {
      node: a,
      status: 'success',
      exitCode: 0,
      durationMs: 5,
      hash: 'h-a',
      saved: true,
    } as TaskOutcome)
    const settle = () => {
      key.uploading = 0
      traffic.inFlight = 0
    }
    return { out, log, settle }
  }

  it('keep the region, footer only, until they settle; the next line clears it', async () => {
    const { out, log, settle } = start()
    log.runEnd?.()
    await Bun.sleep(50)
    const shown = out.text().slice(out.text().lastIndexOf(ERASE))
    expect(shown).toContain('remote 1⇡')
    // The worker rows are gone: the run's work is done.
    expect(shown).not.toContain('p#a')
    settle()
    log.status('footer')
    const after = out.text()
    // Erased before the line, and never drawn again.
    expect(after.endsWith('footer\n')).toBe(true)
    expect(after.slice(0, -'footer\n'.length).endsWith(ERASE)).toBe(true)
  })

  it('CONTROL: with none running the region goes at the end of the run', async () => {
    const { out, log, settle } = start()
    settle()
    log.runEnd?.()
    const before = out.text()
    await Bun.sleep(50)
    expect(out.text()).toBe(before)
    expect(before.endsWith(ERASE)).toBe(true)
  })
})
