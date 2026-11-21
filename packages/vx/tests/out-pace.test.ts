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

  // Past an EPIPE, Bun refuses every write and raises nothing more.
  for (const event of ['close', 'error', 'finish']) {
    it(`a stream that raised ${event} paces nothing again`, async () => {
      const s = new EventEmitter()
      noteWrite(s, false)
      s.emit(event, event === 'error' ? new Error('EPIPE') : undefined)
      await outputPaced()
      noteWrite(s, false)
      expect(outputPaced()).toBeUndefined()
    })
  }

  it('a stream already failed or destroyed paces nothing', () => {
    noteWrite(Object.assign(new EventEmitter(), { errored: new Error('EPIPE') }), false)
    noteWrite(Object.assign(new EventEmitter(), { destroyed: true }), false)
    expect(outputPaced()).toBeUndefined()
  })

  it('a drained stream paces again', async () => {
    const s = new EventEmitter()
    noteWrite(s, false)
    s.emit('drain')
    await outputPaced()
    noteWrite(s, false)
    expect(outputPaced()).toBeDefined()
    s.emit('drain')
    await outputPaced()
  })

  it('a stream with no events paces nothing', () => {
    noteWrite({}, false)
    expect(outputPaced()).toBeUndefined()
  })
})
