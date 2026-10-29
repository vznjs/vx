// The line vx-dte-server prints at start, or when it refuses to start, is painted
// as vx's own status lines are: plain white read as noise in a log beside
// vx's. Piped with no FORCE_COLOR, it is the same words unpainted.
import path from 'node:path'
import { expect, it } from 'bun:test'

const BIN = path.resolve(import.meta.dir, '../src/bun.ts')
const ESC = '\x1b['

async function start(env: Record<string, string>): Promise<string> {
  const proc = Bun.spawn([process.execPath, BIN, '--port', '0', '--no-auth'], {
    env: { ...process.env, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const reader = proc.stdout.getReader()
  let out = ''
  while (!out.includes('\n')) {
    const { value, done } = await reader.read()
    if (done) break
    out += new TextDecoder().decode(value)
  }
  proc.kill()
  await proc.exited
  return out
}

it('the start line is painted, and names the URL', async () => {
  const out = await start({ FORCE_COLOR: '1' })
  expect(out).toContain(ESC)
  expect(Bun.stripANSI(out)).toMatch(
    /^✓ vx-dte-server {2}listening on http:\/\/127\.0\.0\.1:\d+\/?\n$/,
  )
})

it('piped with no FORCE_COLOR, the start line is the same words unpainted', async () => {
  const { FORCE_COLOR: _, ...env } = process.env
  const out = await start({ ...(env as Record<string, string>), NO_COLOR: '1' })
  expect(out).not.toContain(ESC)
  expect(out).toMatch(/^✓ vx-dte-server {2}listening on http:\/\/127\.0\.0\.1:\d+\/?\n$/)
})

it('a refusal to start is painted', () => {
  const r = Bun.spawnSync([process.execPath, BIN, '--port', 'x', '--no-auth'], {
    env: { ...process.env, FORCE_COLOR: '1' },
    stderr: 'pipe',
  })
  expect(r.exitCode).toBe(2)
  const err = r.stderr.toString()
  expect(err).toContain(ESC)
  expect(Bun.stripANSI(err)).toStartWith('✗ vx-dte-server  ')
})
