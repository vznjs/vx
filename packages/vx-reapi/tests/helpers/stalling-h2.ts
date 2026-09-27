// A gRPC peer that STOPS GRANTING FLOW-CONTROL WINDOW: it speaks just enough
// HTTP/2 to accept a call (the SETTINGS exchange) and never sends a
// WINDOW_UPDATE, so a client-streaming write blocks once it has sent the
// 65 535-byte initial window — mid-write, the shape of the Bun chunk stall.
// Then, `rstAfterMs` after a stream's HEADERS arrive, it ends that stream
// with RST_STREAM(CANCEL), as grpc-go's server does when the call's
// `grpc-timeout` runs out (`internal/transport/http2_server.go`: a timer
// armed at the header's timeout, `closeStream(s, true, http2.ErrCodeCancel,
// false)`). grpc-js reports that RST as `CANCELLED: Call cancelled`. An
// optional third argument names another RST code: 2 (INTERNAL_ERROR) is how
// a proxy cuts a call whose backend went away, which grpc-js reports as
// `INTERNAL: Received RST_STREAM with code 2`.
//
// A SEPARATE PROCESS on purpose: a row blocks its own event loop across the
// client's deadline so the server's RST is the first word, and an in-process
// server could not send it while the loop is blocked. After each RST it
// appends a byte to `marker`, so the blocked row can wait for the RST itself
// rather than for a guess at how long a loaded box takes to send it. Each
// call's HEADERS also appends a byte to `<marker>.calls` as it arrives, so a
// count of attempts never races the RST it precedes.
//
//   bun stalling-h2.ts <rstAfterMs> <marker> [rstCode=8]   → prints the port, serves until killed

import { appendFileSync } from 'node:fs'

const rstAfterMs = Number(process.argv[2])
const marker = process.argv[3]!
const PREFACE = 24
const frame = (type: number, flags: number, stream: number, payload = new Uint8Array(0)) => {
  const out = new Uint8Array(9 + payload.length)
  const v = new DataView(out.buffer)
  v.setUint32(0, (payload.length << 8) | type)
  out[4] = flags
  v.setUint32(5, stream & 0x7fffffff)
  out.set(payload, 9)
  return out
}
const rstCode = new Uint8Array([0, 0, 0, Number(process.argv[4] ?? 8)])

const server = Bun.listen<{ buf: Uint8Array; seenPreface: boolean }>({
  hostname: '127.0.0.1',
  port: 0,
  socket: {
    open(s) {
      s.data = { buf: new Uint8Array(0), seenPreface: false }
      s.write(frame(4, 0, 0)) // our SETTINGS: none, so every window stays 65 535
    },
    data(s, chunk) {
      const merged = new Uint8Array(s.data.buf.length + chunk.length)
      merged.set(s.data.buf)
      merged.set(chunk, s.data.buf.length)
      let at = 0
      if (!s.data.seenPreface) {
        if (merged.length < PREFACE) return void (s.data.buf = merged)
        at = PREFACE
        s.data.seenPreface = true
      }
      while (merged.length - at >= 9) {
        const v = new DataView(merged.buffer, merged.byteOffset + at)
        const len = v.getUint32(0) >>> 8
        if (merged.length - at < 9 + len) break
        const type = merged[at + 3]!
        const flags = merged[at + 4]!
        const stream = v.getUint32(5) & 0x7fffffff
        if (type === 4 && (flags & 1) === 0) s.write(frame(4, 1, 0)) // ack their SETTINGS
        if (type === 6 && (flags & 1) === 0) {
          s.write(frame(6, 1, 0, merged.slice(at + 9, at + 9 + len))) // PING ack
        }
        if (type === 1) {
          // Counted on arrival, before the RST is even scheduled: a count
          // taken after the RST was read by a client that saw the RST first
          // and asked before it landed (`sent: 0`, F-9).
          appendFileSync(`${marker}.calls`, 'x')
          setTimeout(() => {
            s.write(frame(3, 0, stream, rstCode))
            appendFileSync(marker, 'x')
          }, rstAfterMs)
        }
        at += 9 + len
      }
      s.data.buf = merged.slice(at)
    },
  },
})
process.stdout.write(`${server.port}\n`)
