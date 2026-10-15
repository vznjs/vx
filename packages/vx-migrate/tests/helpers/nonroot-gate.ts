// A row that asserts what a file owner or permission bit does cannot hold
// as root, which owns and may read everything. Core's gate, as this suite
// may not import core's tests: CI sets VX_REQUIRE_NONROOT, and there root
// is a failure naming the reason, never a silent skip.

/** True to skip as root; throws as root when VX_REQUIRE_NONROOT is set. */
export function skipAsRoot(label: string): boolean {
  if (process.getuid?.() !== 0) return false
  const v = process.env['VX_REQUIRE_NONROOT']
  if (v !== undefined && v !== '' && v !== '0' && v.toLowerCase() !== 'false') {
    throw new Error(
      `VX_REQUIRE_NONROOT is set, so this is a failure and not a skip: [${label}] asserts what a ` +
        'file owner does, and root bypasses it. Run the suite as a non-root user.',
    )
  }
  return true
}
