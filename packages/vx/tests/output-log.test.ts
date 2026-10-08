// The stored output log (`orchestrator/output-log.ts`): both streams in
// order in one string, and a task's own RS byte left as it wrote it.

import { describe, expect, it } from 'bun:test'
import { BoundedCapture, CAPTURE_HEAD_CHARS, droppedOutputLine } from '../src/exec/runner.js'
import { decodeOutputLog, encodeOutputLog } from '../src/orchestrator/output-log.js'

const out = (text: string) => ({ text, err: false })
const err = (text: string) => ({ text, err: true })

describe('the output log', () => {
  it('is stdout alone as its own text', () => {
    expect(encodeOutputLog([out('a\n'), out('b\n')])).toBe('a\nb\n')
    expect(decodeOutputLog('a\nb\n')).toEqual([out('a\nb\n')])
    expect(decodeOutputLog('')).toEqual([])
  })

  it('marks each switch, and decodes to the same order', () => {
    const chunks = [out('one\n'), err('two\n'), err('2b\n'), out('three\n'), err('four')]
    const log = encodeOutputLog(chunks)
    expect(log).toBe('one\n\x1eetwo\n2b\n\x1eothree\n\x1eefour')
    expect(decodeOutputLog(log)).toEqual([
      out('one\n'),
      err('two\n2b\n'),
      out('three\n'),
      err('four'),
    ])
    // Leading stderr opens with its mark.
    expect(decodeOutputLog(encodeOutputLog([err('x')]))).toEqual([err('x')])
  })

  it("keeps the task's own RS, even before e or o", () => {
    const chunks = [out('a\x1ee\x1e'), err('\x1eo'), out('\x1e')]
    expect(decodeOutputLog(encodeOutputLog(chunks))).toEqual(chunks)
  })
})

describe('BoundedCapture over both streams', () => {
  it('keeps arrival order and the stream of a chunk the head bound split', () => {
    const c = new BoundedCapture()
    c.push('a'.repeat(CAPTURE_HEAD_CHARS - 1))
    c.push('xy', true)
    expect(c.chunks()).toEqual([out('a'.repeat(CAPTURE_HEAD_CHARS - 1)), err('x'), err('y')])
  })

  it('names the dropped middle on stdout, between head and tail', () => {
    const c = new BoundedCapture()
    c.push('h'.repeat(CAPTURE_HEAD_CHARS))
    c.push('m'.repeat(10 * 1024 * 1024), true)
    const got = c.chunks()
    expect(got[0]).toEqual(out('h'.repeat(CAPTURE_HEAD_CHARS)))
    expect(got[1]).toEqual(out(droppedOutputLine(2 * 1024 * 1024)))
    expect(got[2]!.err).toBe(true)
    expect(got[2]!.text.length).toBe(8 * 1024 * 1024)
  })
})
