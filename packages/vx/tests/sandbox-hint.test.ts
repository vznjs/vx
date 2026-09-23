// The sandbox-unavailable message tells the user which config field fixes
// it. That field has to be one the loader accepts: the hint once named the
// runtime's own option (`enableWeakerNestedSandbox`), and a user who put it
// in `exec.sandbox` met an unknown-field refusal instead of a fix.

import { describe, expect, it } from 'bun:test'
import { socketPathRefusal, unavailableReason } from '../src/exec/index.js'
import { validateProjectConfig } from '../src/workspace/index.js'

type Config = Parameters<typeof validateProjectConfig>[0]

// Built as `unknown`: this is the boundary the loader validates, and the
// point is what IT accepts, not what TypeScript does.
const withSandbox = (sandbox: Record<string, unknown>): Config =>
  ({ tasks: { t: { exec: { command: 'true', sandbox } } } }) as unknown as Config

describe('the sandbox-unavailable hint names a field the loader accepts', () => {
  const nested = unavailableReason(
    1,
    'apply-seccomp: write /proc/self/uid_map: Operation not permitted',
  )

  it('names the nested-namespace remedy as a config field', () => {
    expect(nested).toContain('sandbox.weakerWhenNested: true')
    expect(nested).not.toContain('enableWeakerNestedSandbox')
  })

  it('every `sandbox.<field>` the hint names validates on a task', () => {
    const named = [...nested.matchAll(/`sandbox\.([A-Za-z]+): true`/g)].map((m) => m[1]!)
    expect(named.length).toBeGreaterThan(0)
    for (const field of named) {
      expect(() => validateProjectConfig(withSandbox({ [field]: true }), 'hint')).not.toThrow()
    }
    // Control: the runtime option's own name is exactly what the loader refuses.
    expect(() =>
      validateProjectConfig(withSandbox({ enableWeakerNestedSandbox: true }), 'hint'),
    ).toThrow(/unknown field "enableWeakerNestedSandbox"/)
  })

  it('a failure that is not the nested namespace carries no remedy', () => {
    const other = unavailableReason(127, 'bwrap: No such file or directory')
    expect(other).toBe('a sandboxed `true` failed (exit 127): bwrap: No such file or directory')
  })

  // Item 652: every stderr above is short, so the cap could go with the
  // suite green — and a helper that dumps a page of diagnostics would put
  // all of it into a one-line verdict.
  it("carries the first 200 characters of the runtime's stderr, no more", () => {
    expect(unavailableReason(1, 'x'.repeat(300))).toBe(
      `a sandboxed \`true\` failed (exit 1): ${'x'.repeat(200)}`,
    )
  })
})

// Item 652: the socket-length refusal was driven only well past the limit,
// so `<=` could become `<` — refusing a temp directory whose socket path
// fits exactly — with the suite green. The limit is the OS's `sun_path`
// less its NUL; the row sits on it and one byte past.
describe('the socket-length refusal sits exactly on the limit', () => {
  const limit = process.platform === 'darwin' ? 103 : 107
  const dirOf = (length: number): string => {
    const tail = `/srt-mux-${process.pid}-zzz.sock`
    return '/' + 'd'.repeat(length - tail.length - 1)
  }
  it('a socket path of exactly the limit is accepted; one byte more is refused', () => {
    expect(socketPathRefusal(dirOf(limit))).toBeUndefined()
    expect(socketPathRefusal(dirOf(limit + 1))).toContain(
      `is ${limit + 1} bytes where the OS allows ${limit}`,
    )
  })
})
