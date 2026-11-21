// What a write to vx's own stdout returned paces the readers of task output
// (src/util/out-pace.ts): a refused write holds them until the stream
// drains, and a stream that closes or fails never strands them.
import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'bun:test'
import { noteWrite, outputPaced } from '../src/util/out-pace.js'

describe('out-pace', () => {
  it('an accepted write paces nothing', () => {
    noteWrite(new EventEmitter(), true)
    expect(outputPaced()).toBeUndefined()
  })

  for (const event of ['drain', 'close', 'error', 'finish']) {
    it(`a refused write holds readers until ${event}`, async () => {
      const s = new EventEmitter()
      noteWrite(s, false)
      noteWrite(s, false)
      const p = outputPaced()
      expect(p).toBeDefined()
      let released = false
      void p!.then(() => (released = true))
      await Bun.sleep(5)
      expect(released).toBe(false)
      s.emit(event, event === 'error' ? new Error('EPIPE') : undefined)
      await p
      expect(outputPaced()).toBeUndefined()
      // Every listener it added is gone.
      expect(s.eventNames()).toEqual([])
    })
  }

  it('a stream with no events paces nothing', () => {
    noteWrite({}, false)
    expect(outputPaced()).toBeUndefined()
  })
})
