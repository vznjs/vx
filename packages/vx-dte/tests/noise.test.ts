// `noise.ts` against the official vectors (cacophony's, the set the Noise
// spec's implementations share) for the two patterns a relay session uses:
// both handshake messages, the handshake hash, and the transport after.

import { expect, it } from 'bun:test'
import { type Bytes, fixedKey, Handshake, type Pattern } from '../src/noise.js'
import vectors from './noise-vectors.json'

const hex = (s: string): Bytes => new Uint8Array(Buffer.from(s, 'hex'))
const str = (b: Uint8Array): string => Buffer.from(b).toString('hex')

for (const v of vectors.vectors) {
  it(`${v.protocol_name} matches its test vector`, async () => {
    const pattern = v.protocol_name.split('_')[1] as Pattern
    const side = async (initiator: boolean) => {
      const psks = initiator ? v.init_psks : v.resp_psks
      return Handshake.start({
        pattern,
        initiator,
        prologue: hex(initiator ? v.init_prologue : v.resp_prologue),
        ...(psks === undefined ? {} : { psk: hex(psks[0]!) }),
        ephemeral: await fixedKey(hex(initiator ? v.init_ephemeral : v.resp_ephemeral)),
      })
    }
    const i = await side(true)
    const r = await side(false)
    const [m0, m1, ...rest] = v.messages
    const c0 = await i.write(hex(m0!.payload))
    expect(str(c0)).toBe(m0!.ciphertext)
    expect(str(await r.read(c0))).toBe(m0!.payload)
    const c1 = await r.write(hex(m1!.payload))
    expect(str(c1)).toBe(m1!.ciphertext)
    expect(str(await i.read(c1))).toBe(m1!.payload)
    expect([str(i.hash), str(r.hash)]).toEqual([v.handshake_hash, v.handshake_hash])
    const ic = await i.split()
    const rc = await r.split()
    const n = [0, 0]
    for (const [k, m] of rest.entries()) {
      const fromI = k % 2 === 0
      const seq = n[fromI ? 0 : 1]!++
      const c = await (fromI ? ic : rc).send.encrypt(seq, new Uint8Array(0), hex(m.payload))
      expect(str(c)).toBe(m.ciphertext)
      const p = await (fromI ? rc : ic).receive.decrypt(seq, new Uint8Array(0), c)
      expect(str(p)).toBe(m.payload)
    }
  })
}

it('a responder with another psk cannot read the first message', async () => {
  const psk = (b: number) => new Uint8Array(32).fill(b)
  const prologue = new Uint8Array(0)
  const i = await Handshake.start({ pattern: 'NNpsk0', initiator: true, prologue, psk: psk(1) })
  const r = await Handshake.start({ pattern: 'NNpsk0', initiator: false, prologue, psk: psk(2) })
  await expect(r.read(await i.write(new Uint8Array([1])))).rejects.toThrow()
})
