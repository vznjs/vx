import { expect, it } from 'bun:test'
import { heldEach } from '../src/remote-probe.js'

it('asks a key at a time, eight at once, and answers in the order asked', async () => {
  let inFlight = 0
  let most = 0
  const hashes = Array.from({ length: 20 }, (_, i) => `h${i}`)
  const held = await heldEach(hashes, async (h) => {
    most = Math.max(most, ++inFlight)
    await Bun.sleep(2)
    inFlight--
    return Number(h.slice(1)) % 3 === 0
  })
  expect({ held, most }).toEqual({
    held: ['h0', 'h3', 'h6', 'h9', 'h12', 'h15', 'h18'],
    most: 8,
  })
})

it('a key that throws fails the whole answer', async () => {
  await expect(
    heldEach(['a', 'b'], async (h) => {
      if (h === 'b') throw new Error('down')
      return true
    }),
  ).rejects.toThrow('down')
})
