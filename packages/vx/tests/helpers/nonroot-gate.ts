// Six rows across five suites assert what a permission bit does: a cache
// directory this user cannot write into, an input file it cannot read, a
// watched tree it cannot enter. Root bypasses every one of those bits, so
// each row carried `it.skipIf(process.getuid?.() === 0)` and a comment
// saying "CI's runner is not root".
//
// That comment is a CLAIM about the environment, and nothing checked it.
// A container-based runner running as root — the shape this project's own
// cloud container has — makes all six vanish from a green run with no
// signal at all, which is the silent pass `CLAUDE.md` names. Item 481 found
// it from the other side: a mutation that made `assertWritable` a no-op
// survived the whole suite here, and the row that would have caught it was
// skipping.
//
// So CI sets VX_REQUIRE_NONROOT=1 and running as root becomes a hard
// failure naming the reason. A dev box (or a root container) still skips:
// these suites must stay runnable where they cannot be proven, or an
// unrunnable suite gets ignored rather than fixed. Same trade, same
// mechanism, and the same reason as VX_REQUIRE_SANDBOX and
// VX_REQUIRE_REAPI.

/** Same truthiness rule as the sandbox gate — `0`/`false`/empty are off. */
function required(): boolean {
  const v = process.env['VX_REQUIRE_NONROOT']
  return v !== undefined && v !== '' && v !== '0' && v.toLowerCase() !== 'false'
}

/** True when this process is root, so permission bits do not bind. */
export function isRoot(): boolean {
  return process.getuid?.() === 0
}

/**
 * Whether a permission-bit row must be skipped here.
 *
 * Returns `true` to skip when running as root. THROWS when
 * `VX_REQUIRE_NONROOT` is set and we are root — at module scope that fails
 * the whole file with the reason attached, which is the point: these rows
 * cannot vanish quietly on the one machine whose result gates a merge.
 */
export function skipAsRoot(label: string): boolean {
  if (!isRoot()) return false
  if (required()) {
    throw new Error(
      `VX_REQUIRE_NONROOT is set, so this is a failure and not a skip: [${label}] asserts what a ` +
        `permission bit does, and root bypasses every permission bit. Run the suite as a non-root ` +
        `user, or unset VX_REQUIRE_NONROOT to skip these rows.`,
    )
  }
  return true
}
