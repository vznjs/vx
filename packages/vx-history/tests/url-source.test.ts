// A bad VX_HISTORY_URL was refused as "url must be http(s)", naming an
// option the workspace never set. The refusal names where the URL came
// from.
import { expect, it } from 'bun:test'
import { serverUrlOf } from '../src/history-server.js'

it('names VX_HISTORY_URL when the URL came from it', () => {
  expect(() => serverUrlOf(undefined, { VX_HISTORY_URL: 'h.example' })).toThrow(
    'vxHistory(): VX_HISTORY_URL must be http(s), got h.example',
  )
  expect(() => serverUrlOf(undefined, { VX_HISTORY_URL: 'https://h.example/v1' })).toThrow(
    "vxHistory(): VX_HISTORY_URL is the server's base, without /v1: https://h.example",
  )
})

it('names the url option when the URL came from it', () => {
  expect(() => serverUrlOf('h.example', { VX_HISTORY_URL: 'https://e.example' })).toThrow(
    'vxHistory(): url must be http(s), got h.example',
  )
})
